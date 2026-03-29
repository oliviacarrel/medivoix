import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { OpenAI } from 'openai';
import { createReadStream, unlinkSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
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
  const consultations = db.prepare(
    'SELECT id,motif,date,statut FROM consultations WHERE patientId=? ORDER BY date DESC'
  ).all(p.id);
  res.json({ ...p, consultations });
});

app.post('/api/patients', auth, (req, res) => {
  const { nom, prenom, dateNaissance, sexe, telephone, telephone2, email, adresse, typeAssurance, numAssurance, antecedents, allergies, traitements } = req.body;
  const id = randomUUID();
  db.prepare(`INSERT INTO patients (id,nom,prenom,dateNaissance,sexe,telephone,telephone2,email,adresse,typeAssurance,numAssurance,antecedents,allergies,traitements)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, nom, prenom, dateNaissance, sexe||'M', telephone, telephone2, email, adresse, typeAssurance, numAssurance, antecedents, allergies, traitements);
  audit(req, 'CREATE_PATIENT', 'patient', id, `${prenom} ${nom}`);
  res.json(db.prepare('SELECT * FROM patients WHERE id=?').get(id));
});

app.put('/api/patients/:id', auth, (req, res) => {
  const { nom, prenom, dateNaissance, sexe, telephone, telephone2, email, adresse, typeAssurance, numAssurance, antecedents, allergies, traitements } = req.body;
  const info = db.prepare(`UPDATE patients SET nom=?,prenom=?,dateNaissance=?,sexe=?,telephone=?,telephone2=?,email=?,
    adresse=?,typeAssurance=?,numAssurance=?,antecedents=?,allergies=?,traitements=?,updatedAt=datetime('now') WHERE id=?`)
    .run(nom, prenom, dateNaissance, sexe, telephone, telephone2, email, adresse, typeAssurance, numAssurance, antecedents, allergies, traitements, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Patient non trouvé' });
  audit(req, 'UPDATE_PATIENT', 'patient', req.params.id, `${prenom} ${nom}`);
  res.json(db.prepare('SELECT * FROM patients WHERE id=?').get(req.params.id));
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
    note = { motif:"Céphalées", histoire:"Céphalées pulsatiles depuis 3 jours, prédominance matinale, sans fièvre ni nausées. Antécédent de migraines il y a 5 ans.", examen:"TA : 160/95 mmHg. Pas d'autres anomalies.", hypotheses:"1. Céphalée sur poussée hypertensive\n2. Reprise migraineuse", conduite:"1. Bilan NFS, ionogramme, créatinine\n2. ECG\n3. MAPA\n4. Traitement antihypertenseur à discuter", prescriptions:"Paracétamol 1g si douleur, max 3g/j\nAvis cardiologique", conseils_patient:"Reposez-vous. Mesurez votre tension le matin. Revenez en urgence si douleur aggravée, troubles visuels ou faiblesse.", drapeaux_rouges:"Céphalée en coup de tonnerre, fièvre + raideur nuque, déficit neurologique focal, HTA > 180/110" };
  } else {
    const ctx = p ? `Patient : ${p.prenom} ${p.nom}, né(e) le ${p.dateNaissance}.\nAntécédents : ${p.antecedents||'aucun'}\nAllergies : ${p.allergies||'aucune'}\nTraitements : ${p.traitements||'aucun'}` : '';
    try {
      const r = await openai.chat.completions.create({ model:'gpt-4o', messages:[{role:'user',content:`Tu es un assistant médical. Génère une note clinique JSON.\n\n${ctx}\n\nTranscription:\n"""\n${transcription}\n"""\n\nRetourne UNIQUEMENT ce JSON:\n{"motif":"","histoire":"","examen":"","hypotheses":"","conduite":"","prescriptions":"","conseils_patient":"","drapeaux_rouges":""}`}], response_format:{type:'json_object'} });
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
  doc.fillColor('white').fontSize(22).font('Helvetica-Bold').text('MédiVoix',50,18);
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
  doc.fillColor('#94a3b8').fontSize(7.5).font('Helvetica').text('MédiVoix — Proposition IA validée par le médecin — Non opposable sans signature',50,fy+2,{align:'center',width:495});
  doc.end();
}

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
  doc.fontSize(7).fillColor('#94a3b8').text('MédiVoix — Valable 3 mois — Signature manuscrite requise',50,fy2+12,{align:'center',width:495});
  doc.end();
});

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
  if (!openai) console.log('⚠️  Mode démo — ajoutez OPENAI_API_KEY dans .env');
  if (!mailer)  console.log('ℹ️  Email désactivé — ajoutez SMTP_HOST dans .env');
});
