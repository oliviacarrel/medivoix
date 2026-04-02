import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { OpenAI } from 'openai';
import { createReadStream, unlinkSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import PDFDocument from 'pdfkit';
import nodemailer from 'nodemailer';
import { restoreFromS3, scheduleBackup, backupToS3 } from './backup.mjs';
import db from './db.js';
import { encrypt, decrypt } from './crypto-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ dest: 'uploads/' });
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET est obligatoire en production. Ajoutez-le dans les variables d\'environnement Render.');
    process.exit(1);
  }
  console.warn('⚠️  JWT_SECRET non défini — clé de dev utilisée. NE PAS déployer ainsi en production.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'medivox-dev-only-local';

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

if (!existsSync('uploads')) mkdirSync('uploads');

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ─── Mailer ───────────────────────────────────────────────────────────────────
const mailer = process.env.SMTP_HOST
  ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) || 587, secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } })
  : null;

// ─── Auth middleware ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Non authentifié' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token invalide ou expiré' }); }
}

// ─── Audit helper ─────────────────────────────────────────────────────────────
function audit(req, action, entityType, entityId, details = '') {
  try {
    db.prepare(`INSERT INTO audit_logs (id,userId,userEmail,action,entityType,entityId,details,ip)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), req.user?.id, req.user?.email, action, entityType, entityId,
        details.slice(0, 500), req.ip);
  } catch {}
}

// ─── Data helpers ─────────────────────────────────────────────────────────────
function parseNote(row) { try { return row?.noteJson ? JSON.parse(decrypt(row.noteJson)) : null; } catch { return null; } }
function parseLignes(row) { try { return row?.lignes ? JSON.parse(row.lignes) : []; } catch { return []; } }
function serializeConsultation(c) {
  return { ...c, transcription: decrypt(c.transcription), note: parseNote(c), noteJson: undefined };
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  const payload = { id: user.id, email: user.email, nom: user.nom, prenom: user.prenom, rpps: user.rpps, specialite: user.specialite };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
  db.prepare(`INSERT INTO audit_logs (id,userId,userEmail,action,ip) VALUES (?,?,?,?,?)`)
    .run(randomUUID(), user.id, user.email, 'LOGIN', req.ip);
  res.json({ token, user: payload });
});

app.post('/api/auth/register', async (req, res) => {
  const { email, password, nom, prenom, rpps, specialite } = req.body;
  if (!email || !password || !nom || !prenom) return res.status(400).json({ error: 'Champs obligatoires manquants' });
  if (password.length < 8) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères' });
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'Cet email est déjà utilisé' });
  const id = randomUUID();
  const hash = await bcrypt.hash(password, 10);
  db.prepare(`INSERT INTO users (id,email,password,nom,prenom,rpps,specialite) VALUES (?,?,?,?,?,?,?)`)
    .run(id, email.toLowerCase().trim(), hash, nom.trim(), prenom.trim(), rpps||null, specialite||null);
  const payload = { id, email: email.toLowerCase().trim(), nom: nom.trim(), prenom: prenom.trim(), rpps: rpps||null, specialite: specialite||null };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
  db.prepare(`INSERT INTO audit_logs (id,userId,userEmail,action,ip) VALUES (?,?,?,?,?)`)
    .run(randomUUID(), id, email, 'REGISTER', req.ip);
  res.json({ token, user: payload });
});

app.get('/api/auth/me', auth, (req, res) => {
  const u = db.prepare('SELECT id,email,nom,prenom,rpps,specialite,telephone,adresse,photo FROM users WHERE id=?').get(req.user.id);
  res.json(u);
});

app.put('/api/auth/profile', auth, (req, res) => {
  const { nom, prenom, rpps, specialite, telephone, adresse, photo } = req.body;
  db.prepare(`UPDATE users SET nom=?,prenom=?,rpps=?,specialite=?,telephone=?,adresse=?,photo=? WHERE id=?`)
    .run(nom, prenom, rpps, specialite, telephone, adresse, photo||null, req.user.id);
  audit(req, 'UPDATE_PROFILE', 'user', req.user.id);
  res.json(db.prepare('SELECT id,email,nom,prenom,rpps,specialite,telephone,adresse,photo FROM users WHERE id=?').get(req.user.id));
});

app.put('/api/auth/password', auth, async (req, res) => {
  const { current, next: newPwd } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(current, user.password)) return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
  if (!newPwd || newPwd.length < 8) return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 8 caractères' });
  db.prepare("UPDATE users SET password=? WHERE id=?").run(bcrypt.hashSync(newPwd, 10), req.user.id);
  audit(req, 'CHANGE_PASSWORD', 'user', req.user.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/dashboard', auth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7*24*3600*1000).toISOString().slice(0, 10);

  const totalPatients   = db.prepare("SELECT COUNT(DISTINCT patientId) as n FROM consultations WHERE userId=?").get(req.user.id).n;
  const consultToday    = db.prepare("SELECT COUNT(*) as n FROM consultations WHERE date LIKE ? AND userId=?").get(today+'%', req.user.id).n;
  const consultWeek     = db.prepare("SELECT COUNT(*) as n FROM consultations WHERE date >= ? AND userId=?").get(weekAgo, req.user.id).n;
  const notesValidated  = db.prepare("SELECT COUNT(*) as n FROM consultations WHERE statut='validee' AND userId=?").get(req.user.id).n;

  const recentConsultations = db.prepare(`
    SELECT c.id, c.patientId, c.motif, c.date, c.statut, p.nom, p.prenom, p.sexe
    FROM consultations c JOIN patients p ON c.patientId=p.id
    WHERE c.userId=? ORDER BY c.date DESC LIMIT 8
  `).all(req.user.id);

  const recentPatients = db.prepare(`
    SELECT p.id, p.nom, p.prenom, p.sexe, p.dateNaissance,
      (SELECT MAX(c.date) FROM consultations c WHERE c.patientId=p.id) as lastConsult
    FROM patients p ORDER BY lastConsult DESC NULLS LAST, p.createdAt DESC LIMIT 5
  `).all();

  const last7days = db.prepare("SELECT strftime('%Y-%m-%d',date) as d, COUNT(*) as n FROM consultations WHERE date >= date('now','-6 days') AND userId=? GROUP BY d ORDER BY d").all(req.user.id);
  const topMotifsWeek = db.prepare("SELECT motif, COUNT(*) as n FROM consultations WHERE date >= date('now','-7 days') AND userId=? GROUP BY motif ORDER BY n DESC LIMIT 3").all(req.user.id);
  const pendingNotes = db.prepare("SELECT COUNT(*) as n FROM consultations WHERE statut IN ('en_cours','note_generee') AND userId=?").get(req.user.id).n;

  res.json({ totalPatients, consultToday, consultWeek, notesValidated, recentConsultations, recentPatients, last7days, topMotifsWeek, pendingNotes, aiEnabled: !!openai });
});

// ─── AGENDA ──────────────────────────────────────────────────────────────────

app.get('/api/agenda', auth, (req, res) => {
  const { from, to } = req.query;
  let query = `SELECT a.*, p.nom, p.prenom, p.sexe FROM appointments a JOIN patients p ON a.patientId=p.id WHERE a.userId=?`;
  const args = [req.user.id];
  if (from) { query += ' AND a.date >= ?'; args.push(from); }
  if (to)   { query += ' AND a.date <= ?'; args.push(to); }
  query += ' ORDER BY a.date ASC, a.heure ASC';
  res.json(db.prepare(query).all(...args));
});

app.post('/api/agenda', auth, (req, res) => {
  const { patientId, date, heure, motif, notes, salle, site, priorite } = req.body;
  if (!patientId || !date) return res.status(400).json({ error: 'patientId et date requis' });
  const id = randomUUID();
  db.prepare(`INSERT INTO appointments (id,patientId,userId,date,heure,motif,notes,salle,site,priorite) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, patientId, req.user.id, date, heure||'09:00', motif||'', notes||'', salle||null, site||'Principal', priorite||'P3');
  audit(req, 'CREATE_APPOINTMENT', 'appointment', id, `${date} ${heure}`);
  res.json(db.prepare('SELECT a.*, p.nom, p.prenom FROM appointments a JOIN patients p ON a.patientId=p.id WHERE a.id=?').get(id));
});

app.put('/api/agenda/:id', auth, (req, res) => {
  const { date, heure, motif, notes, statut, salle, site, priorite } = req.body;
  db.prepare(`UPDATE appointments SET date=?,heure=?,motif=?,notes=?,statut=?,salle=?,site=?,priorite=? WHERE id=? AND userId=?`)
    .run(date, heure, motif||'', notes||'', statut||'planifie', salle||null, site||'Principal', priorite||'P3', req.params.id, req.user.id);
  audit(req, 'UPDATE_APPOINTMENT', 'appointment', req.params.id);
  res.json(db.prepare('SELECT a.*, p.nom, p.prenom FROM appointments a JOIN patients p ON a.patientId=p.id WHERE a.id=?').get(req.params.id));
});

app.delete('/api/agenda/:id', auth, (req, res) => {
  db.prepare('DELETE FROM appointments WHERE id=? AND userId=?').run(req.params.id, req.user.id);
  audit(req, 'DELETE_APPOINTMENT', 'appointment', req.params.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/search', auth, (req, res) => {
  const q = '%' + (req.query.q || '') + '%';
  const patients = db.prepare(`
    SELECT id, nom, prenom, dateNaissance, sexe FROM patients
    WHERE nom LIKE ? OR prenom LIKE ? OR (nom||' '||prenom) LIKE ? OR (prenom||' '||nom) LIKE ?
    LIMIT 10
  `).all(q, q, q, q);
  const consultations = db.prepare(`
    SELECT c.id, c.motif, c.date, c.statut, p.nom, p.prenom
    FROM consultations c JOIN patients p ON c.patientId=p.id
    WHERE c.motif LIKE ? AND c.userId=?
    ORDER BY c.date DESC LIMIT 10
  `).all(q, req.user.id);
  res.json({ patients, consultations });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATIENTS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/patients', auth, (req, res) => {
  const { q, limit } = req.query;
  const user = db.prepare("SELECT siteId FROM users WHERE id=?").get(req.user.id);
  // Multi-site: if user assigned to a site, filter patients seen at that site
  // Otherwise show all patients this doctor has ever seen (or all if no consultation exists yet)
  let query, params;
  if (q) {
    query = "SELECT DISTINCT p.id,p.nom,p.prenom,p.dateNaissance,p.sexe,p.telephone FROM patients p WHERE (p.nom LIKE ? OR p.prenom LIKE ? OR p.telephone LIKE ?) ORDER BY p.nom LIMIT ?";
    params = [`%${q}%`,`%${q}%`,`%${q}%`, parseInt(limit)||50];
  } else if (user?.siteId) {
    query = "SELECT DISTINCT p.id,p.nom,p.prenom,p.dateNaissance,p.sexe,p.telephone FROM patients p JOIN consultations c ON c.patientId=p.id WHERE c.userId=? ORDER BY p.nom LIMIT ?";
    params = [req.user.id, parseInt(limit)||200];
  } else {
    query = "SELECT id,nom,prenom,dateNaissance,sexe,telephone FROM patients ORDER BY nom LIMIT ?";
    params = [parseInt(limit)||200];
  }
  res.json(db.prepare(query).all(...params));
});

app.get('/api/patients/:id', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM patients WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Patient non trouvé' });
  const consultations = db.prepare(`
    SELECT c.id, c.motif, c.date, c.statut, c.userId,
      u.nom as docteurNom, u.prenom as docteurPrenom, u.specialite as docteurSpec
    FROM consultations c
    LEFT JOIN users u ON u.id = c.userId
    WHERE c.patientId = ?
    ORDER BY c.date DESC
  `).all(p.id);
  res.json({ ...p, consultations });
});

app.post('/api/patients', auth, (req, res) => {
  const { nom, prenom, dateNaissance, sexe, telephone, telephone2, email, adresse, typeAssurance, numAssurance, antecedents, allergies, traitements, antecedents_familiaux, antecedents_chirurgicaux, vaccinations, facteurs_risque, intolerances, groupe_sanguin, employeur, ayant_droit, medecin_referent } = req.body;
  const id = randomUUID();
  db.prepare(`INSERT INTO patients (id,nom,prenom,dateNaissance,sexe,telephone,telephone2,email,adresse,typeAssurance,numAssurance,antecedents,allergies,traitements,antecedents_familiaux,antecedents_chirurgicaux,vaccinations,facteurs_risque,intolerances,groupe_sanguin,employeur,ayant_droit,medecin_referent)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, nom, prenom, dateNaissance, sexe||'M', telephone, telephone2, email, adresse, typeAssurance, numAssurance, antecedents, allergies, traitements, antecedents_familiaux||'', antecedents_chirurgicaux||'', vaccinations||'', facteurs_risque||'', intolerances||'', groupe_sanguin||'', employeur||'', ayant_droit||'', medecin_referent||'');
  audit(req, 'CREATE_PATIENT', 'patient', id, `${prenom} ${nom}`);
  res.json(db.prepare('SELECT * FROM patients WHERE id=?').get(id));
});

app.put('/api/patients/:id', auth, (req, res) => {
  const { nom, prenom, dateNaissance, sexe, telephone, telephone2, email, adresse, typeAssurance, numAssurance, antecedents, allergies, traitements, antecedents_familiaux, antecedents_chirurgicaux, vaccinations, facteurs_risque, intolerances, groupe_sanguin, employeur, ayant_droit, medecin_referent } = req.body;
  const info = db.prepare(`UPDATE patients SET nom=?,prenom=?,dateNaissance=?,sexe=?,telephone=?,telephone2=?,email=?,
    adresse=?,typeAssurance=?,numAssurance=?,antecedents=?,allergies=?,traitements=?,
    antecedents_familiaux=?,antecedents_chirurgicaux=?,vaccinations=?,facteurs_risque=?,intolerances=?,
    groupe_sanguin=?,employeur=?,ayant_droit=?,medecin_referent=?,
    updatedAt=datetime('now') WHERE id=?`)
    .run(nom, prenom, dateNaissance, sexe, telephone, telephone2, email, adresse, typeAssurance, numAssurance, antecedents, allergies, traitements, antecedents_familiaux||'', antecedents_chirurgicaux||'', vaccinations||'', facteurs_risque||'', intolerances||'', groupe_sanguin||'', employeur||'', ayant_droit||'', medecin_referent||'', req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Patient non trouvé' });
  audit(req, 'UPDATE_PATIENT', 'patient', req.params.id, `${prenom} ${nom}`);
  res.json(db.prepare('SELECT * FROM patients WHERE id=?').get(req.params.id));
});

// ── Tous les patients (registre CDL) ──────────────────────────────────────────
app.get('/api/all-patients', auth, (req, res) => {
  const { q, assurance, page, limit } = req.query;
  const lim = Math.min(parseInt(limit) || 50, 200);
  const offset = (parseInt(page) || 0) * lim;

  const conditions = [];
  const params = [];

  if (q && q.trim()) {
    conditions.push('(p.nom LIKE ? OR p.prenom LIKE ? OR p.telephone LIKE ? OR p.code_patient LIKE ?)');
    const qp = `%${q.trim()}%`;
    params.push(qp, qp, qp, qp);
  }
  if (assurance && assurance !== 'all') {
    conditions.push('p.assurance = ?');
    params.push(assurance);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) as n FROM patients p ${where}`).get(...params).n;
  const rows  = db.prepare(`
    SELECT p.id, p.code_patient, p.nom, p.prenom, p.dateNaissance, p.sexe,
           p.telephone, p.adresse, p.numAssurance, p.situation,
           p.assurance, p.convention, p.typeAssurance
    FROM patients p ${where}
    ORDER BY p.nom, p.prenom
    LIMIT ? OFFSET ?
  `).all(...params, lim, offset);

  const assurances = db.prepare(
    "SELECT DISTINCT assurance FROM patients WHERE assurance IS NOT NULL AND assurance NOT IN ('Aucune','') ORDER BY assurance"
  ).all().map(r => r.assurance);

  res.json({ rows, total, page: parseInt(page) || 0, limit: lim, assurances });
});

app.get('/api/patients/:id/prescriptions', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.lignes, p.validee, p.createdAt, c.motif, c.date, c.id as consultationId
    FROM prescriptions p
    JOIN consultations c ON c.id = p.consultationId
    WHERE c.patientId = ?
    ORDER BY c.date DESC
    LIMIT 10
  `).all(req.params.id);
  res.json(rows.map(r => ({ ...r, lignes: (() => { try { return JSON.parse(r.lignes); } catch { return []; } })() })));
});

// ─── Patient 360 ──────────────────────────────────────────────────────────────
app.get('/api/patients/:id/360', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM patients WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Patient non trouvé' });

  // Dernières constantes (consultation validée la plus récente avec constantes)
  const lastConstantes = db.prepare(`
    SELECT constantes, date, motif FROM consultations
    WHERE patientId=? AND constantes IS NOT NULL AND constantes != ''
    ORDER BY date DESC LIMIT 1
  `).get(p.id);

  // Timeline consultations (toutes)
  const timeline = db.prepare(`
    SELECT c.id, c.motif, c.date, c.statut, c.constantes, c.resume_patient,
      u.nom as docteurNom, u.prenom as docteurPrenom, u.specialite as docteurSpec
    FROM consultations c LEFT JOIN users u ON u.id = c.userId
    WHERE c.patientId=? ORDER BY c.date DESC LIMIT 30
  `).all(p.id);

  // Dernières ordonnances
  const prescriptions = db.prepare(`
    SELECT p2.id, p2.lignes, p2.validee, p2.createdAt, c.motif, c.date, c.id as consultationId
    FROM prescriptions p2 JOIN consultations c ON c.id = p2.consultationId
    WHERE c.patientId=? AND p2.validee=1
    ORDER BY c.date DESC LIMIT 5
  `).all(p.id).map(r => ({ ...r, lignes: (() => { try { return JSON.parse(r.lignes); } catch { return []; } })() }));

  // Prochains RDV
  const rdv = db.prepare(`
    SELECT a.id, a.date, a.heure, a.motif, a.statut,
      u.nom as docteurNom, u.prenom as docteurPrenom
    FROM appointments a LEFT JOIN users u ON u.id = a.userId
    WHERE a.patientId=? AND a.date >= date('now')
    ORDER BY a.date ASC, a.heure ASC LIMIT 5
  `).all(p.id);

  // Alertes cliniques (allergies vs traitements courants)
  const alertes = [];
  const allergies = (p.allergies || '').toLowerCase();
  const traitements = (p.traitements || '').toLowerCase();
  const intolerances = (p.intolerances || '').toLowerCase();
  if (allergies && traitements) {
    const allergyList = allergies.split(/[,;\n]+/).map(a => a.trim()).filter(Boolean);
    allergyList.forEach(al => {
      if (al && traitements.includes(al.split(' ')[0])) {
        alertes.push({ level: 'danger', msg: `Allergie connue (${al}) détectée dans les traitements en cours` });
      }
    });
  }
  if (intolerances && traitements) {
    const intoleranceList = intolerances.split(/[,;\n]+/).map(a => a.trim()).filter(Boolean);
    intoleranceList.forEach(it => {
      const keyword = it.split(/[\s(]/)[0];
      if (keyword && traitements.includes(keyword.toLowerCase())) {
        alertes.push({ level: 'warning', msg: `Intolérance connue (${it}) — à surveiller dans les prescriptions` });
      }
    });
  }

  res.json({
    patient: p,
    lastConstantes: lastConstantes ? { ...lastConstantes, data: (() => { try { return JSON.parse(lastConstantes.constantes); } catch { return {}; } })() } : null,
    timeline,
    prescriptions,
    rdv,
    alertes,
  });
});

// ─── Constantes vitales ───────────────────────────────────────────────────────
app.put('/api/consultations/:id/constantes', auth, (req, res) => {
  const { constantes } = req.body;
  db.prepare("UPDATE consultations SET constantes=?,updatedAt=datetime('now') WHERE id=?")
    .run(JSON.stringify(constantes), req.params.id);
  res.json({ ok: true });
});

// ─── Résumé patient ───────────────────────────────────────────────────────────
app.post('/api/consultations/:id/resume-patient', auth, async (req, res) => {
  const c = db.prepare('SELECT * FROM consultations WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Non trouvée' });
  const note = parseNote(c);
  if (!note) return res.status(400).json({ error: 'Note non disponible' });

  let resume;
  if (!openai) {
    resume = `Vous avez consulté pour : ${note.motif || 'non précisé'}.\n\nCe que nous avons constaté : ${note.examen || 'examen réalisé'}.\n\nDiagnostic : ${note.hypotheses || 'à confirmer'}.\n\nVotre traitement : ${note.prescriptions || 'voir ordonnance'}.\n\nConseils importants : ${note.conseils_patient || 'suivre les recommandations du médecin'}.\n\nSigles d'alarme — consultez immédiatement si : ${note.drapeaux_rouges || 'vous vous sentez très mal ou que vos symptômes s\'aggravent rapidement'}.`;
  } else {
    try {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: `Transforme cette note médicale en un résumé SIMPLE et BIENVEILLANT pour le patient (niveau lycée, sans jargon médical, en français, 150-200 mots). Utilise "vous". Structure: motif → constat → diagnostic → traitement → conseils → signes d'alarme.\n\nNote médicale:\n${JSON.stringify(note)}` }]
      });
      resume = r.choices[0].message.content;
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  db.prepare("UPDATE consultations SET resume_patient=?,updatedAt=datetime('now') WHERE id=?").run(resume, c.id);
  res.json({ resume });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONSULTATIONS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/consultations', auth, (req, res) => {
  const { patientId, motif, specialite, type_consult } = req.body;
  const id = randomUUID();
  db.prepare('INSERT INTO consultations (id,patientId,userId,motif,specialite,type_consult) VALUES (?,?,?,?,?,?)')
    .run(id, patientId, req.user.id, motif, specialite||'Médecine générale', type_consult||'cabinet');
  audit(req, 'CREATE_CONSULTATION', 'consultation', id, motif);
  res.json({ ...db.prepare('SELECT * FROM consultations WHERE id=?').get(id), note: null });
});

