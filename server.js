import 'dotenv/config';
import express from 'express';
import cors from 'cors';
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
import db from './db.js';
import { encrypt, decrypt } from './crypto-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ dest: 'uploads/' });
const JWT_SECRET = process.env.JWT_SECRET || 'medivoix-dev-secret-change-in-prod';

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

  const totalPatients   = db.prepare('SELECT COUNT(*) as n FROM patients').get().n;
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
  const { patientId, date, heure, motif, notes } = req.body;
  if (!patientId || !date) return res.status(400).json({ error: 'patientId et date requis' });
  const id = randomUUID();
  db.prepare(`INSERT INTO appointments (id,patientId,userId,date,heure,motif,notes) VALUES (?,?,?,?,?,?,?)`)
    .run(id, patientId, req.user.id, date, heure||'09:00', motif||'', notes||'');
  audit(req, 'CREATE_APPOINTMENT', 'appointment', id, `${date} ${heure}`);
  res.json(db.prepare('SELECT a.*, p.nom, p.prenom FROM appointments a JOIN patients p ON a.patientId=p.id WHERE a.id=?').get(id));
});

app.put('/api/agenda/:id', auth, (req, res) => {
  const { date, heure, motif, notes, statut } = req.body;
  db.prepare(`UPDATE appointments SET date=?,heure=?,motif=?,notes=?,statut=? WHERE id=? AND userId=?`)
    .run(date, heure, motif||'', notes||'', statut||'planifie', req.params.id, req.user.id);
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
  res.json(db.prepare('SELECT id,nom,prenom,dateNaissance,sexe FROM patients ORDER BY nom').all());
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
  const { patientId, motif } = req.body;
  const id = randomUUID();
  db.prepare('INSERT INTO consultations (id,patientId,userId,motif) VALUES (?,?,?,?)').run(id, patientId, req.user.id, motif);
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
  const merged = { ...(parseNote(c)||{}), ...req.body.note };
  db.prepare("UPDATE consultations SET noteJson=?,statut='validee',updatedAt=datetime('now') WHERE id=?")
    .run(encrypt(JSON.stringify(merged)), c.id);
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

  // Patient stats
  const totalPatients  = db.prepare("SELECT COUNT(*) as n FROM patients").get().n;
  const femmes         = db.prepare("SELECT COUNT(*) as n FROM patients WHERE sexe='F'").get().n;
  const hommes         = db.prepare("SELECT COUNT(*) as n FROM patients WHERE sexe='M'").get().n;
  const avgAge         = db.prepare("SELECT AVG((strftime('%Y','now') - strftime('%Y',dateNaissance))) as v FROM patients WHERE dateNaissance IS NOT NULL AND dateNaissance != ''").get().v;

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
  doc.fillColor('white').fontSize(22).font('Helvetica-Bold').text('MedPilot',50,18);
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
  doc.fillColor('#94a3b8').fontSize(7.5).font('Helvetica').text('MedPilot — Compte rendu validé par le médecin — Non opposable sans signature',50,fy+2,{align:'center',width:495});
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
  doc.fillColor('white').fontSize(24).font('Helvetica-Bold').text('MedPilot',50,22);
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
  doc.fillColor('#94a3b8').fontSize(7.5).font('Helvetica').text('MedPilot — Dossier médical confidentiel — Généré électroniquement — Non opposable sans signature',50,fy+8,{align:'center',width:495});
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
  doc.fontSize(7).fillColor('#94a3b8').text('MedPilot — Valable 3 mois — Signature manuscrite requise',50,fy2+12,{align:'center',width:495});
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
  doc.fontSize(7).fillColor('#94a3b8').font('Helvetica').text('MedPilot — Document médical officiel',50,fy+12,{align:'center',width:495});
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
// START
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
  if (!openai) console.log('⚠️  Mode démo — ajoutez OPENAI_API_KEY dans .env');
  if (!mailer)  console.log('ℹ️  Email désactivé — ajoutez SMTP_HOST dans .env');
});