app.get('/api/consultations/:id', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM consultations WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Consultation non trouvée' });
  res.json(serializeConsultation(c));
});

app.post('/api/consultations/:id/transcribe', auth, upload.single('audio'), async (req, res) => {
  const c = db.prepare('SELECT * FROM consultations WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Consultation non trouvée' });

  let newText;
  if (!openai) {
    newText = "Patiente de 43 ans consulte pour des céphalées évoluant depuis 3 jours. Pas de fièvre, pas de nausées. La douleur est pulsatile, surtout le matin. Tension artérielle élevée à 160/95 mmHg. Pas de traitement antihypertenseur en cours. Antécédent de migraines il y a 5 ans.";
    if (req.file) unlinkSync(req.file.path);
  } else {
    try {
      const result = await openai.audio.transcriptions.create({ file: createReadStream(req.file.path), model:'whisper-1', language:'fr', prompt:'Consultation médicale en français.' });
      newText = result.text;
      unlinkSync(req.file.path);
    } catch (err) { if (req.file) unlinkSync(req.file.path); return res.status(500).json({ error: err.message }); }
  }

  const existing = decrypt(c.transcription || '');
  const transcription = [existing, newText].filter(Boolean).join('\n');
  db.prepare("UPDATE consultations SET transcription=?,updatedAt=datetime('now') WHERE id=?").run(encrypt(transcription), c.id);
  res.json({ transcription });
});

app.post('/api/consultations/:id/update-transcription', auth, (req, res) => {
  db.prepare("UPDATE consultations SET transcription=?,updatedAt=datetime('now') WHERE id=?")
    .run(encrypt(req.body.transcription), req.params.id);
  res.json({ ok: true });
});

app.post('/api/consultations/:id/generate-note', auth, async (req, res) => {
  const c = db.prepare('SELECT * FROM consultations WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Consultation non trouvée' });
  const p = db.prepare('SELECT * FROM patients WHERE id=?').get(c.patientId);
  const transcription = decrypt(c.transcription || '');

  let note;
  if (!openai) {
    note = { motif:"Céphalées", histoire:"Céphalées pulsatiles depuis 3 jours, prédominance matinale, sans fièvre ni nausées. Antécédent de migraines il y a 5 ans.", examen:"TA : 160/95 mmHg. Pas d'autres anomalies.", hypotheses:"1. Céphalée sur poussée hypertensive\n2. Reprise migraineuse", conduite:"1. Bilan NFS, ionogramme, créatinine\n2. ECG\n3. MAPA\n4. Traitement antihypertenseur à discuter", prescriptions:"Paracétamol 1g si douleur, max 3g/j\nAvis cardiologique", conseils_patient:"Reposez-vous. Mesurez votre tension le matin. Revenez en urgence si douleur aggravée, troubles visuels ou faiblesse.", drapeaux_rouges:"Céphalée en coup de tonnerre, fièvre + raideur nuque, déficit neurologique focal, HTA > 180/110", cim10:{code:"R51",libelle:"Céphalée"} };
  } else {
    const constantes = (() => { try { return c.constantes ? JSON.parse(c.constantes) : null; } catch { return null; } })();
    const constStr = constantes ? `Constantes : TA ${constantes.ta_sys||'?'}/${constantes.ta_dia||'?'} mmHg, FC ${constantes.fc||'?'}/min, SpO2 ${constantes.spo2||'?'}%, T° ${constantes.temp||'?'}°C, Poids ${constantes.poids||'?'} kg, Taille ${constantes.taille||'?'} cm, IMC ${constantes.imc||'?'}, EVA ${constantes.eva||'?'}/10` : '';
    const ctx = p ? `Patient : ${p.prenom} ${p.nom}, né(e) le ${p.dateNaissance}.\nAntécédents : ${p.antecedents||'aucun'}\nAllergies : ${p.allergies||'aucune'}\nTraitements : ${p.traitements||'aucun'}\n${constStr}` : '';
    try {
      const r = await openai.chat.completions.create({ model:'gpt-4o', messages:[{role:'user',content:`Tu es un assistant médical. Génère une note clinique JSON.\n\n${ctx}\n\nTranscription:\n"""\n${transcription}\n"""\n\nRetourne UNIQUEMENT ce JSON (cim10 = code CIM-10 le plus probable + libellé court):\n{"motif":"","histoire":"","examen":"","hypotheses":"","conduite":"","prescriptions":"","conseils_patient":"","drapeaux_rouges":"","cim10":{"code":"","libelle":""}}`}], response_format:{type:'json_object'} });
      note = JSON.parse(r.choices[0].message.content);
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  db.prepare("UPDATE consultations SET noteJson=?,statut='note_generee',updatedAt=datetime('now') WHERE id=?")
    .run(encrypt(JSON.stringify(note)), c.id);
  audit(req, 'GENERATE_NOTE', 'consultation', c.id);
  res.json({ note });
});

app.post('/api/consultations/:id/timing', auth, (req, res) => {
  const { heureDebut, heureFin, dureeMinutes } = req.body;
  db.prepare('UPDATE consultations SET heureDebut=?,heureFin=?,dureeMinutes=?,updatedAt=datetime(\'now\') WHERE id=?')
    .run(heureDebut||null, heureFin||null, dureeMinutes||null, req.params.id);
  res.json({ ok: true });
});

app.post('/api/consultations/:id/validate-note', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM consultations WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Consultation non trouvée' });
  const { note, specialite, specialite_fields } = req.body;
  // Merge note with specialty fields embedded
  const merged = {
    ...(parseNote(c)||{}),
    ...note,
    ...(specialite_fields && Object.keys(specialite_fields).length ? { specialite_fields } : {}),
  };
  const updates = ["noteJson=?", "statut='validee'", "updatedAt=datetime('now')"];
  const params = [encrypt(JSON.stringify(merged))];
  if (specialite) { updates.push("specialite=?"); params.push(specialite); }
  params.push(c.id);
  db.prepare(`UPDATE consultations SET ${updates.join(',')} WHERE id=?`).run(...params);
  audit(req, 'VALIDATE_NOTE', 'consultation', c.id);
  res.json({ ok: true });
});

app.delete('/api/consultations/:id', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM consultations WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Non trouvée' });
  db.prepare('DELETE FROM prescriptions WHERE consultationId=?').run(req.params.id);
  db.prepare('DELETE FROM consultations WHERE id=?').run(req.params.id);
  audit(req, 'DELETE_CONSULTATION', 'consultation', req.params.id);
  res.json({ ok: true });
});

// ─── Email ────────────────────────────────────────────────────────────────────
app.post('/api/consultations/:id/send-email', auth, async (req, res) => {
  if (!mailer) return res.status(503).json({ error: 'Email non configuré (SMTP_HOST manquant dans .env)' });
  const { to, subject } = req.body;
  const c = db.prepare('SELECT * FROM consultations WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Consultation non trouvée' });

  // Generate PDF in memory
  const chunks = [];
  const doc = new PDFDocument({ margin:50, size:'A4' });
  doc.on('data', d => chunks.push(d));
  await new Promise(resolve => { doc.on('end', resolve); buildConsultationPDF(doc, c); });
  const pdfBuffer = Buffer.concat(chunks);

  await mailer.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject: subject || `Compte rendu consultation — ${new Date(c.date).toLocaleDateString('fr-FR')}`,
    text: 'Veuillez trouver ci-joint le compte rendu de consultation.',
    attachments: [{ filename: 'consultation.pdf', content: pdfBuffer }]
  });
  audit(req, 'SEND_EMAIL', 'consultation', c.id, `to: ${to}`);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRESCRIPTIONS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/consultations/:id/prescription', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM prescriptions WHERE consultationId=?').get(req.params.id);
  res.json(row ? { ...row, lignes: parseLignes(row) } : { lignes:[], validee:false });
});

app.put('/api/consultations/:id/prescription', auth, (req, res) => {
  const { lignes, validee } = req.body;
  const data = JSON.stringify(lignes||[]);
  const existing = db.prepare('SELECT id FROM prescriptions WHERE consultationId=?').get(req.params.id);
  if (existing) db.prepare("UPDATE prescriptions SET lignes=?,validee=?,updatedAt=datetime('now') WHERE consultationId=?").run(data, validee?1:0, req.params.id);
  else db.prepare('INSERT INTO prescriptions (id,consultationId,lignes,validee) VALUES (?,?,?,?)').run(randomUUID(), req.params.id, data, validee?1:0);
  audit(req, validee?'VALIDATE_PRESCRIPTION':'SAVE_PRESCRIPTION', 'prescription', req.params.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TTS
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/tts', auth, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'Clé API OpenAI non configurée' });
  try {
    const mp3 = await openai.audio.speech.create({ model:'tts-1', voice:req.body.voice||'nova', input:req.body.text });
    res.set('Content-Type','audio/mpeg');
    res.send(Buffer.from(await mp3.arrayBuffer()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/analytics', auth, (req, res) => {
  const { from, to } = req.query;
  const dateFrom = from || new Date(Date.now() - 30*24*3600*1000).toISOString().slice(0,10);
  const dateTo   = to   || new Date().toISOString().slice(0,10);
  const fromStr  = dateFrom + ' 00:00:00';
  const toStr    = dateTo   + ' 23:59:59';

  const totalConsults  = db.prepare("SELECT COUNT(*) as n FROM consultations WHERE date BETWEEN ? AND ? AND userId=?").get(fromStr, toStr, req.user.id).n;
  const validated      = db.prepare("SELECT COUNT(*) as n FROM consultations WHERE statut='validee' AND date BETWEEN ? AND ? AND userId=?").get(fromStr, toStr, req.user.id).n;
  const withNote       = db.prepare("SELECT COUNT(*) as n FROM consultations WHERE noteJson IS NOT NULL AND date BETWEEN ? AND ? AND userId=?").get(fromStr, toStr, req.user.id).n;
  const avgDuration    = db.prepare("SELECT AVG(dureeMinutes) as v FROM consultations WHERE dureeMinutes IS NOT NULL AND date BETWEEN ? AND ? AND userId=?").get(fromStr, toStr, req.user.id).v;
  const withPrescription = db.prepare("SELECT COUNT(DISTINCT c.id) as n FROM consultations c JOIN prescriptions p ON p.consultationId=c.id WHERE c.date BETWEEN ? AND ? AND c.userId=?").get(fromStr, toStr, req.user.id).n;

  // Patient stats — filtered to this doctor's patients
  const totalPatients  = db.prepare("SELECT COUNT(DISTINCT patientId) as n FROM consultations WHERE userId=?").get(req.user.id).n;
  const femmes         = db.prepare("SELECT COUNT(DISTINCT c.patientId) as n FROM consultations c JOIN patients p ON p.id=c.patientId WHERE c.userId=? AND p.sexe='F'").get(req.user.id).n;
  const hommes         = db.prepare("SELECT COUNT(DISTINCT c.patientId) as n FROM consultations c JOIN patients p ON p.id=c.patientId WHERE c.userId=? AND p.sexe='M'").get(req.user.id).n;
  const avgAge         = db.prepare("SELECT AVG((strftime('%Y','now') - strftime('%Y',p.dateNaissance))) as v FROM consultations c JOIN patients p ON p.id=c.patientId WHERE c.userId=? AND p.dateNaissance IS NOT NULL AND p.dateNaissance != ''").get(req.user.id).v;

  // Top motifs
  const topMotifs = db.prepare("SELECT motif, COUNT(*) as n FROM consultations WHERE date BETWEEN ? AND ? AND userId=? GROUP BY motif ORDER BY n DESC LIMIT 5").all(fromStr, toStr, req.user.id);

  // Consultations by hour
  const byHour = db.prepare("SELECT strftime('%H',date) as h, COUNT(*) as n FROM consultations WHERE date BETWEEN ? AND ? AND userId=? GROUP BY h ORDER BY h").all(fromStr, toStr, req.user.id);

  // Daily activity (last 14 days within range)
  const daily = db.prepare("SELECT strftime('%Y-%m-%d',date) as d, COUNT(*) as n FROM consultations WHERE date BETWEEN ? AND ? AND userId=? GROUP BY d ORDER BY d").all(fromStr, toStr, req.user.id);

  // Insurance breakdown
  const byInsurance = db.prepare("SELECT typeAssurance, COUNT(*) as n FROM patients WHERE typeAssurance IS NOT NULL AND typeAssurance != '' GROUP BY typeAssurance ORDER BY n DESC").all();

  res.json({
    period: { from: dateFrom, to: dateTo },
    totalConsults, validated, withNote, withPrescription,
    avgDuration: avgDuration ? Math.round(avgDuration) : null,
    validationRate: totalConsults > 0 ? Math.round(validated/totalConsults*100) : 0,
    prescriptionRate: totalConsults > 0 ? Math.round(withPrescription/totalConsults*100) : 0,
    totalPatients, femmes, hommes,
    pctFemmes: totalPatients > 0 ? Math.round(femmes/totalPatients*100) : 0,
    pctHommes: totalPatients > 0 ? Math.round(hommes/totalPatients*100) : 0,
    avgAge: avgAge ? Math.round(avgAge) : null,
    topMotifs, byHour, daily, byInsurance
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECRETARY ALERTS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/alerts', auth, (req, res) => {
  const alerts = db.prepare('SELECT * FROM secretary_alerts WHERE userId=? ORDER BY createdAt DESC LIMIT 20').all(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) as n FROM secretary_alerts WHERE userId=? AND isRead=0').get(req.user.id).n;
  res.json({ alerts, unread });
});

app.post('/api/alerts', auth, (req, res) => {
  const { message, type='info', fromName='Secrétariat', userId } = req.body;
  const targetId = userId || req.user.id;
  const id = randomUUID();
  db.prepare('INSERT INTO secretary_alerts (id,userId,fromName,message,type) VALUES (?,?,?,?,?)').run(id, targetId, fromName, message, type);
  res.json({ id });
});

app.patch('/api/alerts/:id/read', auth, (req, res) => {
  db.prepare('UPDATE secretary_alerts SET isRead=1 WHERE id=? AND userId=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/alerts/read-all', auth, (req, res) => {
  db.prepare('UPDATE secretary_alerts SET isRead=1 WHERE userId=?').run(req.user.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/audit', auth, (req, res) => {
  const page = parseInt(req.query.page)||0;
  const logs = db.prepare('SELECT * FROM audit_logs ORDER BY createdAt DESC LIMIT 50 OFFSET ?').all(page*50);
  const total = db.prepare('SELECT COUNT(*) as n FROM audit_logs').get().n;
  res.json({ logs, total, page });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PDF HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function buildConsultationPDF(doc, c) {
  const p    = db.prepare('SELECT * FROM patients WHERE id=?').get(c.patientId);
  const note = parseNote(c);
  const dateStr = new Date(c.date).toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'});
  const dobStr  = p?.dateNaissance ? new Date(p.dateNaissance+'T00:00:00').toLocaleDateString('fr-FR') : '';

  doc.rect(0,0,doc.page.width,78).fill('#2563eb');
  doc.fillColor('white').fontSize(22).font('Helvetica-Bold').text('MediVox',50,18);
  doc.fontSize(10).font('Helvetica').text('Compte rendu de consultation médicale',50,44);
  doc.fontSize(9).text(dateStr,50,59);

  let y=95;
  doc.fillColor('#1e293b').fontSize(12).font('Helvetica-Bold').text('PATIENT',50,y); y+=16;
  doc.rect(50,y,495,1).fill('#e2e8f0'); y+=8;
  for (const l of [`Nom : ${p?.prenom||''} ${p?.nom||''}`, dobStr?`Naissance : ${dobStr}`:null, p?.allergies?`⚠ Allergies : ${p.allergies}`:null, p?.traitements?`Traitements : ${p.traitements}`:null].filter(Boolean)) {
    doc.fontSize(10).font('Helvetica').fillColor('#334155').text(l,60,y); y+=14;
  }
  y+=6; doc.rect(50,y,495,28).fill('#eff6ff');
  doc.fillColor('#1d4ed8').fontSize(11).font('Helvetica-Bold').text(`Motif : ${c.motif}`,58,y+8); y+=36;

  if (note) {
    for (const s of [{label:'Histoire de la maladie',key:'histoire'},{label:'Examen clinique',key:'examen'},{label:'Hypothèses diagnostiques',key:'hypotheses'},{label:'Conduite à tenir',key:'conduite'},{label:'Prescriptions / Examens',key:'prescriptions'},{label:'Conseils au patient',key:'conseils_patient'},{label:"Signes d'alarme",key:'drapeaux_rouges',alert:true}]) {
      const text = note[s.key]; if (!text?.trim()) continue;
      if(y>710){doc.addPage();y=50;}
      doc.fillColor(s.alert?'#b91c1c':'#1e293b').fontSize(10).font('Helvetica-Bold').text(s.label.toUpperCase(),50,y); y+=14;
      doc.rect(50,y,495,1).fill(s.alert?'#fca5a5':'#cbd5e1'); y+=7;
      const h=doc.heightOfString(text,{width:475}); if(y+h>740){doc.addPage();y=50;}
      doc.fillColor('#334155').fontSize(10).font('Helvetica').text(text,60,y,{width:475}); y+=h+12;
    }
  }
  const fy=doc.page.height-38; doc.rect(0,fy-4,doc.page.width,42).fill('#f8fafc');
  doc.fillColor('#94a3b8').fontSize(7.5).font('Helvetica').text('MediVox — Compte rendu validé par le médecin — Non opposable sans signature',50,fy+2,{align:'center',width:495});
  doc.end();
}

app.get('/api/patients/:id/dossier/pdf', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM patients WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Patient non trouvé' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const consultations = db.prepare(`SELECT c.*, u.nom as dNom, u.prenom as dPrenom, u.specialite as dSpec
    FROM consultations c LEFT JOIN users u ON u.id=c.userId WHERE c.patientId=? ORDER BY c.date DESC`).all(p.id);
  const prescriptions = db.prepare(`SELECT pr.lignes, c.date, c.motif FROM prescriptions pr
    JOIN consultations c ON c.id=pr.consultationId WHERE c.patientId=? AND pr.validee=1 ORDER BY c.date DESC LIMIT 5`).all(p.id);
  const age = p.dateNaissance ? new Date().getFullYear() - new Date(p.dateNaissance+'T00:00:00').getFullYear() : null;
  const dateStr = new Date().toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'});
  const dobStr = p.dateNaissance ? new Date(p.dateNaissance+'T00:00:00').toLocaleDateString('fr-FR') : '';
  const doc = new PDFDocument({ margin:50, size:'A4' });
  res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="dossier-${p.nom}-${p.prenom}.pdf"`});
  doc.pipe(res);

  // Cover header
  doc.rect(0,0,doc.page.width,90).fill('#1e293b');
  doc.fillColor('white').fontSize(24).font('Helvetica-Bold').text('MediVox',50,22);
  doc.fontSize(11).font('Helvetica').text('Dossier médical complet',50,50);
  doc.fontSize(9).text(`Généré le ${dateStr} — Dr. ${u?.prenom||''} ${u?.nom||''}`,50,65);

  let y=108;
  const section=(title,color='#1e293b')=>{
    if(y>700){doc.addPage();y=50;}
    doc.fillColor(color).fontSize(11).font('Helvetica-Bold').text(title.toUpperCase(),50,y); y+=14;
    doc.rect(50,y,495,1).fill('#e2e8f0'); y+=10;
  };
  const row=(label,val,indent=60)=>{
    if(!val?.trim()) return;
    if(y>710){doc.addPage();y=50;}
    const text=`${label} : ${val}`;
    const h=doc.heightOfString(text,{width:475});
    doc.fillColor('#334155').fontSize(9.5).font('Helvetica').text(text,indent,y,{width:475}); y+=h+6;
  };

  section('IDENTITÉ');
  row('Patient',`${p.prenom} ${p.nom}`);
  if(dobStr) row('Date de naissance',`${dobStr}${age?` (${age} ans)`:''}`);
  row('Sexe',p.sexe==='F'?'Féminin':'Masculin');
  if(p.telephone) row('Téléphone',p.telephone);
  if(p.email) row('Email',p.email);
  if(p.adresse) row('Adresse',p.adresse);
  if(p.typeAssurance) row('Assurance',`${p.typeAssurance}${p.numAssurance?' — '+p.numAssurance:''}`);
  y+=6;

  section('INFORMATIONS MÉDICALES','#1d4ed8');
  if(p.antecedents) row('Antécédents médicaux',p.antecedents);
  if(p.antecedents_familiaux) row('Antécédents familiaux',p.antecedents_familiaux);
  if(p.antecedents_chirurgicaux) row('Antécédents chirurgicaux',p.antecedents_chirurgicaux);
  if(p.allergies) row('Allergies',p.allergies);
  if(p.intolerances) row('Intolérances médicamenteuses',p.intolerances);
  if(p.facteurs_risque) row('Facteurs de risque',p.facteurs_risque);
  if(p.vaccinations) row('Vaccinations',p.vaccinations);
  if(p.traitements) row('Traitements chroniques en cours',p.traitements);
  y+=6;

  section('ORDONNANCES ACTIVES','#059669');
  if(prescriptions.length===0){doc.fillColor('#94a3b8').fontSize(9).font('Helvetica').text('Aucune ordonnance validée.',60,y);y+=16;}
  for(const rx of prescriptions){
    const lines=(() => { try { return JSON.parse(rx.lignes); } catch { return []; } })();
    if(y>700){doc.addPage();y=50;}
    doc.fillColor('#475569').fontSize(9).font('Helvetica-Bold').text(`Ordonnance du ${new Date(rx.date).toLocaleDateString('fr-FR')} — ${rx.motif}`,60,y); y+=13;
    for(const l of lines){
      if(!l.medicament) continue;
      if(y>720){doc.addPage();y=50;}
      doc.fillColor('#334155').fontSize(9).font('Helvetica').text(`• ${l.medicament}${l.posologie?' — '+l.posologie:''}${l.duree?' ('+l.duree+')':''}`,70,y); y+=12;
    }
    y+=4;
  }
  y+=6;

  section('HISTORIQUE DES CONSULTATIONS','#7c3aed');
  if(consultations.length===0){doc.fillColor('#94a3b8').fontSize(9).font('Helvetica').text('Aucune consultation enregistrée.',60,y);y+=16;}
  for(const c of consultations){
    if(y>700){doc.addPage();y=50;}
    const note=(() => { try { return JSON.parse(decrypt(c.noteJson)||c.noteJson||'{}'); } catch { return null; } })();
    const dStr=new Date(c.date).toLocaleDateString('fr-FR');
    doc.fillColor('#1e293b').fontSize(9.5).font('Helvetica-Bold').text(`${dStr} — ${c.motif}`,60,y); y+=13;
    if(c.dNom) { doc.fillColor('#7c3aed').fontSize(8.5).font('Helvetica').text(`Dr. ${c.dPrenom} ${c.dNom}${c.dSpec?' ('+c.dSpec+')':''}`,60,y); y+=12; }
    if(note?.conduite){ const h=doc.heightOfString(note.conduite,{width:455}); if(y+h<720){doc.fillColor('#475569').fontSize(8.5).font('Helvetica').text(note.conduite,70,y,{width:455});y+=h+4;} }
    y+=4;
  }

  const fy=doc.page.height-35;
  doc.rect(0,fy-2,doc.page.width,37).fill('#f8fafc');
  doc.fillColor('#94a3b8').fontSize(7.5).font('Helvetica').text('MediVox — Dossier médical confidentiel — Généré électroniquement — Non opposable sans signature',50,fy+8,{align:'center',width:495});
  doc.end();
});

app.get('/api/consultations/:id/pdf', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM consultations WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Consultation non trouvée' });
  const doc = new PDFDocument({ margin:50, size:'A4' });
  res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="consultation-${c.id}.pdf"`});
  doc.pipe(res);
  buildConsultationPDF(doc, c);
});

app.get('/api/consultations/:id/prescription/pdf', auth, (req, res) => {
  const c  = db.prepare('SELECT * FROM consultations WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Consultation non trouvée' });
  const p  = db.prepare('SELECT * FROM patients WHERE id=?').get(c.patientId);
  const u  = db.prepare('SELECT * FROM users WHERE id=?').get(c.userId||req.user.id);
  const rx = db.prepare('SELECT * FROM prescriptions WHERE consultationId=?').get(c.id);
  const lignes = parseLignes(rx);
  const dateStr = new Date(c.date).toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'});
  const dobStr  = p?.dateNaissance ? new Date(p.dateNaissance+'T00:00:00').toLocaleDateString('fr-FR') : '';

  const doc = new PDFDocument({margin:50,size:'A4'});
  res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="ordonnance-${c.id}.pdf"`});
  doc.pipe(res);

  doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e293b').text(`${u?.prenom||'Dr.'} ${u?.nom||''}`,50,50);
  doc.fontSize(9).font('Helvetica').fillColor('#475569').text(u?.specialite||'Médecin',50,64);
  if(u?.rpps) doc.text(`N° RPPS : ${u.rpps}`,50,77);
  if(u?.adresse) doc.text(u.adresse,50,91);
  doc.fontSize(9).fillColor('#475569').text(dateStr,0,50,{align:'right',width:545});
  doc.moveTo(50,112).lineTo(545,112).strokeColor('#e2e8f0').lineWidth(1).stroke();
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#1e293b').text('Patient',50,122);
  doc.fontSize(10).font('Helvetica').fillColor('#334155').text(`${p?.prenom||''} ${p?.nom||''}`,50,137);
  if(dobStr) doc.fontSize(9).fillColor('#64748b').text(`Né(e) le ${dobStr}`,50,151);
  doc.rect(50,170,495,32).fill('#eff6ff');
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#1d4ed8').text('ORDONNANCE',0,180,{align:'center',width:595});

  let y=218;
  if(lignes.length===0) { doc.fontSize(10).font('Helvetica').fillColor('#94a3b8').text('Aucun médicament prescrit.',60,y); }
  else { for(let i=0;i<lignes.length;i++){
    const l=lignes[i]; if(y>680){doc.addPage();y=60;}
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e293b').text(`${i+1}. ${l.medicament||''}`,60,y); y+=16;
    if(l.posologie){doc.fontSize(10).font('Helvetica').fillColor('#334155').text(l.posologie,72,y);y+=14;}
    if(l.duree){doc.fontSize(9).fillColor('#64748b').text(`Durée : ${l.duree}`,72,y);y+=14;}
    if(l.quantite){doc.fontSize(9).fillColor('#64748b').text(`Qté : ${l.quantite}`,72,y);y+=14;}
    y+=8;
  }}

  const sigY=Math.max(y+30,630);
  doc.moveTo(350,sigY).lineTo(545,sigY).strokeColor('#94a3b8').dash(3,{space:3}).stroke().undash();
  doc.fontSize(8).fillColor('#94a3b8').text('Signature et cachet',350,sigY+4,{width:195,align:'center'});
  const fy2=doc.page.height-35;
  doc.rect(0,fy2,doc.page.width,35).fill('#f8fafc');
  doc.fontSize(7).fillColor('#94a3b8').text('MediVox — Valable 3 mois — Signature manuscrite requise',50,fy2+12,{align:'center',width:495});
  doc.end();
});

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGERIE MÉDICALE — PostDICOM Cloud PACS
// ═══════════════════════════════════════════════════════════════════════════════

const IMAGING_MOCK = {
  p1: [
    {id:'i1-1',studyDate:'20260210',modality:'CR',description:'Radiographie thoracique — silhouette cardiaque dans les limites de la normale, pas d\'épanchement',imageCount:2,reportSummary:'RAS hormis discret épaississement hilaire gauche à surveiller.'},
    {id:'i1-2',studyDate:'20260115',modality:'US',description:'Échographie thyroïde — goitre multinodulaire discret, nodule dominant 8 mm en lobe droit',imageCount:8,reportSummary:'Surveillance à 6 mois recommandée. Pas d\'indication biopsique.'},
  ],
  p2: [
    {id:'i2-1',studyDate:'20260305',modality:'OT',description:'ECG 12 dérivations — rythme sinusal régulier 72/min, pas d\'anomalie de repolarisation',imageCount:1,reportSummary:'ECG dans les limites de la normale. Pas de trouble du rythme ou de la conduction.'},
    {id:'i2-2',studyDate:'20260220',modality:'US',description:'Échographie abdominale — stéatose hépatique légère, vésicule biliaire saine, reins normaux',imageCount:12,reportSummary:'Stéatose hépatique grade 1 compatible avec le contexte métabolique.'},
  ],
  p3: [
    {id:'i3-1',studyDate:'20260308',modality:'CR',description:'Radiographie thoracique — distension pulmonaire modérée, pas de foyer infectieux',imageCount:2,reportSummary:'Distension thoracique compatible avec l\'asthme connu. Pas de pneumothorax.'},
  ],
  p4: [
    {id:'i4-1',studyDate:'20260228',modality:'MR',description:'IRM lombaire — hernie discale L4-L5 paramédiane gauche avec débord postérieur modéré',imageCount:24,reportSummary:'Compression radiculaire L5 gauche probable. Avis neurochirurgical conseillé si douleurs résistantes.'},
    {id:'i4-2',studyDate:'20260110',modality:'CR',description:'Radiographie rachis lombaire face et profil — pincement discal L4-L5, ostéophytose modérée',imageCount:3,reportSummary:'Spondylarthrose L4-L5 confirmée. Pas de lyse isthmique.'},
  ],
  p5: [],
};

app.get('/api/patients/:id/imaging', auth, async (req, res) => {
  const p = db.prepare('SELECT * FROM patients WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Patient non trouvé' });

  const { POSTDICOM_BASE_URL, POSTDICOM_USER, POSTDICOM_PASS } = process.env;

  if (POSTDICOM_BASE_URL && POSTDICOM_USER && POSTDICOM_PASS) {
    try {
      const creds = Buffer.from(`${POSTDICOM_USER}:${POSTDICOM_PASS}`).toString('base64');
      const url = `${POSTDICOM_BASE_URL}/studies?PatientID=${encodeURIComponent(p.id)}&includefield=all`;
      const r = await fetch(url, {
        headers: { Authorization: `Basic ${creds}`, Accept: 'application/dicom+json, application/json' }
      });
      if (r.ok) {
        const data = await r.json();
        const studies = (Array.isArray(data) ? data : []).map(s => ({
          id:          s['0020000D']?.Value?.[0] || '',
          studyDate:   s['00080020']?.Value?.[0] || '',
          modality:    s['00080061']?.Value?.[0] || s['00080060']?.Value?.[0] || '',
          description: s['00081030']?.Value?.[0] || '',
          imageCount:  s['00201208']?.Value?.[0] || 0,
          reportSummary: null,
          viewerUrl:   s['viewerUrl'] || null,
        }));
        return res.json({ source: 'postdicom', studies });
      }
    } catch (e) {
      console.error('PostDICOM error:', e.message);
    }
  }

  res.json({ source: 'mock', studies: IMAGING_MOCK[req.params.id] || [] });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTELLIGENCE MÉDICALE — Épidémio · Risque · Prévision
// ═══════════════════════════════════════════════════════════════════════════════

function classifyCIM10(code) {
  if (!code) return null;
  const l = code[0].toUpperCase();
  const n = parseInt(code.slice(1)) || 0;
  if ('AB'.includes(l)) return 'Infectieux / Parasitaire';
  if (l === 'C' || l === 'D' && n <= 48) return 'Oncologie';
  if (l === 'E') return 'Endocrinologie / Métabolique';
  if ('FG'.includes(l)) return 'Psychiatrique / Neuro';
  if (l === 'H' && n <= 59) return 'Ophtalmologie';
  if (l === 'H' && n >= 60) return 'ORL';
  if (l === 'I') return 'Cardiologique / HTA';
  if (l === 'J') return 'ORL / Respiratoire';
  if (l === 'K') return 'Gastro-Entérologie';
  if (l === 'L') return 'Dermatologie';
  if (l === 'M') return 'Rhumatologie / Ostéo';
  if (l === 'N' && n <= 69) return 'Urologie / Néphro';
  if (l === 'N' && n >= 70) return 'Gynécologie / Obstétrique';
  if (l === 'O') return 'Gynécologie / Obstétrique';
  if (l === 'Z') return 'Préventif / Dépistage';
  return 'Autre';
}

const DEMO_EPIDEMIO = {
  ageGroups: [
    {label:'0–14',h:12,f:10},{label:'15–24',h:18,f:22},{label:'25–34',h:25,f:31},
    {label:'35–44',h:30,f:28},{label:'45–54',h:22,f:24},{label:'55–64',h:16,f:18},
    {label:'65–74',h:10,f:12},{label:'75+',h:5,f:7}
  ],
  familles:[
    {name:'Cardiologique / HTA',n:142},{name:'Infectieux / Parasitaire',n:118},
    {name:'ORL / Respiratoire',n:97},{name:'Endocrinologie / Métabolique',n:88},
    {name:'Gastro-Entérologie',n:74},{name:'Psychiatrique / Neuro',n:61},
    {name:'Rhumatologie / Ostéo',n:53},{name:'Dermatologie',n:44},
    {name:'Urologie / Néphro',n:38},{name:'Gynécologie / Obstétrique',n:35},
    {name:'Ophtalmologie',n:22},{name:'Autre',n:28}
  ],
  topDiag:[
    {code:'I10',libelle:'Hypertension essentielle',n:98},{code:'J06',libelle:'Inf. aiguë voies respir. sup.',n:76},
    {code:'E11',libelle:'Diabète type 2',n:64},{code:'K21',libelle:'Reflux gastro-œsophagien',n:52},
    {code:'J45',libelle:'Asthme',n:48},{code:'M54',libelle:'Dorsalgie',n:44},
    {code:'E78',libelle:'Dyslipidémie',n:41},{code:'F41',libelle:'Anxiété',n:37},
    {code:'N39',libelle:'Inf. urinaire',n:33},{code:'I25',libelle:'Cardiopathie ischémique',n:29},
    {code:'L30',libelle:'Dermatite',n:26},{code:'K29',libelle:'Gastrite',n:24},
    {code:'J44',libelle:'BPCO',n:22},{code:'E03',libelle:'Hypothyroïdie',n:20},
    {code:'M05',libelle:'Polyarthrite rhumatoïde',n:18},{code:'F32',libelle:'Épisode dépressif',n:16},
    {code:'I50',libelle:'Insuffisance cardiaque',n:14},{code:'N18',libelle:'MRC',n:12},
    {code:'C34',libelle:'Néoplasie bronchopulmonaire',n:10},{code:'O80',libelle:'Accouchement normal',n:9}
  ],
  saisonnalite:[
    {month:'Jan',resp:28,card:18,inf:22},{month:'Fév',resp:24,card:16,inf:18},
    {month:'Mar',resp:20,card:15,inf:14},{month:'Avr',resp:15,card:17,inf:10},
    {month:'Mai',resp:12,card:18,inf:8},{month:'Jun',resp:10,card:19,inf:12},
    {month:'Jul',resp:9,card:20,inf:15},{month:'Aoû',resp:11,card:18,inf:14},
    {month:'Sep',resp:14,card:17,inf:12},{month:'Oct',resp:18,card:19,inf:16},
    {month:'Nov',resp:22,card:20,inf:20},{month:'Déc',resp:26,card:22,inf:24}
  ]
};

app.get('/api/analytics/epidemio', auth, (req, res) => {
  // Real CIM-10 from DB
  const consults = db.prepare("SELECT noteJson FROM consultations WHERE statut='validee'").all();
  const diagCounts = {};
  for (const c of consults) {
    try {
      const note = JSON.parse(decrypt(c.noteJson) || c.noteJson || '{}');
      const cim = note.cim10;
      if (cim?.code) diagCounts[cim.code] = (diagCounts[cim.code] || { code: cim.code, libelle: cim.libelle, n: 0 });
      if (cim?.code) diagCounts[cim.code].n++;
    } catch {}
  }
  const realDiags = Object.values(diagCounts).sort((a,b)=>b.n-a.n);
  const realFamilles = {};
  for (const d of realDiags) {
    const fam = classifyCIM10(d.code);
    if (fam) realFamilles[fam] = (realFamilles[fam] || 0) + d.n;
  }

  // Patient age pyramid from DB
  const patients = db.prepare("SELECT dateNaissance, sexe FROM patients WHERE dateNaissance IS NOT NULL AND dateNaissance != ''").all();
  const realAgeGroups = {};
  for (const p of patients) {
    const age = new Date().getFullYear() - new Date(p.dateNaissance + 'T00:00:00').getFullYear();
    const bracket = age < 15 ? '0–14' : age < 25 ? '15–24' : age < 35 ? '25–34' : age < 45 ? '35–44' : age < 55 ? '45–54' : age < 65 ? '55–64' : age < 75 ? '65–74' : '75+';
    if (!realAgeGroups[bracket]) realAgeGroups[bracket] = { label: bracket, h: 0, f: 0 };
    if (p.sexe === 'M') realAgeGroups[bracket].h++; else realAgeGroups[bracket].f++;
  }

  res.json({
    real: {
      topDiag: realDiags.slice(0, 20),
      familles: Object.entries(realFamilles).map(([name,n])=>({name,n})).sort((a,b)=>b.n-a.n),
      ageGroups: Object.values(realAgeGroups)
    },
    demo: DEMO_EPIDEMIO,
    hasRealData: realDiags.length > 0
  });
});

app.get('/api/analytics/risk', auth, (req, res) => {
  const patients = db.prepare("SELECT * FROM patients").all();
  const riskList = [];
  for (const p of patients) {
    let score = 0; const flags = [];
    const age = p.dateNaissance ? new Date().getFullYear() - new Date(p.dateNaissance + 'T00:00:00').getFullYear() : 0;
    if (age >= 65) { score += 2; flags.push('Âge ≥65 ans'); }
    else if (age >= 50) { score += 1; flags.push('Âge ≥50 ans'); }

    const diags = db.prepare("SELECT noteJson FROM consultations WHERE patientId=? AND statut='validee' ORDER BY date DESC LIMIT 10").all(p.id);
    const codes = new Set();
    for (const c of diags) {
      try { const n = JSON.parse(decrypt(c.noteJson)||c.noteJson||'{}'); if(n.cim10?.code) codes.add(n.cim10.code); } catch {}
    }
    if ([...codes].some(c=>c.startsWith('I1')||c==='I10')) { score+=3; flags.push('HTA'); }
    if ([...codes].some(c=>c.startsWith('E1')||c.startsWith('E11'))) { score+=3; flags.push('Diabète'); }
    if ([...codes].some(c=>c==='E78'||c.startsWith('E78'))) { score+=2; flags.push('Dyslipidémie'); }
    if ([...codes].some(c=>c.startsWith('I2')||c.startsWith('I5'))) { score+=4; flags.push('Cardiopathie'); }
    if ([...codes].some(c=>c.startsWith('C'))) { score+=4; flags.push('Oncologie'); }
    if ([...codes].some(c=>c==='N18')) { score+=3; flags.push('MRC'); }

    if (p.allergies?.trim()) { score+=1; flags.push('Allergies connues'); }

    const rxCount = db.prepare("SELECT COUNT(DISTINCT consultationId) as n FROM prescriptions p JOIN consultations c ON c.id=p.consultationId WHERE c.patientId=?").get(p.id)?.n||0;
    if (rxCount >= 3) { score+=2; flags.push('Polymédication'); }

    const lastConsult = db.prepare("SELECT date FROM consultations WHERE patientId=? ORDER BY date DESC LIMIT 1").get(p.id);
    const daysSince = lastConsult ? Math.floor((Date.now()-new Date(lastConsult.date).getTime())/(864e5)) : 999;
    if (daysSince > 180) { score+=2; flags.push(`Dernière visite il y a ${daysSince}j`); }

    const level = score >= 8 ? 'critique' : score >= 5 ? 'élevé' : score >= 3 ? 'modéré' : 'faible';
    riskList.push({ id:p.id, nom:p.nom, prenom:p.prenom, age, score, level, flags, daysSince, lastConsultDate: lastConsult?.date||null });
  }
  riskList.sort((a,b)=>b.score-a.score);
  res.json({ patients: riskList });
});

app.get('/api/analytics/forecast', auth, (req, res) => {
  // Monthly consultation counts last 18 months
  const monthly = db.prepare(`
    SELECT strftime('%Y-%m', date) as month, COUNT(*) as n
    FROM consultations WHERE userId=?
    GROUP BY month ORDER BY month ASC LIMIT 18
  `).all(req.user.id);

  // Linear regression on real data
  let forecast = null;
  if (monthly.length >= 3) {
    const n = monthly.length;
    const xs = monthly.map((_,i)=>i);
    const ys = monthly.map(r=>r.n);
    const sumX=xs.reduce((a,b)=>a+b,0), sumY=ys.reduce((a,b)=>a+b,0);
    const sumXY=xs.reduce((a,x,i)=>a+x*ys[i],0), sumX2=xs.reduce((a,x)=>a+x*x,0);
    const slope=(n*sumXY-sumX*sumY)/(n*sumX2-sumX*sumX)||0;
    const intercept=(sumY-slope*sumX)/n;
    const lastIdx=n-1;
    forecast=[1,2,3].map(d=>({
      month: (() => { const dt=new Date(); dt.setDate(1); dt.setMonth(dt.getMonth()+d); return dt.toISOString().slice(0,7); })(),
      n: Math.max(0, Math.round(intercept+slope*(lastIdx+d)))
    }));
  }

  // Demo supplement (18 months of realistic Libreville data if sparse)
  const demoMonthly = [
    {month:'2024-09',n:41},{month:'2024-10',n:47},{month:'2024-11',n:52},{month:'2024-12',n:44},
    {month:'2025-01',n:50},{month:'2025-02',n:55},{month:'2025-03',n:58},{month:'2025-04',n:61},
    {month:'2025-05',n:64},{month:'2025-06',n:60},{month:'2025-07',n:57},{month:'2025-08',n:63},
    {month:'2025-09',n:68},{month:'2025-10',n:72},{month:'2025-11',n:75},{month:'2025-12',n:70},
    {month:'2026-01',n:78},{month:'2026-02',n:82}
  ];
  const demoForecast=[{month:'2026-03',n:86},{month:'2026-04',n:90},{month:'2026-05',n:94}];
  const trend = monthly.length >= 2 ? (monthly[monthly.length-1].n - monthly[0].n > 0 ? 'hausse' : 'baisse') : 'stable';

  res.json({ monthly, forecast, trend, demo: { monthly: demoMonthly, forecast: demoForecast }, hasRealData: monthly.length > 0 });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAPETERIE MÉDICALE STANDARD (sans consultation)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/patients/:id/papeterie/arret-maladie/pdf', auth, (req,res)=>{
  const p=db.prepare('SELECT * FROM patients WHERE id=?').get(req.params.id);
  if(!p) return res.status(404).json({error:'Patient non trouvé'});
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const{duree=3,dateDebut,sortie='autorisee'}=req.body;
  const debut=dateDebut?new Date(dateDebut+'T00:00:00'):new Date();
  const fin=new Date(debut);fin.setDate(debut.getDate()+Number(duree)-1);
  const fmt=d=>d.toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'});
  const dateStr=new Date().toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'});
  const sortieLabel={autorisee:'Sorties autorisées',interdite:'Sorties interdites',autorisee_horaires:'Sorties autorisées aux heures habituelles (8h–12h / 14h–18h)'}[sortie]||'Sorties autorisées';
  const doc=new PDFDocument({margin:50,size:'A4'});
  res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="arret-maladie-${p.nom}.pdf"`});
  doc.pipe(res);
  docHeader(doc,u,dateStr);
  let y=docTitle(doc,"CERTIFICAT D'ARRÊT DE TRAVAIL",'#dc2626');
  y=docPatient(doc,p,y);
  doc.moveTo(50,y).lineTo(545,y).strokeColor('#f1f5f9').lineWidth(1).stroke();y+=16;
  doc.fillColor('#1e293b').fontSize(10).font('Helvetica').text('Je soussigné(e), certifie avoir examiné ce jour le patient susmentionné et prescrit un arrêt de travail :',50,y,{width:495});y+=30;
  doc.rect(50,y,495,56).fill('#fef2f2');
  doc.fillColor('#dc2626').fontSize(13).font('Helvetica-Bold').text(`Du ${fmt(debut)} au ${fmt(fin)}`,0,y+8,{align:'center',width:595});
  doc.fontSize(10).font('Helvetica').fillColor('#991b1b').text(`Durée : ${duree} jour${duree>1?'s':''}  —  ${sortieLabel}`,0,y+26,{align:'center',width:595});
  y+=72;
  doc.fillColor('#334155').fontSize(9).font('Helvetica').text('Ce certificat est établi à la demande de l\'intéressé(e) et lui est remis pour faire valoir ce que de droit.',50,y,{width:495});
  docSig(doc,y+24);docFooter(doc);doc.end();
});

app.post('/api/patients/:id/papeterie/certificat-sante/pdf', auth, (req,res)=>{
  const p=db.prepare('SELECT * FROM patients WHERE id=?').get(req.params.id);
  if(!p) return res.status(404).json({error:'Patient non trouvé'});
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const{observations='',objet='bonne santé générale'}=req.body;
  const dateStr=new Date().toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'});
  const doc=new PDFDocument({margin:50,size:'A4'});
  res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="certificat-sante-${p.nom}.pdf"`});
  doc.pipe(res);
  docHeader(doc,u,dateStr);
  let y=docTitle(doc,'CERTIFICAT MÉDICAL','#16a34a');
  y=docPatient(doc,p,y);
  doc.moveTo(50,y).lineTo(545,y).strokeColor('#f1f5f9').lineWidth(1).stroke();y+=16;
  const age=p.dateNaissance?Math.floor((Date.now()-new Date(p.dateNaissance+'T00:00:00'))/(365.25*24*3600*1000))+' an(s)':'';
  const texte=`Je soussigné(e), Docteur ${u?.prenom||''} ${u?.nom||''}, certifie avoir examiné ce jour ${p.prenom} ${p.nom}${age?', âgé(e) de '+age:''}.\n\nAu terme de cet examen, je certifie que ce patient présente un état de ${objet}.${observations?'\n\n'+observations:''}`;
  doc.fillColor('#334155').fontSize(10).font('Helvetica').text(texte,50,y,{width:495});y+=doc.heightOfString(texte,{width:495})+20;
  doc.fillColor('#334155').fontSize(9).font('Helvetica').text('Ce certificat est établi à la demande de l\'intéressé(e) et lui est remis pour faire valoir ce que de droit.',50,y,{width:495});
  docSig(doc,y+24);docFooter(doc);doc.end();
});

app.post('/api/patients/:id/papeterie/dispense-sport/pdf', auth, (req,res)=>{
  const p=db.prepare('SELECT * FROM patients WHERE id=?').get(req.params.id);
  if(!p) return res.status(404).json({error:'Patient non trouvé'});
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const{duree='1 mois',motif='',partielle=false}=req.body;
  const dateStr=new Date().toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'});
  const doc=new PDFDocument({margin:50,size:'A4'});
  res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="dispense-sport-${p.nom}.pdf"`});
  doc.pipe(res);
  docHeader(doc,u,dateStr);
  let y=docTitle(doc,'CERTIFICAT DE DISPENSE DE SPORT','#0284c7');
  y=docPatient(doc,p,y);
  doc.moveTo(50,y).lineTo(545,y).strokeColor('#f1f5f9').lineWidth(1).stroke();y+=16;
  const age=p.dateNaissance?Math.floor((Date.now()-new Date(p.dateNaissance+'T00:00:00'))/(365.25*24*3600*1000))+' an(s)':'';
  const typeDispense=partielle?'une dispense partielle de sport (activités physiques intenses)':'une dispense totale de sport';
  const texte=`Je soussigné(e), Docteur ${u?.prenom||''} ${u?.nom||''}, certifie avoir examiné ce jour ${p.prenom} ${p.nom}${age?', âgé(e) de '+age:''}.\n\nPour des raisons médicales${motif?(' : '+motif):'.'}, je prescris ${typeDispense} pour une durée de ${duree}.`;
  doc.fillColor('#334155').fontSize(10).font('Helvetica').text(texte,50,y,{width:495});y+=doc.heightOfString(texte,{width:495})+20;
  doc.fillColor('#334155').fontSize(9).font('Helvetica').text('Ce certificat est établi à la demande de l\'intéressé(e) et lui est remis pour faire valoir ce que de droit.',50,y,{width:495});
  docSig(doc,y+24);docFooter(doc);doc.end();
});

app.post('/api/patients/:id/papeterie/attestation-soins/pdf', auth, (req,res)=>{
  const p=db.prepare('SELECT * FROM patients WHERE id=?').get(req.params.id);
  if(!p) return res.status(404).json({error:'Patient non trouvé'});
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const{nature='Consultation médicale',datesSoins}=req.body;
  const dateStr=new Date().toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'});
  const soinsDate=datesSoins||dateStr;
  const doc=new PDFDocument({margin:50,size:'A4'});
  res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="attestation-soins-${p.nom}.pdf"`});
  doc.pipe(res);
  docHeader(doc,u,dateStr);
  let y=docTitle(doc,'ATTESTATION DE SOINS','#7c3aed');
  y=docPatient(doc,p,y);
  doc.moveTo(50,y).lineTo(545,y).strokeColor('#f1f5f9').lineWidth(1).stroke();y+=16;
  const texte=`Je soussigné(e), Docteur ${u?.prenom||''} ${u?.nom||''}, atteste avoir dispensé les soins suivants à ${p.prenom} ${p.nom} :\n\nNature des soins : ${nature}\nDate des soins : ${soinsDate}\n\nCette attestation est délivrée à titre de justificatif pour remboursement auprès de l'organisme d'assurance maladie.`;
  doc.fillColor('#334155').fontSize(10).font('Helvetica').text(texte,50,y,{width:495});y+=doc.heightOfString(texte,{width:495})+20;
  docSig(doc,y+10);docFooter(doc);doc.end();
});

app.post('/api/patients/:id/papeterie/entete-vierge/pdf', auth, (req,res)=>{
  const p=db.prepare('SELECT * FROM patients WHERE id=?').get(req.params.id);
  if(!p) return res.status(404).json({error:'Patient non trouvé'});
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const dateStr=new Date().toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'});
  const doc=new PDFDocument({margin:50,size:'A4'});
  res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="document-${p.nom}.pdf"`});
  doc.pipe(res);
  docHeader(doc,u,dateStr);
  let y=178;
  y=docPatient(doc,p,y);
  doc.moveTo(50,y).lineTo(545,y).strokeColor('#f1f5f9').lineWidth(1).stroke();y+=20;
  for(let i=0;i<12;i++){doc.moveTo(50,y+i*36).lineTo(545,y+i*36).strokeColor('#e2e8f0').lineWidth(0.5).stroke();}
  docSig(doc,y+12*36+20);docFooter(doc);doc.end();
});

// ═══════════════════════════════════════════════════════════════════════════════
// HONORAIRES & TARIFS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/honoraires/dashboard', auth, (req, res) => {
  const uid = req.user.id;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const d = now.getDay();
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - (d === 0 ? 6 : d - 1));
  const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const yearStart = `${now.getFullYear()}-01-01`;
  const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  const revQ = from => db.prepare(`SELECT COALESCE(SUM(montant),0) as t FROM honoraires WHERE userId=? AND statut='paye' AND datePaiement>=?`).get(uid, from).t;
  const revJour = revQ(today);
  const revSemaine = revQ(weekStart.toISOString().slice(0,10));
  const revMois = revQ(monthStart);

  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const projectionMois = dayOfMonth > 0 ? Math.round((revMois / dayOfMonth) * daysInMonth) : 0;

  const nonFactures = db.prepare(`
    SELECT c.id, c.motif, c.date, p.nom, p.prenom, p.typeAssurance, h.id as hId, h.statut
    FROM consultations c
    JOIN patients p ON c.patientId = p.id
    LEFT JOIN honoraires h ON h.consultationId = c.id AND h.userId = ?
    WHERE c.userId = ? AND c.statut = 'validee' AND (h.id IS NULL OR h.statut = 'non_facture')
    ORDER BY c.date DESC LIMIT 50
  `).all(uid, uid);

  const rejets = db.prepare(`
    SELECT h.*, c.motif, c.date as consultDate, p.nom, p.prenom
    FROM honoraires h JOIN consultations c ON c.id=h.consultationId JOIN patients p ON p.id=c.patientId
    WHERE h.userId=? AND h.statut='rejete' ORDER BY h.updatedAt DESC LIMIT 20
  `).all(uid);

  const enAttente = db.prepare(`
    SELECT h.*, c.motif, c.date as consultDate, p.nom, p.prenom
    FROM honoraires h JOIN consultations c ON c.id=h.consultationId JOIN patients p ON p.id=c.patientId
    WHERE h.userId=? AND h.statut='en_attente' ORDER BY h.dateFacturation ASC
  `).all(uid);

  const vieillissement = { j0_30:{count:0,total:0}, j30_60:{count:0,total:0}, j60plus:{count:0,total:0} };
  for (const h of enAttente) {
    const days = Math.floor((now - new Date(h.dateFacturation || h.createdAt)) / 86400000);
    const b = days <= 30 ? 'j0_30' : days <= 60 ? 'j30_60' : 'j60plus';
    vieillissement[b].count++; vieillissement[b].total += h.montant;
  }

  const parCaisse = db.prepare(`
    SELECT caisse, COUNT(*) as count, SUM(montant) as total
    FROM honoraires WHERE userId=? AND statut='paye' AND strftime('%Y-%m',datePaiement)=?
    GROUP BY caisse ORDER BY total DESC
  `).all(uid, ym);

  const totalFacture = db.prepare(`SELECT COALESCE(SUM(montant),0) as t FROM honoraires WHERE userId=? AND statut IN ('en_attente','paye') AND strftime('%Y-%m',createdAt)=?`).get(uid, ym).t;
  const tauxRecouvrement = totalFacture > 0 ? Math.round((revMois / totalFacture) * 100) : 0;
  const nbPaye = db.prepare(`SELECT COUNT(*) as n FROM honoraires WHERE userId=? AND statut='paye' AND strftime('%Y-%m',datePaiement)=?`).get(uid, ym).n;
  const revParConsult = nbPaye > 0 ? Math.round(revMois / nbPaye) : 0;

  res.json({
    revenus: { jour: revJour, semaine: revSemaine, mois: revMois },
    projection: { mois: projectionMois },
    nonFactures: { count: nonFactures.length, items: nonFactures },
    rejets: { count: rejets.length, total: rejets.reduce((a,h)=>a+h.montant,0), items: rejets },
    enAttente: { count: enAttente.length, total: enAttente.reduce((a,h)=>a+h.montant,0), items: enAttente },
    vieillissement, parCaisse,
    kpis: { tauxRecouvrement, revParConsult },
  });
});

app.get('/api/honoraires/export', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT h.*, c.motif, c.date as consultDate, p.nom, p.prenom
    FROM honoraires h JOIN consultations c ON c.id=h.consultationId JOIN patients p ON p.id=c.patientId
    WHERE h.userId=? ORDER BY h.createdAt DESC
  `).all(req.user.id);
  const headers = ['Date facture','Patient','Motif','Type acte','Caisse','Montant FCFA','Statut','Date paiement'];
  const csv = [headers, ...rows.map(r=>[
    r.dateFacturation||r.createdAt?.slice(0,10)||'', `${r.prenom} ${r.nom}`,
    r.motif||'', r.typeActe||'', r.caisse||'', r.montant||0, r.statut||'', r.datePaiement||''
  ].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','))].join('\n');
  res.set({'Content-Type':'text/csv;charset=utf-8','Content-Disposition':'attachment; filename="honoraires.csv"'});
  res.send(csv);
});

app.get('/api/honoraires', auth, (req, res) => {
  const { statut, from, to } = req.query;
  let sql = `SELECT h.*, c.motif, c.date as consultDate, p.nom, p.prenom
    FROM honoraires h JOIN consultations c ON c.id=h.consultationId JOIN patients p ON p.id=c.patientId
    WHERE h.userId=?`;
  const params = [req.user.id];
  if (statut) { sql += ' AND h.statut=?'; params.push(statut); }
  if (from) { sql += ' AND h.createdAt>=?'; params.push(from); }
  if (to) { sql += ' AND h.createdAt<=?'; params.push(to+'T23:59:59'); }
  sql += ' ORDER BY h.createdAt DESC LIMIT 100';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/honoraires', auth, (req, res) => {
  const { consultationId, montant, statut='en_attente', caisse, typeActe, dateFacturation, datePaiement, notes } = req.body;
  if (!consultationId || montant === undefined) return res.status(400).json({ error: 'consultationId et montant requis' });
  const existing = db.prepare('SELECT id FROM honoraires WHERE consultationId=? AND userId=?').get(consultationId, req.user.id);
  if (existing) {
    db.prepare(`UPDATE honoraires SET montant=?,statut=?,caisse=?,typeActe=?,dateFacturation=?,datePaiement=?,notes=?,updatedAt=datetime('now') WHERE id=?`)
      .run(montant, statut, caisse||null, typeActe||null, dateFacturation||null, datePaiement||null, notes||null, existing.id);
    return res.json({ id: existing.id });
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO honoraires (id,consultationId,userId,montant,statut,caisse,typeActe,dateFacturation,datePaiement,notes) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, consultationId, req.user.id, montant, statut, caisse||null, typeActe||null, dateFacturation||null, datePaiement||null, notes||null);
  res.json({ id });
});

app.put('/api/honoraires/:id', auth, (req, res) => {
  const { montant, statut, caisse, typeActe, dateFacturation, datePaiement, notes } = req.body;
  db.prepare(`UPDATE honoraires SET montant=COALESCE(?,montant),statut=COALESCE(?,statut),caisse=COALESCE(?,caisse),typeActe=COALESCE(?,typeActe),dateFacturation=COALESCE(?,dateFacturation),datePaiement=COALESCE(?,datePaiement),notes=COALESCE(?,notes),updatedAt=datetime('now') WHERE id=? AND userId=?`)
    .run(montant??null,statut??null,caisse??null,typeActe??null,dateFacturation??null,datePaiement??null,notes??null,req.params.id,req.user.id);
  res.json({ ok: true });
});

app.delete('/api/honoraires/:id', auth, (req, res) => {
  db.prepare('DELETE FROM honoraires WHERE id=? AND userId=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.get('/api/tarifs', auth, (req, res) => {
  const tarifs = db.prepare('SELECT * FROM tarifs WHERE userId=? ORDER BY typeActe').all(req.user.id);
  if (tarifs.length === 0) return res.json([
    { typeActe:'Consultation simple', montant:5000 },
    { typeActe:'Consultation complexe', montant:10000 },
    { typeActe:'Visite à domicile', montant:15000 },
    { typeActe:'Téléconsultation', montant:4000 },
    { typeActe:'Acte technique', montant:8000 },
  ]);
  res.json(tarifs);
});

app.put('/api/tarifs', auth, (req, res) => {
  const { tarifs } = req.body;
  if (!Array.isArray(tarifs)) return res.status(400).json({ error: 'tarifs array required' });
  db.transaction(()=>{
    db.prepare('DELETE FROM tarifs WHERE userId=?').run(req.user.id);
    for (const t of tarifs)
      db.prepare('INSERT INTO tarifs (id,userId,typeActe,montant) VALUES (?,?,?,?)').run(randomUUID(),req.user.id,t.typeActe,t.montant||0);
  })();
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENTS MÉDICAUX
// ═══════════════════════════════════════════════════════════════════════════════

function docHeader(doc, u, dateStr) {
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#1e293b').text(`${u?.prenom||'Dr.'} ${u?.nom||''}`,50,50);
  doc.fontSize(9).font('Helvetica').fillColor('#475569').text(u?.specialite||'Médecin',50,64);
  if(u?.rpps) doc.text(`N° RPPS : ${u.rpps}`,50,77);
  if(u?.adresse) doc.text(u.adresse,50,91);
  doc.fontSize(9).fillColor('#475569').text(dateStr,0,50,{align:'right',width:545});
  doc.moveTo(50,112).lineTo(545,112).strokeColor('#e2e8f0').lineWidth(1).stroke();
}
function docTitle(doc, title, color) {
  doc.rect(50,122,495,36).fill(color+'22');
  doc.fillColor(color).fontSize(14).font('Helvetica-Bold').text(title,0,132,{align:'center',width:595});
  return 178;
}
function docPatient(doc, p, y) {
  doc.fillColor('#1e293b').fontSize(10).font('Helvetica-Bold').text('Patient',50,y);
  doc.fontSize(10).font('Helvetica').fillColor('#334155').text(`${p?.prenom||''} ${p?.nom||''}`,50,y+14);
  if(p?.dateNaissance){const dob=new Date(p.dateNaissance+'T00:00:00').toLocaleDateString('fr-FR');doc.fontSize(9).fillColor('#64748b').text(`Né(e) le ${dob}`,50,y+28);return y+50;}
  return y+36;
}
function docFooter(doc) {
  const fy=doc.page.height-35;
  doc.rect(0,fy,doc.page.width,35).fill('#f8fafc');
  doc.fontSize(7).fillColor('#94a3b8').font('Helvetica').text('MediVox — Document médical officiel',50,fy+12,{align:'center',width:495});
}
function docSig(doc, y) {
  const sigY=Math.max(y+60,620);
  doc.moveTo(350,sigY).lineTo(545,sigY).strokeColor('#94a3b8').dash(3,{space:3}).stroke().undash();
  doc.fontSize(8).fillColor('#94a3b8').font('Helvetica').text('Signature et cachet',350,sigY+4,{width:195,align:'center'});
}

app.post('/api/consultations/:id/arret-maladie/pdf', auth, (req,res)=>{
  const c=db.prepare('SELECT * FROM consultations WHERE id=?').get(req.params.id);
  if(!c) return res.status(404).json({error:'Non trouvée'});
  const p=db.prepare('SELECT * FROM patients WHERE id=?').get(c.patientId);
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(c.userId||req.user.id);
  const{duree=3,dateDebut,sortie='autorisee'}=req.body;
  const debut=dateDebut?new Date(dateDebut+'T00:00:00'):new Date();
  const fin=new Date(debut);fin.setDate(debut.getDate()+Number(duree)-1);
  const fmt=d=>d.toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'});
  const dateStr=new Date().toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'});
  const sortieLabel={autorisee:'Sorties autorisées',interdite:'Sorties interdites',autorisee_horaires:'Sorties autorisées aux heures habituelles (8h–12h / 14h–18h)'}[sortie]||'Sorties autorisées';
  const doc=new PDFDocument({margin:50,size:'A4'});
  res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="arret-maladie-${p?.nom||'patient'}.pdf"`});
  doc.pipe(res);
  docHeader(doc,u,dateStr);
  let y=docTitle(doc,"CERTIFICAT D'ARRÊT DE TRAVAIL",'#dc2626');
  y=docPatient(doc,p,y);
  doc.moveTo(50,y).lineTo(545,y).strokeColor('#f1f5f9').lineWidth(1).stroke();y+=16;
  const body=`Je soussigné(e), ${u?.prenom||''} ${u?.nom||''}, ${u?.specialite||'Médecin'}, certifie avoir examiné ce jour le(la) patient(e) susmentionné(e) et lui prescris un arrêt de travail pour raisons médicales.`;
  doc.fillColor('#334155').fontSize(10).font('Helvetica').text(body,50,y,{width:495});y+=doc.heightOfString(body,{width:495})+20;
  doc.rect(50,y,495,96).fill('#fef2f2').stroke('#fecaca');
  doc.fillColor('#991b1b').fontSize(10).font('Helvetica-Bold').text("Durée de l'arrêt de travail",70,y+12);
  doc.fillColor('#1e293b').fontSize(11).font('Helvetica-Bold').text(`Du ${fmt(debut)} au ${fmt(fin)}`,70,y+30);
  doc.fontSize(10).font('Helvetica').fillColor('#334155').text(`Soit ${duree} jour(s) consécutif(s)`,70,y+48);
  doc.fillColor('#374151').fontSize(10).font('Helvetica-Bold').text(sortieLabel,70,y+66);y+=116;
  doc.fillColor('#64748b').fontSize(9).font('Helvetica').text("Cet arrêt est susceptible de prolongation selon l'évolution clinique.",50,y,{width:495});
  docSig(doc,y);docFooter(doc);doc.end();
});

app.post('/api/consultations/:id/certificat/pdf', auth, (req,res)=>{
  const c=db.prepare('SELECT * FROM consultations WHERE id=?').get(req.params.id);
  if(!c) return res.status(404).json({error:'Non trouvée'});
  const p=db.prepare('SELECT * FROM patients WHERE id=?').get(c.patientId);
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(c.userId||req.user.id);
  const{objet='',observations=''}=req.body;
  const dateStr=new Date().toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'});
  const doc=new PDFDocument({margin:50,size:'A4'});
  res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="certificat-${p?.nom||'patient'}.pdf"`});
  doc.pipe(res);
  docHeader(doc,u,dateStr);
  let y=docTitle(doc,'CERTIFICAT MÉDICAL','#0369a1');
  y=docPatient(doc,p,y);
  doc.moveTo(50,y).lineTo(545,y).strokeColor('#f1f5f9').lineWidth(1).stroke();y+=16;
  const certText=`Je soussigné(e), ${u?.prenom||''} ${u?.nom||''}, ${u?.specialite||'Médecin'}, certifie avoir examiné ce jour ${p?.prenom||''} ${p?.nom||''} et établis le présent certificat médical${objet?` pour : ${objet}`:''}.`;
  doc.fillColor('#334155').fontSize(10).font('Helvetica').text(certText,50,y,{width:495});y+=doc.heightOfString(certText,{width:495})+20;
  if(observations){doc.fillColor('#1e293b').fontSize(10).font('Helvetica-Bold').text('Observations :',50,y);y+=16;doc.fillColor('#334155').fontSize(10).font('Helvetica').text(observations,50,y,{width:495});y+=doc.heightOfString(observations,{width:495})+20;}
  doc.fillColor('#64748b').fontSize(9).font('Helvetica').text("Certificat établi à la demande de l'intéressé(e) et remis en main propre.",50,y,{width:495});
  docSig(doc,y+16);docFooter(doc);doc.end();
});

app.post('/api/consultations/:id/adressage/pdf', auth, (req,res)=>{
  const c=db.prepare('SELECT * FROM consultations WHERE id=?').get(req.params.id);
  if(!c) return res.status(404).json({error:'Non trouvée'});
  const p=db.prepare('SELECT * FROM patients WHERE id=?').get(c.patientId);
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(c.userId||req.user.id);
  const{specialiste='',specialite='',motif=''}=req.body;
  const dateStr=new Date().toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'});
  const note=parseNote(c);
  const doc=new PDFDocument({margin:50,size:'A4'});
  res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="adressage-${p?.nom||'patient'}.pdf"`});
  doc.pipe(res);
  docHeader(doc,u,dateStr);
  let y=docTitle(doc,"LETTRE D'ADRESSAGE",'#059669');
  if(specialiste||specialite){
    doc.fillColor('#1e293b').fontSize(10).font('Helvetica-Bold').text(`À l'attention de ${specialiste||'Cher(e) Confrère(sse)'}`,50,y);
    if(specialite){doc.fontSize(9).font('Helvetica').fillColor('#475569').text(specialite,50,y+14);y+=36;}else y+=22;
  }
  y=docPatient(doc,p,y);
  doc.moveTo(50,y).lineTo(545,y).strokeColor('#f1f5f9').lineWidth(1).stroke();y+=16;
  doc.fillColor('#334155').fontSize(10).font('Helvetica').text('Cher(e) Confrère(sse),',50,y);y+=20;
  const age=p?.dateNaissance?Math.floor((Date.now()-new Date(p.dateNaissance+'T00:00:00'))/(365.25*24*3600*1000))+' an(s)':'';
  const intro=`Je vous adresse ${p?.prenom||''} ${p?.nom||''}${age?', '+age:''}${specialite?', pour avis et prise en charge en '+specialite:', pour avis spécialisé'}.`;
  doc.fillColor('#334155').fontSize(10).font('Helvetica').text(intro,50,y,{width:495});y+=doc.heightOfString(intro,{width:495})+12;
  if(note?.histoire){doc.fillColor('#1e293b').fontSize(10).font('Helvetica-Bold').text('Contexte clinique :',50,y);y+=14;const h=note.histoire.slice(0,400)+(note.histoire.length>400?'...':'');doc.fillColor('#334155').fontSize(10).font('Helvetica').text(h,50,y,{width:495});y+=doc.heightOfString(h,{width:495})+12;}
  if(motif){doc.fillColor('#1e293b').fontSize(10).font('Helvetica-Bold').text("Motif d'adressage :",50,y);y+=14;doc.fillColor('#334155').fontSize(10).font('Helvetica').text(motif,50,y,{width:495});y+=doc.heightOfString(motif,{width:495})+12;}
  if(p?.traitements&&p.traitements!=='Aucun'){doc.fillColor('#1e293b').fontSize(10).font('Helvetica-Bold').text('Traitement en cours :',50,y);y+=14;doc.fillColor('#334155').fontSize(10).font('Helvetica').text(p.traitements,50,y,{width:495});y+=doc.heightOfString(p.traitements,{width:495})+12;}
  const conclu="En vous remerciant de votre confraternelle collaboration, je reste à votre disposition pour tout renseignement complémentaire.\n\nCordialement,";
  doc.fillColor('#334155').fontSize(10).font('Helvetica').text(conclu,50,y,{width:495});y+=doc.heightOfString(conclu,{width:495})+10;
  doc.fillColor('#1e293b').font('Helvetica-Bold').text(`${u?.prenom||''} ${u?.nom||''}`,50,y);
  docSig(doc,y+30);docFooter(doc);doc.end();
});

// ═══════════════════════════════════════════════════════════════════════════════
// UTILISATEURS (liste pour invitations)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/users', auth, (req, res) => {
  res.json(db.prepare('SELECT id,nom,prenom,specialite FROM users WHERE id != ? ORDER BY nom').all(req.user.id));
});

// ═══════════════════════════════════════════════════════════════════════════════
// DISCUSSIONS & CHAT
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/patients/:id/discussions', auth, (req, res) => {
  const list = db.prepare(`
    SELECT d.*, u.nom as creatorNom, u.prenom as creatorPrenom,
      (SELECT COUNT(*) FROM messages m WHERE m.discussionId=d.id) as msgCount,
      (SELECT MAX(m.createdAt) FROM messages m WHERE m.discussionId=d.id) as lastAt,
      (SELECT m.contenu FROM messages m WHERE m.discussionId=d.id ORDER BY m.createdAt DESC LIMIT 1) as lastMsg
    FROM discussions d JOIN users u ON u.id=d.createdBy
    WHERE d.patientId=?
    ORDER BY COALESCE(lastAt,d.createdAt) DESC
  `).all(req.params.id);
  const result = list.map(d => {
    const participants = db.prepare(`SELECT u.id,u.nom,u.prenom,u.specialite FROM discussion_participants dp JOIN users u ON u.id=dp.userId WHERE dp.discussionId=?`).all(d.id);
    return { ...d, participants };
  });
  res.json(result);
});

app.post('/api/patients/:id/discussions', auth, (req, res) => {
  const { titre } = req.body;
  const id = randomUUID();
  db.prepare('INSERT INTO discussions (id,patientId,titre,createdBy) VALUES (?,?,?,?)').run(id, req.params.id, titre?.trim()||'Discussion de cas', req.user.id);
  db.prepare('INSERT INTO discussion_participants (discussionId,userId) VALUES (?,?)').run(id, req.user.id);
  res.json({ id });
});

app.get('/api/discussions/:id/messages', auth, (req, res) => {
  const part = db.prepare('SELECT 1 FROM discussion_participants WHERE discussionId=? AND userId=?').get(req.params.id, req.user.id);
  if (!part) return res.status(403).json({ error: 'Non participant à cette discussion' });
  const messages = db.prepare(`SELECT m.*,u.nom,u.prenom,u.specialite FROM messages m JOIN users u ON u.id=m.userId WHERE m.discussionId=? ORDER BY m.createdAt ASC`).all(req.params.id);
  const participants = db.prepare(`SELECT u.id,u.nom,u.prenom,u.specialite FROM discussion_participants dp JOIN users u ON u.id=dp.userId WHERE dp.discussionId=?`).all(req.params.id);
  res.json({ messages, participants });
});

app.post('/api/discussions/:id/messages', auth, (req, res) => {
  const part = db.prepare('SELECT 1 FROM discussion_participants WHERE discussionId=? AND userId=?').get(req.params.id, req.user.id);
  if (!part) return res.status(403).json({ error: 'Non participant' });
  const { contenu } = req.body;
  if (!contenu?.trim()) return res.status(400).json({ error: 'Message vide' });
  const id = randomUUID();
  db.prepare('INSERT INTO messages (id,discussionId,userId,contenu) VALUES (?,?,?,?)').run(id, req.params.id, req.user.id, contenu.trim());
  res.json(db.prepare(`SELECT m.*,u.nom,u.prenom,u.specialite FROM messages m JOIN users u ON u.id=m.userId WHERE m.id=?`).get(id));
});

app.post('/api/discussions/:id/upload', auth, upload.single('fichier'), (req, res) => {
  const part = db.prepare('SELECT 1 FROM discussion_participants WHERE discussionId=? AND userId=?').get(req.params.id, req.user.id);
  if (!part) { if(req.file) unlinkSync(req.file.path); return res.status(403).json({ error: 'Non participant' }); }
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  if (req.file.mimetype !== 'application/pdf') {
    unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Seuls les fichiers PDF sont acceptés' });
  }
  const id = randomUUID();
  const contenu = req.body.contenu?.trim() || '';
  db.prepare('INSERT INTO messages (id,discussionId,userId,contenu,fichier,fichierNom) VALUES (?,?,?,?,?,?)').run(id, req.params.id, req.user.id, contenu, req.file.filename, req.file.originalname);
  res.json(db.prepare('SELECT m.*,u.nom,u.prenom,u.specialite FROM messages m JOIN users u ON u.id=m.userId WHERE m.id=?').get(id));
});

app.get('/api/discussions/files/:filename', auth, (req, res) => {
  const msg = db.prepare('SELECT discussionId FROM messages WHERE fichier=?').get(req.params.filename);
  if (!msg) return res.status(404).json({ error: 'Fichier introuvable' });
  const part = db.prepare('SELECT 1 FROM discussion_participants WHERE discussionId=? AND userId=?').get(msg.discussionId, req.user.id);
  if (!part) return res.status(403).json({ error: 'Accès refusé' });
  res.sendFile(resolve(__dirname, 'uploads', req.params.filename));
});

app.post('/api/discussions/:id/invite', auth, (req, res) => {
  const part = db.prepare('SELECT 1 FROM discussion_participants WHERE discussionId=? AND userId=?').get(req.params.id, req.user.id);
  if (!part) return res.status(403).json({ error: 'Non participant' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId requis' });
  const already = db.prepare('SELECT 1 FROM discussion_participants WHERE discussionId=? AND userId=?').get(req.params.id, userId);
  if (!already) db.prepare('INSERT INTO discussion_participants (discussionId,userId) VALUES (?,?)').run(req.params.id, userId);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SÉRIE 2 — PHASE 2.1 : FLOW PATIENT
// ═══════════════════════════════════════════════════════════════════════════════

// Today's patient flow queue (all doctors, all appointments today)
app.get('/api/flow/today', auth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT a.*, p.nom, p.prenom, p.sexe, p.telephone, p.allergies,
           u.nom as medecinNom, u.prenom as medecinPrenom, u.specialite as medecinSpec
    FROM appointments a
    JOIN patients p ON a.patientId = p.id
    JOIN users u ON a.userId = u.id
    WHERE a.date = ?
    ORDER BY COALESCE(a.checkin_at, a.heure) ASC, a.heure ASC
  `).all(today);
  res.json(rows);
});

// Update appointment flow status
app.put('/api/appointments/:id/flow', auth, (req, res) => {
  const { statut_flow, priorite, notes_triage } = req.body;
  const now = new Date().toISOString();
  const timeFields = {
    arrive: 'checkin_at',
    tri: 'triage_at',
    en_salle: 'en_salle_at',
    en_consultation: 'en_consultation_at',
    sorti: 'sorti_at',
  };
  const timeCol = timeFields[statut_flow];
  let sql = `UPDATE appointments SET statut_flow=?`;
  const args = [statut_flow];
  if (timeCol) { sql += `,${timeCol}=COALESCE(${timeCol},?)`; args.push(now); }
  if (priorite !== undefined) { sql += `,priorite=?`; args.push(priorite); }
  if (notes_triage !== undefined) { sql += `,notes_triage=?`; args.push(notes_triage); }
  sql += ` WHERE id=?`; args.push(req.params.id);
  db.prepare(sql).run(...args);
  audit(req, `FLOW_${statut_flow?.toUpperCase()}`, 'appointment', req.params.id, `prio=${priorite||''}`);
  res.json(db.prepare('SELECT a.*, p.nom, p.prenom FROM appointments a JOIN patients p ON a.patientId=p.id WHERE a.id=?').get(req.params.id));
});

// Send reminder (email if SMTP configured)
app.post('/api/appointments/:id/reminder', auth, async (req, res) => {
  const appt = db.prepare('SELECT a.*, p.nom, p.prenom, p.email, p.telephone FROM appointments a JOIN patients p ON a.patientId=p.id WHERE a.id=?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'RDV introuvable' });
  const dr = db.prepare('SELECT nom, prenom FROM users WHERE id=?').get(req.user.id);
  if (mailer && appt.email) {
    try {
      await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: appt.email,
        subject: `Rappel de rendez-vous — ${appt.date} à ${appt.heure}`,
        text: `Bonjour ${appt.prenom} ${appt.nom},\n\nVous avez un rendez-vous le ${appt.date} à ${appt.heure} avec Dr. ${dr.prenom} ${dr.nom}.\nMotif : ${appt.motif||'Consultation'}.\n\nMerci de confirmer votre présence.\n\nMediVox`,
      });
      audit(req, 'SEND_REMINDER', 'appointment', req.params.id, `email:${appt.email}`);
      res.json({ ok: true, channel: 'email' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  } else {
    audit(req, 'REMINDER_LOGGED', 'appointment', req.params.id, `no-smtp: ${appt.telephone}`);
    res.json({ ok: true, channel: 'log', note: 'SMTP non configuré — rappel journalisé' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SÉRIE 2 — PHASE 2.2 : ORDRES MÉDICAUX
// ═══════════════════════════════════════════════════════════════════════════════

const ORDRE_STATUTS = ['demande', 'preleve', 'en_cours', 'valide', 'rendu'];
const ORDRE_TIME_COLS = { preleve: 'preleve_at', en_cours: 'en_cours_at', valide: 'valide_at', rendu: 'rendu_at' };

app.post('/api/ordres', auth, (req, res) => {
  const { consultationId, patientId, type, catalogue, priorite, notes } = req.body;
  if (!patientId || !type) return res.status(400).json({ error: 'patientId et type requis' });
  const id = randomUUID();
  db.prepare(`INSERT INTO ordres_medicaux (id,consultationId,patientId,userId,type,catalogue,priorite,notes) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, consultationId||null, patientId, req.user.id, type, JSON.stringify(catalogue||[]), priorite||'routine', notes||'');
  audit(req, 'CREATE_ORDRE', 'ordre', id, `type=${type} prio=${priorite}`);
  res.json(db.prepare('SELECT * FROM ordres_medicaux WHERE id=?').get(id));
});

app.get('/api/patients/:id/ordres', auth, (req, res) => {
  const rows = db.prepare(`SELECT o.*, u.nom as drNom, u.prenom as drPrenom FROM ordres_medicaux o JOIN users u ON u.id=o.userId WHERE o.patientId=? ORDER BY o.createdAt DESC`).all(req.params.id);
  res.json(rows.map(o => ({ ...o, catalogue: JSON.parse(o.catalogue||'[]'), resultats: o.resultats ? JSON.parse(o.resultats) : null })));
});

app.get('/api/consultations/:id/ordres', auth, (req, res) => {
  const rows = db.prepare(`SELECT o.*, u.nom as drNom, u.prenom as drPrenom FROM ordres_medicaux o JOIN users u ON u.id=o.userId WHERE o.consultationId=? ORDER BY o.createdAt DESC`).all(req.params.id);
  res.json(rows.map(o => ({ ...o, catalogue: JSON.parse(o.catalogue||'[]'), resultats: o.resultats ? JSON.parse(o.resultats) : null })));
});

app.put('/api/ordres/:id/statut', auth, (req, res) => {
  const { statut } = req.body;
  if (!ORDRE_STATUTS.includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
  const now = new Date().toISOString();
  const col = ORDRE_TIME_COLS[statut];
  let sql = `UPDATE ordres_medicaux SET statut=?,updatedAt=?`;
  const args = [statut, now];
  if (col) { sql += `,${col}=COALESCE(${col},?)`; args.push(now); }
  sql += ` WHERE id=?`; args.push(req.params.id);
  db.prepare(sql).run(...args);
  audit(req, `ORDRE_${statut.toUpperCase()}`, 'ordre', req.params.id);
  res.json(db.prepare('SELECT * FROM ordres_medicaux WHERE id=?').get(req.params.id));
});

app.put('/api/ordres/:id/resultats', auth, (req, res) => {
  const { resultats, notes } = req.body;
  const now = new Date().toISOString();
  db.prepare(`UPDATE ordres_medicaux SET resultats=?,notes=COALESCE(?,notes),statut='rendu',rendu_at=COALESCE(rendu_at,?),valide_at=COALESCE(valide_at,?),updatedAt=? WHERE id=?`)
    .run(JSON.stringify(resultats), notes||null, now, now, now, req.params.id);
  audit(req, 'ORDRE_RESULTATS', 'ordre', req.params.id);
  res.json(db.prepare('SELECT * FROM ordres_medicaux WHERE id=?').get(req.params.id));
});

// ═══════════════════════════════════════════════════════════════════════════════
// SÉRIE 2 — PHASE 2.3 : TRAÇABILITÉ & DOSSIER STATUS
// ═══════════════════════════════════════════════════════════════════════════════

// Patient journey (timestamped steps from appointments today or recent)
app.get('/api/patients/:id/parcours', auth, (req, res) => {
  const appts = db.prepare(`
    SELECT a.date, a.heure, a.statut_flow, a.priorite, a.checkin_at, a.triage_at,
           a.en_salle_at, a.en_consultation_at, a.sorti_at, a.motif, a.notes_triage,
           u.nom as drNom, u.prenom as drPrenom
    FROM appointments a JOIN users u ON u.id=a.userId
    WHERE a.patientId=? ORDER BY a.date DESC, a.heure DESC LIMIT 10
  `).all(req.params.id);
  const consultations = db.prepare(`
    SELECT c.id, c.date, c.motif, c.statut, c.heureDebut, c.heureFin,
           u.nom as drNom, u.prenom as drPrenom
    FROM consultations c JOIN users u ON u.id=c.userId
    WHERE c.patientId=? ORDER BY c.date DESC LIMIT 10
  `).all(req.params.id);
  const ordres = db.prepare(`SELECT id, type, priorite, statut, catalogue, demande_at, rendu_at FROM ordres_medicaux WHERE patientId=? ORDER BY createdAt DESC LIMIT 20`).all(req.params.id);
  res.json({
    appointments: appts,
    consultations,
    ordres: ordres.map(o => ({ ...o, catalogue: JSON.parse(o.catalogue || '[]') })),
  });
});

// Dossier completeness check
app.get('/api/patients/:id/dossier-status', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM patients WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Patient introuvable' });
  const checks = [
    { key: 'identite', label: 'Identité complète', ok: !!(p.nom && p.prenom && p.dateNaissance && p.sexe) },
    { key: 'contact', label: 'Contact', ok: !!(p.telephone || p.email) },
    { key: 'assurance', label: 'Assurance', ok: !!(p.typeAssurance && p.numAssurance) },
    { key: 'antecedents', label: 'Antécédents', ok: !!(p.antecedents) },
    { key: 'allergies', label: 'Allergies renseignées', ok: !!(p.allergies) },
    { key: 'groupe_sanguin', label: 'Groupe sanguin', ok: !!(p.groupe_sanguin) },
    { key: 'medecin_referent', label: 'Médecin référent', ok: !!(p.medecin_referent) },
  ];
  const score = Math.round(checks.filter(c => c.ok).length / checks.length * 100);
  const lastConsult = db.prepare('SELECT date FROM consultations WHERE patientId=? ORDER BY date DESC LIMIT 1').get(req.params.id);
  const pendingOrdres = db.prepare("SELECT COUNT(*) as n FROM ordres_medicaux WHERE patientId=? AND statut NOT IN ('rendu','valide')").get(req.params.id);
  res.json({ score, checks, lastConsult: lastConsult?.date || null, pendingOrdres: pendingOrdres.n });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SÉRIE 3 — PHASE 3.1 : NOMENCLATURE & LIGNES FACTURABLES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/nomenclature', auth, (req, res) => {
  const q = req.query.q ? `%${req.query.q}%` : null;
  const rows = q
    ? db.prepare("SELECT * FROM nomenclature WHERE libelle LIKE ? OR code LIKE ? OR categorie LIKE ? ORDER BY categorie,libelle").all(q, q, q)
    : db.prepare("SELECT * FROM nomenclature ORDER BY categorie,libelle").all();
  res.json(rows);
});

// Auto-generate billable lines from a validated consultation
app.post('/api/consultations/:id/auto-facturation', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM consultations WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Consultation introuvable' });
  const patient = db.prepare('SELECT * FROM patients WHERE id=?').get(c.patientId);
  const dr = db.prepare('SELECT specialite FROM users WHERE id=?').get(c.userId);
  const note = c.noteJson ? (() => { try { return JSON.parse(decrypt(c.noteJson)); } catch { return null; } })() : null;

  // Determine base consultation code
  const isSpec = dr?.specialite && !['Médecine générale','Généraliste'].includes(dr.specialite);
  const baseCode = isSpec ? 'CS' : 'C';
  const baseNom = db.prepare('SELECT * FROM nomenclature WHERE code=?').get(baseCode);

  const created = [];
  const existingCodes = db.prepare('SELECT codeActe FROM lignes_facturables WHERE consultationId=?').all(c.id).map(r => r.codeActe);

  const addLine = (code, libelle, montant, source = 'auto') => {
    if (existingCodes.includes(code)) return;
    const id = randomUUID();
    db.prepare('INSERT INTO lignes_facturables (id,consultationId,patientId,userId,codeActe,libelleActe,montant,source) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, c.id, c.patientId, req.user.id, code, libelle, montant, source);
    created.push({ id, code, libelle, montant, source });
  };

  // Add base consultation line
  addLine(baseCode, baseNom?.libelle || 'Consultation', baseNom?.montant_base || 15000);

  // Scan note for acts keywords — word-boundary matching to avoid false positives
  if (note) {
    // Scan only relevant clinical fields, not the entire JSON (avoids matching field names)
    const clinicalText = [
      note.motif, note.anamnese, note.histoire_maladie,
      note.examen_physique, note.examen_clinique,
      note.conclusion, note.diagnostic, note.plan_therapeutique,
      note.actes_realises, note.gestes, note.soins,
      note.bilan, note.examens_demandes, note.paraclinique,
      note.observations, note.evolution,
      // also scan prescription drug names for implied acts
      Array.isArray(note.prescriptions)
        ? note.prescriptions.map(p => p.medicament||'').join(' ')
        : '',
    ].filter(Boolean).join(' ').toLowerCase();

    // Helper: match keyword with word boundaries
    // Short words (≤4 chars): strict boundary required to avoid substring matches
    // Longer words: simple substring (medical terms rarely embed in other words)
    const match = (keywords) => keywords.some(kw => {
      const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = kw.length <= 5
        ? new RegExp(`(?<![a-zàâäéèêëîïôùûü])${esc}(?![a-zàâäéèêëîïôùûü])`, 'i')
        : new RegExp(esc, 'i');
      return re.test(clinicalText);
    });

    const ACTS = [
      // ── Chirurgie ambulatoire ──────────────────────────────────────────────
      { code:'PC1', libelle:'Suture simple (< 5 points)', montant:10000,
        kw:['suture','sutures','suturer','point de suture','points de suture','plaie suturée','plaie suturée','fils de suture'] },
      { code:'PC2', libelle:'Suture complexe (≥ 5 points)', montant:18000,
        kw:['suture complexe','sutures multiples','plan profond','plan musculaire'] },
      { code:'PC3', libelle:'Incision / drainage d\'abcès', montant:12000,
        kw:['abcès','abces','incision','drainage','drainé','ponction évacuatrice','débridement'] },
      // ── Soins infirmiers ───────────────────────────────────────────────────
      { code:'S1', libelle:'Pansement simple', montant:3000,
        kw:['pansement','pansements','soin de plaie','soins de plaie','refaire le pansement','pansé'] },
      { code:'I1', libelle:'Injection intramusculaire', montant:2000,
        kw:['injection im','intramusculaire','voie im','administré en im','administrée en im'] },
      { code:'I2', libelle:'Injection intraveineuse directe', montant:3000,
        kw:['injection iv','injection intraveineuse','voie iv','ivd','bolus iv'] },
      { code:'I3', libelle:'Pose de perfusion', montant:5000,
        kw:['perfusion','perf','soluté','ringer','sérum glucosé','réhydratation iv','voie veineuse','vvp'] },
      { code:'PR', libelle:'Prise de sang / prélèvement', montant:3000,
        kw:['prise de sang','prélèvement sanguin','prélevé','bilan sanguin','prélèvement veineux'] },
      // ── Imagerie ──────────────────────────────────────────────────────────
      { code:'ECG', libelle:'ECG 12 dérivations', montant:12000,
        kw:['ecg','électrocardiogramme','electrocardiogramme','tracé cardiaque','tracé ecg'] },
      { code:'RX1', libelle:'Radiographie pulmonaire', montant:20000,
        kw:['radio pulmonaire','radiographie pulmonaire','rx thorax','radiographie du thorax','rx pulmonaire','cliché thoracique','rx du poumon'] },
      { code:'RX2', libelle:'Radiographie osseuse / articulaire', montant:18000,
        kw:['radio osseuse','radiographie osseuse','rx du genou','rx du pied','rx du poignet','rx de la cheville','rx de la hanche','rx vertébrale','radio articulaire'] },
      { code:'ECH1', libelle:'Échographie abdominale', montant:35000,
        kw:['échographie abdominale','echo abdominale','échographie de l\'abdomen','echo abdo','us abdominal'] },
      { code:'ECH2', libelle:'Échographie obstétricale', montant:30000,
        kw:['échographie obstétricale','echo obstétricale','échographie de grossesse','datation','morphologie foetale','biométrie foetale'] },
      { code:'ECH3', libelle:'Échographie cardiaque', montant:45000,
        kw:['échographie cardiaque','echo cardiaque','echocardiographie','ETT','fraction d\'éjection'] },
      { code:'ECH4', libelle:'Écho-Doppler vasculaire', montant:40000,
        kw:['doppler','écho-doppler','echo doppler','angiodoppler','TSA','artères rénales'] },
      // ── Biologie ──────────────────────────────────────────────────────────
      { code:'NFS', libelle:'Numération formule sanguine', montant:8000,
        kw:['nfs','numération formule','formule sanguine','hémogramme','numération globulaire','gb','gr','plaquettes'] },
      { code:'GLY', libelle:'Glycémie à jeun', montant:3000,
        kw:['glycémie','glycemie','dextro','glycosurie','glucose sanguin','bilan glucidique'] },
      { code:'HBA1C', libelle:'Hémoglobine glyquée', montant:15000,
        kw:['hba1c','hémoglobine glyquée','hemoglobine glyquee','glycémie à 3 mois'] },
      { code:'BHC', libelle:'Bilan hépatique', montant:25000,
        kw:['bilan hépatique','transaminases','asat','alat','bilirubine','gamma gt','phosphatases alcalines','bilan foie'] },
      { code:'LIPID', libelle:'Bilan lipidique', montant:12000,
        kw:['bilan lipidique','cholestérol','triglycérides','ldl','hdl','lipides'] },
      { code:'CREA', libelle:'Créatinine / urée', montant:8000,
        kw:['créatinine','creatinine','urée','uree','bilan rénal','fonction rénale','clairance'] },
      { code:'GE', libelle:'GE / TDR paludisme', montant:5000,
        kw:['goutte épaisse','tdr paludisme','tdr palu','test paludisme','frottis sanguin','plasmodium','malaria','paludisme','gouttelette épaisse'] },
      { code:'VIH', libelle:'Test VIH', montant:5000,
        kw:['vih','hiv','sérologie vih','test vih','dépistage vih','charge virale'] },
      { code:'TPHA', libelle:'Sérologie syphilis', montant:6000,
        kw:['tpha','vdrl','syphilis','sérologie syphilis','tréponème'] },
      { code:'HBS', libelle:'Ag HBs / sérologie hépatite B', montant:8000,
        kw:['ag hbs','antigène hbs','hépatite b','hbsag','sérologie hépatite','antigène hb'] },
      { code:'URIN', libelle:'ECBU / bandelette urinaire', montant:6000,
        kw:['ecbu','bandelette urinaire','examen cytobactériologique','infection urinaire confirmée','analyse d\'urine','protéinurie'] },
      // ── Spécialités ───────────────────────────────────────────────────────
      { code:'VAC', libelle:'Vaccination', montant:3000,
        kw:['vaccination','vaccin','vacciné','rappel vaccinal','immunisation'] },
      { code:'SPI', libelle:'Spirométrie / EFR', montant:15000,
        kw:['spirométrie','spirometrie','efr','exploration fonctionnelle','vems','capacité vitale','tiffeneau'] },
      { code:'ACC', libelle:'Accouchement eutocique', montant:80000,
        kw:['accouchement','accouché','parturiente','délivrance','expulsion','épisiotomie','voie basse'] },
      { code:'CPN', libelle:'Consultation prénatale', montant:15000,
        kw:['consultation prénatale','cpn','prénatal','gestante','grossesse en cours','suivi de grossesse'] },
      { code:'CS-URG', libelle:'Consultation urgence', montant:30000,
        kw:['urgence','urgences','admis en urgence','pris en charge en urgence'] },
    ];

    for (const { kw, code, libelle, montant } of ACTS) {
      if (match(kw)) addLine(code, libelle, montant);
    }

    // ── Prescription-based inference ─────────────────────────────────────────
    // If antiparasitic drugs prescribed, likely a GE was done
    const rx = Array.isArray(note.prescriptions) ? note.prescriptions.map(p=>(p.medicament||'').toLowerCase()).join(' ') : '';
    if (!existingCodes.includes('GE') && /coartem|artemether|lumefantrine|artesunate|quinine|chloroquine/i.test(rx)) {
      addLine('GE', 'GE / TDR paludisme (déduit de l\'ordonnance)', 5000);
    }
    // Anticoagulants → likely IV access
    if (!existingCodes.includes('I3') && /héparine|enoxaparine|lovenox/i.test(rx)) {
      addLine('I3', 'Pose de perfusion (déduit de l\'ordonnance)', 5000);
    }
  }

  // Add ordres médicaux linked to this consultation as suggestions
  const ordres = db.prepare("SELECT * FROM ordres_medicaux WHERE consultationId=? AND statut IN ('valide','rendu')").all(c.id);
  for (const o of ordres) {
    const cat = o.type === 'labo' ? 'Biologie' : 'Imagerie';
    const items = JSON.parse(o.catalogue || '[]');
    const label = items.slice(0,3).join(', ') + (items.length > 3 ? '…' : '');
    addLine(null, `[${cat}] ${label}`, 0, 'ordre');
  }

  audit(req, 'AUTO_FACTURATION', 'consultation', c.id, `${created.length} lignes créées`);
  res.json({ created, total: created.length });
});

app.get('/api/lignes-facturables', auth, (req, res) => {
  const { statut, patientId } = req.query;
  let sql = `SELECT lf.*, p.nom, p.prenom, p.typeAssurance, p.numAssurance,
               c.date as consultDate, c.motif
             FROM lignes_facturables lf
             JOIN patients p ON p.id = lf.patientId
             LEFT JOIN consultations c ON c.id = lf.consultationId
             WHERE lf.userId = ?`;
  const args = [req.user.id];
  if (statut) { sql += ' AND lf.statut = ?'; args.push(statut); }
  if (patientId) { sql += ' AND lf.patientId = ?'; args.push(patientId); }
  sql += ' ORDER BY lf.createdAt DESC LIMIT 200';
  res.json(db.prepare(sql).all(...args));
});

app.get('/api/patients/:id/lignes-facturables', auth, (req, res) => {
  res.json(db.prepare(`SELECT lf.*, c.date as consultDate, c.motif FROM lignes_facturables lf LEFT JOIN consultations c ON c.id=lf.consultationId WHERE lf.patientId=? ORDER BY lf.createdAt DESC`).all(req.params.id));
});

app.get('/api/consultations/:id/lignes-facturables', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM lignes_facturables WHERE consultationId=? ORDER BY createdAt ASC').all(req.params.id));
});

app.post('/api/lignes-facturables', auth, (req, res) => {
  const { consultationId, patientId, codeActe, libelleActe, montant, quantite, notes } = req.body;
  if (!patientId || !libelleActe) return res.status(400).json({ error: 'patientId et libelleActe requis' });
  const id = randomUUID();
  db.prepare('INSERT INTO lignes_facturables (id,consultationId,patientId,userId,codeActe,libelleActe,montant,quantite,notes,source) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, consultationId||null, patientId, req.user.id, codeActe||null, libelleActe, montant||0, quantite||1, notes||'', 'manuel');
  audit(req, 'CREATE_LIGNE', 'ligne_facturable', id);
  res.json(db.prepare('SELECT * FROM lignes_facturables WHERE id=?').get(id));
});

app.put('/api/lignes-facturables/:id', auth, (req, res) => {
  const { codeActe, libelleActe, montant, quantite, statut, notes } = req.body;
  db.prepare(`UPDATE lignes_facturables SET codeActe=COALESCE(?,codeActe),libelleActe=COALESCE(?,libelleActe),montant=COALESCE(?,montant),quantite=COALESCE(?,quantite),statut=COALESCE(?,statut),notes=COALESCE(?,notes),updatedAt=datetime('now') WHERE id=? AND userId=?`)
    .run(codeActe, libelleActe, montant, quantite, statut, notes, req.params.id, req.user.id);
  audit(req, 'UPDATE_LIGNE', 'ligne_facturable', req.params.id, `statut=${statut}`);
  res.json(db.prepare('SELECT * FROM lignes_facturables WHERE id=?').get(req.params.id));
});

app.delete('/api/lignes-facturables/:id', auth, (req, res) => {
  db.prepare('DELETE FROM lignes_facturables WHERE id=? AND userId=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// Facturation alerts: non-billed acts, blocking files
app.get('/api/facturation/alertes', auth, (req, res) => {
  const uid = req.user.id;
  // Validated consultations with no billable lines
  const nonFactures = db.prepare(`
    SELECT c.id, c.date, c.motif, p.nom, p.prenom, p.typeAssurance
    FROM consultations c
    JOIN patients p ON p.id = c.patientId
    WHERE c.userId=? AND c.statut='validee'
      AND NOT EXISTS (SELECT 1 FROM lignes_facturables lf WHERE lf.consultationId=c.id)
    ORDER BY c.date DESC LIMIT 30
  `).all(uid);

  // Lignes non facturées older than 7 days
  const enRetard = db.prepare(`
    SELECT lf.*, p.nom, p.prenom FROM lignes_facturables lf JOIN patients p ON p.id=lf.patientId
    WHERE lf.userId=? AND lf.statut='non_facture'
      AND lf.createdAt < datetime('now','-7 days')
    ORDER BY lf.createdAt ASC LIMIT 30
  `).all(uid);

  // Patients with missing assurance info but have billable lines
  const assuranceManquante = db.prepare(`
    SELECT DISTINCT p.id, p.nom, p.prenom, p.typeAssurance, p.numAssurance
    FROM lignes_facturables lf JOIN patients p ON p.id=lf.patientId
    WHERE lf.userId=? AND (p.typeAssurance IS NULL OR p.typeAssurance='' OR p.numAssurance IS NULL OR p.numAssurance='')
    LIMIT 20
  `).all(uid);

  // Rejected dossiers needing action
  const rejets = db.prepare(`
    SELECT da.*, p.nom, p.prenom FROM dossiers_assurance da JOIN patients p ON p.id=da.patientId
    WHERE da.userId=? AND da.statut='rejete' AND (da.actionCorrective IS NULL OR da.actionCorrective='')
    ORDER BY da.createdAt DESC LIMIT 20
  `).all(uid);

  res.json({ nonFactures, enRetard, assuranceManquante, rejets });
});

// Facturation dashboard
app.get('/api/facturation/dashboard', auth, (req, res) => {
  const uid = req.user.id;
  const now = new Date().toISOString().slice(0, 7); // YYYY-MM

  const byStatut = db.prepare(`SELECT statut, COUNT(*) as n, COALESCE(SUM(montant*quantite),0) as total FROM lignes_facturables WHERE userId=? GROUP BY statut`).all(uid);
  const byCaisse = db.prepare(`SELECT da.caisse, da.statut, COUNT(*) as n, COALESCE(SUM(da.montantDemande),0) as demande, COALESCE(SUM(da.montantAccorde),0) as accorde FROM dossiers_assurance da WHERE da.userId=? GROUP BY da.caisse, da.statut`).all(uid);

  // Délai moyen acte→facture (non_facture→facture) in days
  const delaiMoyen = db.prepare(`
    SELECT AVG(CAST((julianday(updatedAt) - julianday(createdAt)) AS REAL)) as jours
    FROM lignes_facturables WHERE userId=? AND statut IN ('facture','encaisse')
  `).get(uid);

  // Monthly totals last 6 months
  const monthly = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    const ym = d.toISOString().slice(0, 7);
    const row = db.prepare(`SELECT COALESCE(SUM(montant*quantite),0) as t FROM lignes_facturables WHERE userId=? AND statut IN ('facture','encaisse') AND strftime('%Y-%m',updatedAt)=?`).get(uid, ym);
    monthly.push({ mois: ym, total: row.t });
  }

  const dossiers = {
    constitution: db.prepare("SELECT COUNT(*) as n FROM dossiers_assurance WHERE userId=? AND statut='constitution'").get(uid).n,
    soumis: db.prepare("SELECT COUNT(*) as n FROM dossiers_assurance WHERE userId=? AND statut='soumis'").get(uid).n,
    accepte: db.prepare("SELECT COUNT(*) as n FROM dossiers_assurance WHERE userId=? AND statut='accepte'").get(uid).n,
    rejete: db.prepare("SELECT COUNT(*) as n FROM dossiers_assurance WHERE userId=? AND statut='rejete'").get(uid).n,
    paye: db.prepare("SELECT COUNT(*) as n FROM dossiers_assurance WHERE userId=? AND statut='paye'").get(uid).n,
  };

  res.json({ byStatut, byCaisse, delaiMoyen: delaiMoyen?.jours || null, monthly, dossiers });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SÉRIE 3 — PHASE 3.2 : WORKFLOW ASSURANCES
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/dossiers-assurance', auth, (req, res) => {
  const { patientId, caisse, montantDemande, consultationIds, pieces, notes } = req.body;
  if (!patientId || !caisse) return res.status(400).json({ error: 'patientId et caisse requis' });
  const id = randomUUID();
  db.prepare('INSERT INTO dossiers_assurance (id,patientId,userId,caisse,montantDemande,consultationIds,pieces,notes) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, patientId, req.user.id, caisse, montantDemande||0, JSON.stringify(consultationIds||[]), JSON.stringify(pieces||[]), notes||'');
  audit(req, 'CREATE_DOSSIER_ASSURANCE', 'dossier_assurance', id, `caisse=${caisse}`);
  res.json(db.prepare('SELECT * FROM dossiers_assurance WHERE id=?').get(id));
});

app.get('/api/dossiers-assurance', auth, (req, res) => {
  const { statut, caisse } = req.query;
  let sql = `SELECT da.*, p.nom, p.prenom, p.typeAssurance, p.numAssurance FROM dossiers_assurance da JOIN patients p ON p.id=da.patientId WHERE da.userId=?`;
  const args = [req.user.id];
  if (statut) { sql += ' AND da.statut=?'; args.push(statut); }
  if (caisse) { sql += ' AND da.caisse=?'; args.push(caisse); }
  sql += ' ORDER BY da.createdAt DESC';
  res.json(db.prepare(sql).all(...args).map(d => ({ ...d, pieces: JSON.parse(d.pieces||'[]'), consultationIds: JSON.parse(d.consultationIds||'[]') })));
});

app.get('/api/patients/:id/dossiers-assurance', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM dossiers_assurance WHERE patientId=? ORDER BY createdAt DESC').all(req.params.id);
  res.json(rows.map(d => ({ ...d, pieces: JSON.parse(d.pieces||'[]'), consultationIds: JSON.parse(d.consultationIds||'[]') })));
});

app.put('/api/dossiers-assurance/:id', auth, (req, res) => {
  const { statut, reference, montantDemande, montantAccorde, motifRejet, actionCorrective, pieces, notes, dateSubmission, dateRetour, datePaiement } = req.body;
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM dossiers_assurance WHERE id=? AND userId=?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Dossier introuvable' });

  const piecesJson = pieces !== undefined ? JSON.stringify(pieces) : existing.pieces;
  db.prepare(`UPDATE dossiers_assurance SET
    statut=COALESCE(?,statut), reference=COALESCE(?,reference), montantDemande=COALESCE(?,montantDemande),
    montantAccorde=COALESCE(?,montantAccorde), motifRejet=COALESCE(?,motifRejet),
    actionCorrective=COALESCE(?,actionCorrective), pieces=?, notes=COALESCE(?,notes),
    dateSubmission=COALESCE(?,dateSubmission), dateRetour=COALESCE(?,dateRetour),
    datePaiement=COALESCE(?,datePaiement), updatedAt=?
    WHERE id=? AND userId=?`)
    .run(statut, reference, montantDemande, montantAccorde, motifRejet, actionCorrective,
      piecesJson, notes, dateSubmission, dateRetour, datePaiement, now, req.params.id, req.user.id);
  audit(req, `DOSSIER_${(statut||'UPDATE').toUpperCase()}`, 'dossier_assurance', req.params.id);
  const d = db.prepare('SELECT * FROM dossiers_assurance WHERE id=?').get(req.params.id);
  res.json({ ...d, pieces: JSON.parse(d.pieces||'[]'), consultationIds: JSON.parse(d.consultationIds||'[]') });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SÉRIE 3 — PHASE 3.3 : MOTEUR DE COMPLÉTUDE
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/consultations/:id/completude', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM consultations WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Consultation introuvable' });
  const p = db.prepare('SELECT * FROM patients WHERE id=?').get(c.patientId);
  const note = c.noteJson ? (() => { try { return JSON.parse(decrypt(c.noteJson)); } catch { return null; } })() : null;
  const constantes = c.constantes ? (() => { try { return JSON.parse(c.constantes); } catch { return null; } })() : null;
  const lignes = db.prepare('SELECT * FROM lignes_facturables WHERE consultationId=?').all(c.id);
  const dossiers = db.prepare("SELECT * FROM dossiers_assurance WHERE patientId=? AND statut NOT IN ('rejete')", ).all(c.patientId);

  const clinical = [
    { key:'motif', label:'Motif documenté', ok:!!(c.motif?.trim()), blocking:true },
    { key:'note', label:'Note clinique générée', ok:!!note, blocking:true },
    { key:'note_validee', label:'Note validée par le médecin', ok:c.statut==='validee', blocking:true },
    { key:'cim10', label:'Code CIM-10 renseigné', ok:!!(note?.cim10?.code), blocking:false },
    { key:'constantes', label:'Constantes vitales enregistrées', ok:!!(constantes && Object.values(constantes).some(v=>v!==''&&v!=null)), blocking:false },
    { key:'conduite', label:'Conduite à tenir documentée', ok:!!(note?.conduite?.trim()), blocking:false },
  ];

  const admin = [
    { key:'identite', label:'Identité patient complète', ok:!!(p?.nom&&p?.prenom&&p?.dateNaissance), blocking:true },
    { key:'contact', label:'Contact (tél ou email)', ok:!!(p?.telephone||p?.email), blocking:false },
    { key:'assurance_type', label:'Type d\'assurance renseigné', ok:!!(p?.typeAssurance&&p?.typeAssurance.trim()), blocking:true },
    { key:'assurance_num', label:'Numéro d\'assurance renseigné', ok:!!(p?.numAssurance&&p?.numAssurance.trim()), blocking:true },
    { key:'groupe_sanguin', label:'Groupe sanguin', ok:!!(p?.groupe_sanguin), blocking:false },
  ];

  const facturation = [
    { key:'lignes', label:'Ligne(s) facturable(s) créée(s)', ok:lignes.length>0, blocking:true },
    { key:'montant', label:'Montant renseigné', ok:lignes.some(l=>l.montant>0), blocking:true },
    { key:'code_acte', label:'Code acte (nomenclature)', ok:lignes.some(l=>l.codeActe), blocking:false },
    { key:'non_facture', label:'Aucun acte en attente de facturation', ok:lignes.every(l=>l.statut!=='non_facture'), blocking:false },
  ];

  const encaissement = [
    { key:'dossier_cree', label:'Dossier assurance constitué', ok:dossiers.length>0, blocking:!!(p?.typeAssurance&&p.typeAssurance!=='Aucune'&&p.typeAssurance!=='Particulier') },
    { key:'dossier_soumis', label:'Dossier soumis à la caisse', ok:dossiers.some(d=>['soumis','en_attente','accepte','paye'].includes(d.statut)), blocking:false },
    { key:'pas_rejet', label:'Aucun rejet en attente d\'action', ok:!db.prepare("SELECT 1 FROM dossiers_assurance WHERE patientId=? AND statut='rejete' AND (actionCorrective IS NULL OR actionCorrective='')").get(c.patientId), blocking:false },
  ];

  const allChecks = [...clinical, ...admin, ...facturation, ...encaissement];
  const score = Math.round(allChecks.filter(c=>c.ok).length / allChecks.length * 100);
  const blockers = allChecks.filter(c=>!c.ok&&c.blocking);

  res.json({ score, blockers, clinical, admin, facturation, encaissement });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SÉRIE 4 — INTELLIGENCE ET PILOTAGE
// ═══════════════════════════════════════════════════════════════════════════════

// ── Phase 4.1 — Dashboard médico-économique ───────────────────────────────────
app.get('/api/analytics/medico-eco', auth, (req, res) => {
  const uid = req.user.id;

  // Revenue by nomenclature category
  const byCategorie = db.prepare(`
    SELECT n.categorie, SUM(lf.montant * lf.quantite) as ca, COUNT(*) as actes
    FROM lignes_facturables lf
    LEFT JOIN nomenclature n ON n.code = lf.codeActe
    WHERE lf.userId=? AND lf.statut != 'annule'
    GROUP BY n.categorie ORDER BY ca DESC
  `).all(uid);

  // Revenue by billing status
  const byStatut = db.prepare(`
    SELECT statut, SUM(montant*quantite) as total, COUNT(*) as n
    FROM lignes_facturables WHERE userId=? GROUP BY statut
  `).all(uid);

  // Unbilled acts (non_facture lines with montant)
  const nonFacture = db.prepare(`
    SELECT SUM(montant*quantite) as total, COUNT(*) as n
    FROM lignes_facturables WHERE userId=? AND statut='non_facture'
  `).get(uid);

  // Payment mix by caisse (from dossiers assurance)
  const byCaisse = db.prepare(`
    SELECT caisse, COUNT(*) as n, SUM(montantDemande) as montant
    FROM dossiers_assurance WHERE userId=? GROUP BY caisse ORDER BY n DESC
  `).all(uid);

  // Conversion: consults with labo ordres / total consults
  const totalConsults = db.prepare("SELECT COUNT(*) as n FROM consultations WHERE userId=?").get(uid)?.n || 0;
  const withLabo = db.prepare("SELECT COUNT(DISTINCT consultationId) as n FROM ordres_medicaux WHERE userId=? AND type='labo'").get(uid)?.n || 0;
  const withImagerie = db.prepare("SELECT COUNT(DISTINCT consultationId) as n FROM ordres_medicaux WHERE userId=? AND type='imagerie'").get(uid)?.n || 0;
  const withFacturation = db.prepare("SELECT COUNT(DISTINCT consultationId) as n FROM lignes_facturables WHERE userId=?").get(uid)?.n || 0;

  // Productivity by day-of-week (0=Sun..6=Sat)
  const byDow = db.prepare(`
    SELECT CAST(strftime('%w', date) AS INTEGER) as dow, COUNT(*) as n
    FROM consultations WHERE userId=? GROUP BY dow ORDER BY dow
  `).all(uid);

  // Average wait times by flow step (across all appointments with timestamps)
  const waitTimes = db.prepare(`
    SELECT
      AVG(CASE WHEN checkin_at IS NOT NULL AND date IS NOT NULL
        THEN (julianday(checkin_at) - julianday(date)) * 1440 ELSE NULL END) as attente_arrivee,
      AVG(CASE WHEN triage_at IS NOT NULL AND checkin_at IS NOT NULL
        THEN (julianday(triage_at) - julianday(checkin_at)) * 1440 ELSE NULL END) as attente_triage,
      AVG(CASE WHEN en_salle_at IS NOT NULL AND triage_at IS NOT NULL
        THEN (julianday(en_salle_at) - julianday(triage_at)) * 1440 ELSE NULL END) as attente_salle,
      AVG(CASE WHEN en_consultation_at IS NOT NULL AND en_salle_at IS NOT NULL
        THEN (julianday(en_consultation_at) - julianday(en_salle_at)) * 1440 ELSE NULL END) as attente_consultation,
      AVG(CASE WHEN sorti_at IS NOT NULL AND en_consultation_at IS NOT NULL
        THEN (julianday(sorti_at) - julianday(en_consultation_at)) * 1440 ELSE NULL END) as duree_consultation
    FROM appointments WHERE userId=?
  `).get(uid);

  // Monthly revenue last 12 months
  const monthlyCA = db.prepare(`
    SELECT strftime('%Y-%m', createdAt) as month, SUM(montant*quantite) as ca, COUNT(*) as actes
    FROM lignes_facturables WHERE userId=? AND statut != 'annule'
    GROUP BY month ORDER BY month DESC LIMIT 12
  `).all(uid).reverse();

  // Top 10 most billed acts
  const topActes = db.prepare(`
    SELECT codeActe, libelleActe, COUNT(*) as n, SUM(montant*quantite) as ca
    FROM lignes_facturables WHERE userId=? AND statut != 'annule'
    GROUP BY codeActe ORDER BY ca DESC LIMIT 10
  `).all(uid);

  const totalCA = byStatut.reduce((s,r) => r.statut !== 'annule' ? s + (r.total||0) : s, 0);
  const caEncaisse = byStatut.find(r=>r.statut==='encaisse')?.total || 0;
  const caFacture = byStatut.find(r=>r.statut==='facture')?.total || 0;

  res.json({
    kpi: {
      totalCA, caEncaisse, caFacture,
      tauxRecouvrement: totalCA > 0 ? Math.round(caEncaisse / totalCA * 100) : 0,
      nonFactureTotal: nonFacture?.total || 0,
      nonFactureN: nonFacture?.n || 0,
      totalConsults, withLabo, withImagerie, withFacturation,
      txConvLabo: totalConsults > 0 ? Math.round(withLabo/totalConsults*100) : 0,
      txConvImagerie: totalConsults > 0 ? Math.round(withImagerie/totalConsults*100) : 0,
      txConvFacturation: totalConsults > 0 ? Math.round(withFacturation/totalConsults*100) : 0,
    },
    byCategorie,
    byStatut,
    byCaisse,
    byDow,
    waitTimes: {
      arrivee: waitTimes?.attente_arrivee ? Math.round(waitTimes.attente_arrivee) : null,
      triage: waitTimes?.attente_triage ? Math.round(waitTimes.attente_triage) : null,
      salle: waitTimes?.attente_salle ? Math.round(waitTimes.attente_salle) : null,
      consultation: waitTimes?.attente_consultation ? Math.round(waitTimes.attente_consultation) : null,
      dureeConsultation: waitTimes?.duree_consultation ? Math.round(waitTimes.duree_consultation) : null,
    },
    monthlyCA,
    topActes,
  });
});

// ── Phase 4.2 — Moteur de protocoles cliniques ────────────────────────────────
const PROTOCOL_DEFS = {
  hta: {
    label: 'HTA — Bilan initial',
    labo: ['NFS','ionogramme','créatininémie','uricémie','glycémie jeun','cholestérol total','triglycérides','ECBU'],
    imagerie: ['ECG 12 dérivations','Fond d\'œil','Radiographie thorax'],
    prescription: 'Amlodipine 5mg — 1cp/j le matin\nPerindopril 5mg — 1cp/j le matin\nAspégic 75mg — 1cp/j (si risque CV ≥ modéré)',
    rdvDelai: 30, adressage: 'Cardiologue si HTA stade 2 ou résistante',
  },
  diabete: {
    label: 'Diabète type 2 — Bilan trimestriel',
    labo: ['HbA1c','glycémie jeun','créatininémie','microalbuminurie/créatinurie','NFS','bilan lipidique complet','ECBU'],
    imagerie: ['ECG 12 dérivations','Fond d\'œil (annuel)'],
    prescription: 'Metformine 850mg — 1cp x2/j aux repas\nGliclazide LP 30mg — 1cp/j le matin (si HbA1c > 7.5%)',
    rdvDelai: 90, adressage: 'Endocrinologue si HbA1c > 9% après 3 mois',
  },
  grossesse_t1: {
    label: 'Grossesse T1 — Bilan 1er trimestre',
    labo: ['NFS','groupe sanguin Rhésus','RAI','sérologie rubéole','sérologie toxoplasmose','sérologie syphilis','Ag HBs','VIH','glycémie jeun','ECBU','TSH'],
    imagerie: ['Échographie T1 (11-13 SA)'],
    prescription: 'Acide folique 5mg — 1cp/j\nFer — selon NFS\nVitamine D3 100 000 UI — 1 ampoule si déficite',
    rdvDelai: 28, adressage: 'Obstétricien / Maternité niveau adapté',
  },
  grossesse_t2: {
    label: 'Grossesse T2 — Bilan 2ème trimestre',
    labo: ['NFS','RAI','glycémie jeun','HGPO 75g (24-28 SA)','ECBU','sérologie toxoplasmose si négative'],
    imagerie: ['Échographie T2 morphologique (20-24 SA)'],
    prescription: 'Continuer acide folique si T2 précoce\nFer si NFS < 11g/dL\nVitamine D3 à 28 SA',
    rdvDelai: 28, adressage: 'Sage-femme pour suivi de grossesse',
  },
  grossesse_t3: {
    label: 'Grossesse T3 — Bilan 3ème trimestre',
    labo: ['NFS','RAI','sérologie toxoplasmose si négative','ECBU','prélèvement vaginal streptocoque B (35-37 SA)','bilan préop si césarienne prévue'],
    imagerie: ['Échographie T3 (32-36 SA)','Monitoring fœtal (CTG)'],
    prescription: 'Vitamine K1 2mg/j à partir de 36 SA\nFer si carence\nMagnésium si crampes',
    rdvDelai: 14, adressage: 'Maternité — hospitalisation si signe alarmant',
  },
  douleur_thoracique: {
    label: 'Douleur thoracique — Bilan urgent',
    labo: ['Troponine I ultra-sensible (répéter H3)','D-Dimères','NFS','ionogramme','créatininémie','glycémie','TP/TCA','groupe sanguin'],
    imagerie: ['ECG 12 dérivations (immédiat)','Radiographie thorax F+P','Angio-scanner thoracique si EP suspectée'],
    prescription: 'Aspirine 500mg PO si SCA suspecté (sans contre-indication)\nO2 si SpO2 < 94%\nMorphine 5mg IV si douleur EVA ≥ 7',
    rdvDelai: 0, adressage: 'SAMU / Urgences cardiologiques si troponine +',
  },
  preop: {
    label: 'Bilan préopératoire standard',
    labo: ['NFS','TP/TCA/fibrinogène','groupe sanguin Rhésus RAI','ionogramme','créatininémie','glycémie','ECG','albumine si nutrition précaire'],
    imagerie: ['ECG 12 dérivations','Radiographie thorax si > 50 ans'],
    prescription: 'Arrêter anticoagulants selon protocole\nArrêter aspirine 5j avant\nJeûne 6h solides / 2h liquides clairs',
    rdvDelai: 7, adressage: 'Anesthésiste — consultation pré-anesthésie obligatoire',
  },
  checkup: {
    label: 'Check-up entreprise annuel',
    labo: ['NFS','glycémie jeun','cholestérol total','LDL/HDL/triglycérides','créatininémie','uricémie','ASAT/ALAT','GGT','TSH','ECBU'],
    imagerie: ['ECG 12 dérivations si > 40 ans','Radiographie thorax'],
    prescription: 'Conseils hygiéno-diététiques personnalisés selon résultats',
    rdvDelai: 365, adressage: 'Ophtalmologue si diabète ou HTA · Dentiste annuel',
  },
  pediatrie: {
    label: 'Bilan pédiatrique — enfant 0–15 ans',
    labo: ['NFS','ferritine','glycémie','créatininémie','ECBU si symptômes','sérologies vaccins si doute'],
    imagerie: ['Radiographie main-poignet si retard statural'],
    prescription: 'Vitamine D3 1000 UI/j jusqu\'à 5 ans\nFer si ferritine < 12\nZinc si alimentation pauvre',
    rdvDelai: 90, adressage: 'Pédiatre spécialisé si retard développemental',
  },
};

app.post('/api/consultations/:id/protocol', auth, (req, res) => {
  const { protocol } = req.body;
  const def = PROTOCOL_DEFS[protocol];
  if (!def) return res.status(400).json({ error: 'Protocole inconnu' });

  const c = db.prepare("SELECT * FROM consultations WHERE id=? AND userId=?").get(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: 'Consultation introuvable' });

  const now = new Date().toISOString();
  const created = [];

  // Create labo ordres
  for (const exam of def.labo) {
    const stmt = db.prepare(`INSERT INTO ordres_medicaux (id,consultationId,patientId,userId,type,catalogue,priorite,statut,demande_at,createdAt,updatedAt)
      VALUES (?,?,?,?,'labo',?,?,?,?,?,?)`);
    const id = `ord_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    stmt.run(id, c.id, c.patientId, req.user.id, exam, 'routine', 'demande', now, now, now);
    created.push({ id, type: 'labo', exam });
  }

  // Create imagerie ordres
  for (const exam of def.imagerie) {
    const stmt = db.prepare(`INSERT INTO ordres_medicaux (id,consultationId,patientId,userId,type,catalogue,priorite,statut,demande_at,createdAt,updatedAt)
      VALUES (?,?,?,?,'imagerie',?,?,?,?,?,?)`);
    const id = `ord_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    stmt.run(id, c.id, c.patientId, req.user.id, exam, 'routine', 'demande', now, now, now);
    created.push({ id, type: 'imagerie', exam });
  }

  res.json({
    created: created.length,
    ordres: created,
    prescription: def.prescription,
    rdvDelai: def.rdvDelai,
    adressage: def.adressage,
    label: def.label,
  });
});

// ── Phase 4.3 — Perdus de vue ─────────────────────────────────────────────────
app.get('/api/intelligence/perdus-de-vue', auth, (req, res) => {
  const mois = parseInt(req.query.mois) || 6;
  const cutoff = new Date(Date.now() - mois * 30 * 864e5).toISOString().slice(0, 10);

  // Patients with at least 2 past consultations but no consult since cutoff
  const rows = db.prepare(`
    SELECT p.id, p.nom, p.prenom, p.dateNaissance, p.telephone, p.email, p.typeAssurance,
      COUNT(c.id) as totalConsults,
      MAX(c.date) as derniere_consult,
      CAST((julianday('now') - julianday(MAX(c.date))) AS INTEGER) as jours_absence
    FROM patients p
    JOIN consultations c ON c.patientId = p.id AND c.userId = ?
    GROUP BY p.id
    HAVING MAX(c.date) < ? AND COUNT(c.id) >= 2
    ORDER BY jours_absence DESC
    LIMIT 100
  `).all(req.user.id, cutoff);

  // Enrich with CIM-10 codes (last consult)
  const enriched = rows.map(p => {
    const lastNote = db.prepare("SELECT noteJson FROM consultations WHERE patientId=? AND userId=? AND statut='validee' ORDER BY date DESC LIMIT 1").get(p.id, req.user.id);
    let pathologies = [];
    if (lastNote) {
      try {
        const n = JSON.parse(decrypt(lastNote.noteJson) || lastNote.noteJson || '{}');
        if (n.cim10?.libelle) pathologies = [n.cim10.libelle];
      } catch {}
    }
    const age = p.dateNaissance ? new Date().getFullYear() - new Date(p.dateNaissance + 'T00:00:00').getFullYear() : null;
    return { ...p, age, pathologies };
  });

  res.json({ patients: enriched, mois, cutoff });
});

app.post('/api/intelligence/rappel/:patientId', auth, async (req, res) => {
  const p = db.prepare("SELECT * FROM patients WHERE id=?").get(req.params.patientId);
  if (!p) return res.status(404).json({ error: 'Patient introuvable' });

  const { message } = req.body;
  const nom = `${p.prenom} ${p.nom}`;
  const defaultMsg = message || `Bonjour ${p.prenom},\n\nNous n'avons pas eu de vos nouvelles depuis plusieurs mois. N'hésitez pas à nous contacter pour planifier un suivi.\n\nCordialement,\nVotre médecin`;

  if (mailer && p.email) {
    try {
      await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: p.email,
        subject: `Rappel de suivi médical — ${nom}`,
        text: defaultMsg,
      });
      return res.json({ sent: true, channel: 'email', to: p.email });
    } catch (e) {
      console.error('Rappel email error:', e.message);
    }
  }

  // Fallback — log only
  console.log(`[RAPPEL] Patient ${nom} (${p.id}) — ${p.telephone || 'pas de téléphone'} — ${defaultMsg.slice(0,60)}…`);
  res.json({ sent: false, channel: 'log', message: defaultMsg });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SÉRIE 5 — EXPANSION PLATEFORME
// ═══════════════════════════════════════════════════════════════════════════════

// ── Phase 5.1 — Spécialité sur consultation ──────────────────────────────────
// (specialite & type_consult added to existing consultation POST/PUT below via ALTER)
// The consultation creation endpoint already handles extra fields via body

// ── Phase 5.2 — Hospitalisation ──────────────────────────────────────────────
app.post('/api/hospitalisations', auth, (req, res) => {
  const { patientId, dateEntree, diagnostic_entree, service, chambre, lit, motif_entree, siteId } = req.body;
  if (!patientId || !dateEntree) return res.status(400).json({ error: 'patientId et dateEntree requis' });
  const id = `hosp_${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO hospitalisations (id,patientId,userId,siteId,dateEntree,diagnostic_entree,service,chambre,lit,motif_entree,statut,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,'actif',?,?)`)
    .run(id, patientId, req.user.id, siteId||null, dateEntree, diagnostic_entree||null, service||'Médecine générale', chambre||null, lit||null, motif_entree||null, now, now);
  res.json(db.prepare("SELECT h.*,p.nom,p.prenom FROM hospitalisations h JOIN patients p ON p.id=h.patientId WHERE h.id=?").get(id));
});

app.get('/api/hospitalisations', auth, (req, res) => {
  const { statut, patientId } = req.query;
  let q = "SELECT h.*,p.nom,p.prenom,p.dateNaissance FROM hospitalisations h JOIN patients p ON p.id=h.patientId WHERE h.userId=?";
  const params = [req.user.id];
  if (statut) { q += " AND h.statut=?"; params.push(statut); }
  if (patientId) { q += " AND h.patientId=?"; params.push(patientId); }
  q += " ORDER BY h.dateEntree DESC";
  res.json(db.prepare(q).all(...params));
});

app.get('/api/hospitalisations/:id', auth, (req, res) => {
  const h = db.prepare("SELECT h.*,p.nom,p.prenom,p.dateNaissance,p.sexe FROM hospitalisations h JOIN patients p ON p.id=h.patientId WHERE h.id=? AND h.userId=?").get(req.params.id, req.user.id);
  if (!h) return res.status(404).json({ error: 'Non trouvé' });
  const actes = db.prepare("SELECT * FROM actes_hospitaliers WHERE hospitalisationId=? ORDER BY date DESC,createdAt DESC").all(req.params.id);
  res.json({ ...h, actes });
});

app.put('/api/hospitalisations/:id', auth, (req, res) => {
  const now = new Date().toISOString();
  const { diagnostic_entree, diagnostic_sortie, service, chambre, lit, prescriptions_hospi, surveillance, compte_rendu_sortie, statut, dateSortie } = req.body;
  db.prepare(`UPDATE hospitalisations SET diagnostic_entree=COALESCE(?,diagnostic_entree), diagnostic_sortie=COALESCE(?,diagnostic_sortie),
    service=COALESCE(?,service), chambre=COALESCE(?,chambre), lit=COALESCE(?,lit),
    prescriptions_hospi=COALESCE(?,prescriptions_hospi), surveillance=COALESCE(?,surveillance),
    compte_rendu_sortie=COALESCE(?,compte_rendu_sortie), statut=COALESCE(?,statut),
    dateSortie=COALESCE(?,dateSortie), updatedAt=? WHERE id=? AND userId=?`)
    .run(diagnostic_entree||null, diagnostic_sortie||null, service||null, chambre||null, lit||null,
      prescriptions_hospi||null, surveillance||null, compte_rendu_sortie||null, statut||null,
      dateSortie||null, now, req.params.id, req.user.id);
  res.json(db.prepare("SELECT * FROM hospitalisations WHERE id=?").get(req.params.id));
});

app.post('/api/hospitalisations/:id/actes', auth, (req, res) => {
  const { date, type, description, valeurs } = req.body;
  const id = `acte_${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO actes_hospitaliers (id,hospitalisationId,date,type,description,valeurs,userId,createdAt) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, req.params.id, date||now.slice(0,10), type, description||null, valeurs ? JSON.stringify(valeurs) : null, req.user.id, now);
  res.json(db.prepare("SELECT * FROM actes_hospitaliers WHERE id=?").get(id));
});

app.get('/api/hospitalisations/:id/actes', auth, (req, res) => {
  res.json(db.prepare("SELECT * FROM actes_hospitaliers WHERE hospitalisationId=? ORDER BY date DESC,createdAt DESC").all(req.params.id));
});

// Discharge summary PDF
app.get('/api/hospitalisations/:id/pdf', auth, async (req, res) => {
  const h = db.prepare("SELECT h.*,p.nom,p.prenom,p.dateNaissance,p.sexe FROM hospitalisations h JOIN patients p ON p.id=h.patientId WHERE h.id=? AND h.userId=?").get(req.params.id, req.user.id);
  if (!h) return res.status(404).json({ error: 'Non trouvé' });
  const dr = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  const PDFDocument = (await import('pdfkit')).default;
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="compte-rendu-hospitalisation-${h.id}.pdf"`);
  doc.pipe(res);
  doc.rect(0,0,595,80).fill('#00725f');
  doc.fillColor('white').fontSize(20).font('Helvetica-Bold').text('MediVox',50,22);
  doc.fontSize(10).font('Helvetica').text('Compte Rendu d\'Hospitalisation',50,50);
  doc.fillColor('#3A3A3A').fontSize(12).font('Helvetica-Bold').text(`${h.prenom} ${h.nom}`,50,110);
  doc.fontSize(10).font('Helvetica').text(`Né(e) : ${h.dateNaissance||'—'} · Service : ${h.service||'—'}`,50,130);
  doc.text(`Entrée : ${h.dateEntree} · Sortie : ${h.dateSortie||'En cours'}`,50,148);
  doc.moveDown(2);
  if (h.diagnostic_entree) { doc.fontSize(11).font('Helvetica-Bold').text('Diagnostic d\'entrée :'); doc.fontSize(10).font('Helvetica').text(h.diagnostic_entree); doc.moveDown(); }
  if (h.diagnostic_sortie) { doc.fontSize(11).font('Helvetica-Bold').text('Diagnostic de sortie :'); doc.fontSize(10).font('Helvetica').text(h.diagnostic_sortie); doc.moveDown(); }
  if (h.compte_rendu_sortie) { doc.fontSize(11).font('Helvetica-Bold').text('Compte rendu de sortie :'); doc.fontSize(10).font('Helvetica').text(h.compte_rendu_sortie); doc.moveDown(); }
  if (h.prescriptions_hospi) { doc.fontSize(11).font('Helvetica-Bold').text('Traitement de sortie :'); doc.fontSize(10).font('Helvetica').text(h.prescriptions_hospi); }
  doc.fontSize(8).fillColor('#94a3b8').text(`MediVox — Dr. ${dr?.prenom||''} ${dr?.nom||''} — Document confidentiel`,50,780,{align:'center',width:495});
  doc.end();
});

// ── Phase 5.3 — Portail patient ──────────────────────────────────────────────

// Generate patient access code (called by doctor)
app.post('/api/patients/:id/portail/code', auth, (req, res) => {
  const code = Math.random().toString(36).slice(2,8).toUpperCase();
  const now = new Date().toISOString();
  db.prepare("UPDATE patients SET code_acces=?,code_acces_at=? WHERE id=?").run(code, now, req.params.id);
  res.json({ code });
});

// Rate limiter: max 10 attempts per 15min per IP on portal auth
const portalAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' },
  skipSuccessfulRequests: true,
});

// Public: patient authenticates with (dateNaissance + code_acces)
app.post('/api/portal/auth', portalAuthLimiter, (req, res) => {
  const { dateNaissance, code } = req.body;
  const p = db.prepare("SELECT * FROM patients WHERE dateNaissance=? AND code_acces=?").get(dateNaissance, code?.toUpperCase());
  if (!p) return res.status(401).json({ error: 'Code ou date de naissance incorrects' });
  const token = jwt.sign({ patientId: p.id, role: 'patient' }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, patient: { id: p.id, nom: p.nom, prenom: p.prenom, email: p.email } });
});

const authPortal = (req, res, next) => {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Non autorisé' });
  try {
    const d = jwt.verify(h.slice(7), JWT_SECRET);
    if (d.role !== 'patient') return res.status(403).json({ error: 'Accès refusé' });
    req.patient = d;
    next();
  } catch { res.status(401).json({ error: 'Token invalide' }); }
};

// Doctor: get own disponibilités config
app.get('/api/profile/disponibilites', auth, (req, res) => {
  const u = db.prepare("SELECT plages_horaires,duree_rdv FROM users WHERE id=?").get(req.user.id);
  const defaultPlages = {
    lun: { actif: true,  debut: '08:00', fin: '18:00' },
    mar: { actif: true,  debut: '08:00', fin: '18:00' },
    mer: { actif: true,  debut: '08:00', fin: '13:00' },
    jeu: { actif: true,  debut: '08:00', fin: '18:00' },
    ven: { actif: true,  debut: '08:00', fin: '17:00' },
    sam: { actif: false, debut: '08:00', fin: '12:00' },
    dim: { actif: false, debut: '08:00', fin: '12:00' },
  };
  const plages = u?.plages_horaires ? JSON.parse(u.plages_horaires) : defaultPlages;
  res.json({ plages, duree_rdv: u?.duree_rdv || 30 });
});

app.put('/api/profile/disponibilites', auth, (req, res) => {
  const { plages, duree_rdv } = req.body;
  db.prepare("UPDATE users SET plages_horaires=?,duree_rdv=? WHERE id=?")
    .run(JSON.stringify(plages), parseInt(duree_rdv)||30, req.user.id);
  res.json({ ok: true });
});

// Public: available slots for online booking (uses real doctor schedule)
app.get('/api/portal/disponibilites', (req, res) => {
  const { date, userId } = req.query;
  if (!date) return res.json({ slots: [], taken: [] });

  // Get day of week
  const dow = new Date(date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short' }).slice(0, 3).toLowerCase();
  const dowMap = { lun:'lun', mar:'mar', mer:'mer', jeu:'jeu', ven:'ven', sam:'sam', dim:'dim' };
  const dowKey = { '0':'dim','1':'lun','2':'mar','3':'mer','4':'jeu','5':'ven','6':'sam' }[new Date(date + 'T12:00:00').getDay()];

  // Get doctor's schedule if userId provided
  let slots = [];
  let duree = 30;
  if (userId) {
    const u = db.prepare("SELECT plages_horaires,duree_rdv FROM users WHERE id=?").get(userId);
    duree = u?.duree_rdv || 30;
    const defaultPlages = {
      lun: { actif: true, debut: '08:00', fin: '18:00' },
      mar: { actif: true, debut: '08:00', fin: '18:00' },
      mer: { actif: true, debut: '08:00', fin: '13:00' },
      jeu: { actif: true, debut: '08:00', fin: '18:00' },
      ven: { actif: true, debut: '08:00', fin: '17:00' },
      sam: { actif: false, debut: '08:00', fin: '12:00' },
      dim: { actif: false, debut: '08:00', fin: '12:00' },
    };
    const plages = u?.plages_horaires ? JSON.parse(u.plages_horaires) : defaultPlages;
    const plage = plages[dowKey];
    if (plage?.actif) {
      // Generate slots between debut and fin at duree intervals
      const [dh, dm] = plage.debut.split(':').map(Number);
      const [fh, fm] = plage.fin.split(':').map(Number);
      let cur = dh * 60 + dm;
      const end = fh * 60 + fm;
      while (cur + duree <= end) {
        const h = String(Math.floor(cur/60)).padStart(2,'0');
        const m = String(cur%60).padStart(2,'0');
        slots.push(`${h}:${m}`);
        cur += duree;
      }
    }
  } else {
    // Fallback: generic slots if no userId
    slots = ['08:00','08:30','09:00','09:30','10:00','10:30','11:00','11:30','14:00','14:30','15:00','15:30','16:00','16:30','17:00'];
  }

  // Remove taken slots
  const booked = db.prepare("SELECT heure FROM appointments WHERE date=? AND (userId=? OR ?='')")
    .all(date, userId||'', userId||'');
  const taken = booked.map(b => b.heure);
  res.json({ slots: slots.filter(s => !taken.includes(s)), taken, duree });
});

// Public: book an appointment (portal)
app.post('/api/portal/rdv', (req, res) => {
  const { nom, prenom, dateNaissance, telephone, email, date, heure, motif, userId } = req.body;
  if (!nom||!prenom||!date||!heure) return res.status(400).json({ error: 'Champs requis manquants' });

  try {
    const result = db.transaction(() => {
      // ── Anti double-booking : vérification atomique dans la transaction ──
      const taken = userId
        ? db.prepare("SELECT id FROM appointments WHERE userId=? AND date=? AND heure=?").get(userId, date, heure)
        : db.prepare("SELECT id FROM appointments WHERE date=? AND heure=? AND (userId IS NULL OR userId='')").get(date, heure);
      if (taken) {
        throw Object.assign(new Error('Ce créneau vient d\'être réservé. Veuillez choisir un autre horaire.'), { status: 409 });
      }

      // Find or create patient
      let p = db.prepare("SELECT * FROM patients WHERE nom=? AND prenom=? AND dateNaissance=?")
                .get(nom.trim(), prenom.trim(), dateNaissance||'');
      if (!p) {
        const pid = `pat_portal_${Date.now()}`;
        db.prepare("INSERT INTO patients (id,nom,prenom,dateNaissance,telephone,email,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)")
          .run(pid, nom.trim(), prenom.trim(), dateNaissance||null, telephone||null, email||null, new Date().toISOString(), new Date().toISOString());
        p = db.prepare("SELECT * FROM patients WHERE id=?").get(pid);
      }

      const aid = `apt_portal_${Date.now()}`;
      db.prepare("INSERT INTO appointments (id,patientId,userId,date,heure,motif,statut,createdAt) VALUES (?,?,?,?,?,?,'confirme',?)")
        .run(aid, p.id, userId||null, date, heure, motif||'Consultation', new Date().toISOString());

      return { id: aid, patientId: p.id, date, heure, message: 'Rendez-vous enregistré' };
    })();

    res.json(result);
  } catch (err) {
    const status = err.status || (err.message?.includes('UNIQUE') ? 409 : 500);
    res.status(status).json({ error: err.message || 'Erreur lors de la réservation' });
  }
});

// Patient: get their documents (consultations validées)
app.get('/api/portal/consultations', authPortal, (req, res) => {
  const consults = db.prepare("SELECT id,date,motif,statut FROM consultations WHERE patientId=? AND statut='validee' ORDER BY date DESC LIMIT 20").all(req.patient.patientId);
  res.json(consults);
});

// Patient: get their prescriptions
app.get('/api/portal/prescriptions', authPortal, (req, res) => {
  const rxs = db.prepare("SELECT p.*,c.date,c.motif FROM prescriptions p JOIN consultations c ON c.id=p.consultationId WHERE c.patientId=? AND p.validee=1 ORDER BY c.date DESC LIMIT 10").all(req.patient.patientId);
  res.json(rxs.map(r=>({...r, lignes: JSON.parse(r.lignes||'[]')})));
});

// Patient: get their labo results
app.get('/api/portal/resultats', authPortal, (req, res) => {
  const ords = db.prepare("SELECT * FROM ordres_medicaux WHERE patientId=? AND statut='rendu' ORDER BY rendu_at DESC LIMIT 20").all(req.patient.patientId);
  res.json(ords.map(o=>({...o, resultats: o.resultats ? JSON.parse(o.resultats) : null})));
});

// Patient: portal messaging
app.get('/api/portal/messages', authPortal, (req, res) => {
  const msgs = db.prepare("SELECT * FROM portal_messages WHERE patientId=? ORDER BY createdAt DESC LIMIT 50").all(req.patient.patientId);
  // Mark as read
  db.prepare("UPDATE portal_messages SET lu=1 WHERE patientId=? AND expediteur='medecin'").run(req.patient.patientId);
  res.json(msgs.reverse());
});

app.post('/api/portal/messages', authPortal, (req, res) => {
  const { contenu } = req.body;
  if (!contenu?.trim()) return res.status(400).json({ error: 'Contenu vide' });
  const id = `pm_${Date.now()}`;
  db.prepare("INSERT INTO portal_messages (id,patientId,expediteur,contenu,createdAt) VALUES (?,?,?,?,?)")
    .run(id, req.patient.patientId, 'patient', contenu.trim(), new Date().toISOString());
  res.json(db.prepare("SELECT * FROM portal_messages WHERE id=?").get(id));
});

// Doctor: see portal messages from a patient
app.get('/api/patients/:id/portal-messages', auth, (req, res) => {
  const msgs = db.prepare("SELECT * FROM portal_messages WHERE patientId=? ORDER BY createdAt ASC").all(req.params.id);
  res.json(msgs);
});

app.post('/api/patients/:id/portal-messages', auth, (req, res) => {
  const { contenu } = req.body;
  if (!contenu?.trim()) return res.status(400).json({ error: 'Contenu vide' });
  const id = `pm_${Date.now()}`;
  db.prepare("INSERT INTO portal_messages (id,patientId,userId,expediteur,contenu,createdAt) VALUES (?,?,?,?,?,?)")
    .run(id, req.params.id, req.user.id, 'medecin', contenu.trim(), new Date().toISOString());
  res.json(db.prepare("SELECT * FROM portal_messages WHERE id=?").get(id));
});

// Electronic consent
app.post('/api/patients/:id/consentements', authPortal, (req, res) => {
  const { type, texte, signe } = req.body;
  const id = `cons_${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO consentements (id,patientId,type,texte,signe,signe_at,ip,createdAt) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, req.params.id, type, texte||null, signe?1:0, signe?now:null, req.ip, now);
  res.json({ id, signe });
});

// Mobile money payment initiation
app.post('/api/paiements-mobile', auth, (req, res) => {
  const { patientId, consultationId, montant, operateur, numero } = req.body;
  if (!montant||!operateur||!numero) return res.status(400).json({ error: 'Champs requis manquants' });
  const id = `pay_${Date.now()}`;
  const reference = `MV${Date.now().toString().slice(-8)}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO paiements_mobile (id,patientId,consultationId,montant,operateur,numero,reference,statut,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,'initie',?,?)")
    .run(id, patientId||null, consultationId||null, montant, operateur, numero, reference, now, now);
  // In production: call Mobile Money API (Airtel Money, Moov Money, etc.)
  // For now simulate success after delay
  setTimeout(()=>{
    db.prepare("UPDATE paiements_mobile SET statut='confirme',updatedAt=? WHERE id=?").run(new Date().toISOString(), id);
  }, 3000);
  res.json({ id, reference, statut: 'initie', message: `Paiement de ${montant} XAF initié via ${operateur} au ${numero}` });
});

app.get('/api/paiements-mobile/:id', auth, (req, res) => {
  const p = db.prepare("SELECT * FROM paiements_mobile WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Non trouvé' });
  res.json(p);
});

// ── Phase 5.4 — Téléconsultation ─────────────────────────────────────────────
app.post('/api/teleconsultations', auth, (req, res) => {
  const { consultationId, patientId } = req.body;
  if (!patientId) return res.status(400).json({ error: 'patientId requis' });
  const id = `tc_${Date.now()}`;
  const roomName = `medivox-${id}`;
  // Jitsi meet room (no API key needed, free)
  const room_url = `https://meet.jit.si/${roomName}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO teleconsultations (id,consultationId,patientId,userId,room_url,statut,createdAt) VALUES (?,?,?,?,?,'planifie',?)")
    .run(id, consultationId||null, patientId, req.user.id, room_url, now);
  if (consultationId) {
    db.prepare("UPDATE consultations SET video_room=?,type_consult='teleconsultation' WHERE id=?").run(room_url, consultationId);
  }
  const pat = db.prepare("SELECT nom,prenom,telephone FROM patients WHERE id=?").get(patientId);
  res.json({ id, room_url, roomName, nom: pat?.nom, prenom: pat?.prenom, telephone: pat?.telephone });
});

app.get('/api/teleconsultations', auth, (req, res) => {
  const rows = db.prepare(`SELECT tc.*,p.nom,p.prenom,p.telephone FROM teleconsultations tc JOIN patients p ON p.id=tc.patientId WHERE tc.userId=? ORDER BY tc.createdAt DESC LIMIT 30`).all(req.user.id);
  res.json(rows);
});

// ── Phase 5.5 — Multi-sites & FHIR ──────────────────────────────────────────
app.get('/api/sites', auth, (req, res) => {
  res.json(db.prepare("SELECT * FROM sites WHERE actif=1 ORDER BY nom").all());
});

app.post('/api/sites', auth, (req, res) => {
  const { nom, adresse, telephone } = req.body;
  if (!nom) return res.status(400).json({ error: 'Nom requis' });
  const id = `site_${Date.now()}`;
  db.prepare("INSERT INTO sites (id,nom,adresse,telephone) VALUES (?,?,?,?)").run(id, nom, adresse||null, telephone||null);
  res.json(db.prepare("SELECT * FROM sites WHERE id=?").get(id));
});

// FHIR R4 — Patient resource
app.get('/fhir/Patient', auth, (req, res) => {
  const { name, birthdate, _count } = req.query;
  let q = "SELECT * FROM patients WHERE 1=1";
  const params = [];
  if (name) { q += " AND (nom LIKE ? OR prenom LIKE ?)"; params.push(`%${name}%`, `%${name}%`); }
  if (birthdate) { q += " AND dateNaissance=?"; params.push(birthdate); }
  q += ` LIMIT ${Math.min(parseInt(_count)||20, 100)}`;
  const patients = db.prepare(q).all(...params);
  res.json({
    resourceType: 'Bundle', type: 'searchset', total: patients.length,
    entry: patients.map(p => ({
      resource: {
        resourceType: 'Patient', id: p.id,
        name: [{ family: p.nom, given: [p.prenom] }],
        birthDate: p.dateNaissance,
        gender: p.sexe === 'M' ? 'male' : p.sexe === 'F' ? 'female' : 'unknown',
        telecom: p.telephone ? [{ system: 'phone', value: p.telephone }] : [],
        address: p.adresse ? [{ text: p.adresse }] : [],
      }
    }))
  });
});

app.get('/fhir/Patient/:id', auth, (req, res) => {
  const p = db.prepare("SELECT * FROM patients WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] });
  res.json({
    resourceType: 'Patient', id: p.id,
    meta: { lastUpdated: p.updatedAt },
    name: [{ family: p.nom, given: [p.prenom] }],
    birthDate: p.dateNaissance,
    gender: p.sexe === 'M' ? 'male' : p.sexe === 'F' ? 'female' : 'unknown',
    telecom: [
      ...(p.telephone ? [{ system: 'phone', value: p.telephone, use: 'mobile' }] : []),
      ...(p.email ? [{ system: 'email', value: p.email }] : []),
    ],
    address: p.adresse ? [{ text: p.adresse }] : [],
    extension: [
      { url: 'https://medivox.fr/fhir/StructureDefinition/assurance', valueString: p.typeAssurance||'' },
      { url: 'https://medivox.fr/fhir/StructureDefinition/groupe-sanguin', valueString: p.groupe_sanguin||'' },
    ],
  });
});

app.get('/fhir/Encounter', auth, (req, res) => {
  const { patient, _count } = req.query;
  let q = "SELECT c.*,p.nom,p.prenom FROM consultations c JOIN patients p ON p.id=c.patientId WHERE c.userId=?";
  const params = [req.user.id];
  if (patient) { q += " AND c.patientId=?"; params.push(patient); }
  q += ` ORDER BY c.date DESC LIMIT ${Math.min(parseInt(_count)||20, 100)}`;
  const consults = db.prepare(q).all(...params);
  res.json({
    resourceType: 'Bundle', type: 'searchset', total: consults.length,
    entry: consults.map(c => ({
      resource: {
        resourceType: 'Encounter', id: c.id,
        status: c.statut === 'validee' ? 'finished' : 'in-progress',
        class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'Ambulatoire' },
        subject: { reference: `Patient/${c.patientId}`, display: `${c.prenom} ${c.nom}` },
        period: { start: c.date },
        reasonCode: c.motif ? [{ text: c.motif }] : [],
      }
    }))
  });
});

app.get('/fhir/Observation', auth, (req, res) => {
  // Return vitals from consultations
  const { patient, _count } = req.query;
  let q = "SELECT c.id,c.date,c.patientId,c.constantes,p.nom,p.prenom FROM consultations c JOIN patients p ON p.id=c.patientId WHERE c.userId=? AND c.constantes IS NOT NULL";
  const params = [req.user.id];
  if (patient) { q += " AND c.patientId=?"; params.push(patient); }
  q += ` ORDER BY c.date DESC LIMIT ${Math.min(parseInt(_count)||20, 100)}`;
  const rows = db.prepare(q).all(...params);
  const observations = [];
  for (const r of rows) {
    let cst = {};
    try { cst = JSON.parse(r.constantes||'{}'); } catch {}
    const map = { ta_sys:'Pression artérielle systolique', fc:'Fréquence cardiaque', temperature:'Température', spo2:'SpO2', poids:'Poids', taille:'Taille' };
    for (const [key, display] of Object.entries(map)) {
      if (cst[key]) observations.push({
        resource: {
          resourceType: 'Observation', id: `${r.id}_${key}`,
          status: 'final',
          subject: { reference: `Patient/${r.patientId}`, display: `${r.prenom} ${r.nom}` },
          encounter: { reference: `Encounter/${r.id}` },
          effectiveDateTime: r.date,
          code: { text: display },
          valueQuantity: { value: parseFloat(cst[key]) },
        }
      });
    }
  }
  res.json({ resourceType: 'Bundle', type: 'searchset', total: observations.length, entry: observations });
});

// FHIR metadata / capability statement
app.get('/fhir/metadata', (req, res) => {
  res.json({
    resourceType: 'CapabilityStatement',
    status: 'active', date: new Date().toISOString(),
    kind: 'instance', fhirVersion: '4.0.1',
    name: 'MediVoxFHIR', title: 'MediVox FHIR R4 API',
    description: 'API FHIR R4 — MediVox plateforme médicale',
    rest: [{
      mode: 'server',
      resource: [
        { type: 'Patient', interaction: [{ code: 'read' }, { code: 'search-type' }] },
        { type: 'Encounter', interaction: [{ code: 'read' }, { code: 'search-type' }] },
        { type: 'Observation', interaction: [{ code: 'search-type' }] },
      ]
    }]
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;

// Endpoint admin : déclenche un backup manuel
app.post('/api/admin/backup', auth, async (req, res) => {
  try {
    const result = await backupToS3(db);
    res.json(result.skipped
      ? { message: 'Backup ignoré — variables AWS non configurées' }
      : { message: 'Backup réussi', key: result.key, size: result.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Démarrage : restore depuis S3 si la DB locale est absente, puis schedule
(async () => {
  const { existsSync, statSync } = await import('fs');
  const { DB_PATH } = await import('./backup.mjs');

  // Restore uniquement si la DB n'existe pas ou est vide (ex: redémarrage Render)
  const dbMissing = !existsSync(DB_PATH) || statSync(DB_PATH).size < 4096;
  if (dbMissing) {
    console.log('⚠️  DB locale absente ou vide — tentative de restauration S3…');
    await restoreFromS3().catch(e => console.error('Restore S3 échoué:', e.message));
  }

  app.listen(PORT, () => {
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
    if (!openai) console.log('⚠️  Mode démo — ajoutez OPENAI_API_KEY dans .env');
    if (!mailer)  console.log('ℹ️  Email désactivé — ajoutez SMTP_HOST dans .env');
    scheduleBackup(db);
  });
})();
