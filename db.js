import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(__dirname, 'data.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    email      TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    nom        TEXT NOT NULL,
    prenom     TEXT NOT NULL,
    rpps       TEXT,
    specialite TEXT,
    telephone  TEXT,
    adresse    TEXT,
    photo      TEXT,
    createdAt  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS patients (
    id            TEXT PRIMARY KEY,
    nom           TEXT NOT NULL,
    prenom        TEXT NOT NULL,
    dateNaissance TEXT,
    sexe          TEXT DEFAULT 'M',
    telephone     TEXT,
    telephone2    TEXT,
    email         TEXT,
    adresse       TEXT,
    typeAssurance TEXT,
    numAssurance  TEXT,
    antecedents   TEXT,
    allergies     TEXT,
    traitements   TEXT,
    createdAt     TEXT DEFAULT (datetime('now')),
    updatedAt     TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS consultations (
    id            TEXT PRIMARY KEY,
    patientId     TEXT NOT NULL REFERENCES patients(id),
    userId        TEXT REFERENCES users(id),
    motif         TEXT NOT NULL,
    date          TEXT DEFAULT (datetime('now')),
    statut        TEXT DEFAULT 'en_cours',
    transcription TEXT DEFAULT '',
    noteJson      TEXT,
    createdAt     TEXT DEFAULT (datetime('now')),
    updatedAt     TEXT DEFAULT (datetime('now')),
    heureDebut    TEXT,
    heureFin      TEXT,
    dureeMinutes  INTEGER
  );

  CREATE TABLE IF NOT EXISTS prescriptions (
    id             TEXT PRIMARY KEY,
    consultationId TEXT NOT NULL REFERENCES consultations(id),
    lignes         TEXT NOT NULL DEFAULT '[]',
    validee        INTEGER DEFAULT 0,
    createdAt      TEXT DEFAULT (datetime('now')),
    updatedAt      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id         TEXT PRIMARY KEY,
    userId     TEXT,
    userEmail  TEXT,
    action     TEXT NOT NULL,
    entityType TEXT,
    entityId   TEXT,
    details    TEXT,
    ip         TEXT,
    createdAt  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id        TEXT PRIMARY KEY,
    patientId TEXT NOT NULL REFERENCES patients(id),
    userId    TEXT REFERENCES users(id),
    date      TEXT NOT NULL,
    heure     TEXT DEFAULT '09:00',
    motif     TEXT,
    notes     TEXT,
    statut    TEXT DEFAULT 'planifie',
    createdAt TEXT DEFAULT (datetime('now'))
  );
`);

try { db.exec("ALTER TABLE consultations ADD COLUMN heureDebut TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE consultations ADD COLUMN heureFin TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE consultations ADD COLUMN dureeMinutes INTEGER"); } catch(e) {}
try { db.exec("ALTER TABLE patients ADD COLUMN telephone2 TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE appointments ADD COLUMN notes TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE messages ADD COLUMN fichier TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE messages ADD COLUMN fichierNom TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE patients ADD COLUMN antecedents_familiaux TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE patients ADD COLUMN antecedents_chirurgicaux TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE patients ADD COLUMN vaccinations TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE patients ADD COLUMN facteurs_risque TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE patients ADD COLUMN intolerances TEXT"); } catch(e) {}

// Honoraires & Tarifs
db.exec(`
  CREATE TABLE IF NOT EXISTS tarifs (
    id          TEXT PRIMARY KEY,
    userId      TEXT NOT NULL REFERENCES users(id),
    typeActe    TEXT NOT NULL,
    montant     REAL NOT NULL DEFAULT 0,
    createdAt   TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS honoraires (
    id              TEXT PRIMARY KEY,
    consultationId  TEXT NOT NULL REFERENCES consultations(id),
    userId          TEXT NOT NULL REFERENCES users(id),
    montant         REAL NOT NULL DEFAULT 0,
    statut          TEXT DEFAULT 'non_facture',
    caisse          TEXT,
    typeActe        TEXT DEFAULT 'Consultation simple',
    dateFacturation TEXT,
    datePaiement    TEXT,
    notes           TEXT,
    createdAt       TEXT DEFAULT (datetime('now')),
    updatedAt       TEXT DEFAULT (datetime('now'))
  );
`);

// Chat inter-médecins par patient
db.exec(`
  CREATE TABLE IF NOT EXISTS discussions (
    id        TEXT PRIMARY KEY,
    patientId TEXT NOT NULL REFERENCES patients(id),
    titre     TEXT NOT NULL DEFAULT 'Discussion de cas',
    createdBy TEXT REFERENCES users(id),
    createdAt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS discussion_participants (
    discussionId TEXT NOT NULL REFERENCES discussions(id),
    userId       TEXT NOT NULL REFERENCES users(id),
    joinedAt     TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (discussionId, userId)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id           TEXT PRIMARY KEY,
    discussionId TEXT NOT NULL REFERENCES discussions(id),
    userId       TEXT NOT NULL REFERENCES users(id),
    contenu      TEXT NOT NULL,
    createdAt    TEXT DEFAULT (datetime('now'))
  );
`);

// Secretary alerts
db.exec(`
  CREATE TABLE IF NOT EXISTS secretary_alerts (
    id        TEXT PRIMARY KEY,
    userId    TEXT NOT NULL REFERENCES users(id),
    fromName  TEXT NOT NULL DEFAULT 'Secrétariat',
    message   TEXT NOT NULL,
    type      TEXT DEFAULT 'info',
    isRead    INTEGER DEFAULT 0,
    createdAt TEXT DEFAULT (datetime('now'))
  );
`);

// Seed demo doctors
if (db.prepare('SELECT COUNT(*) as n FROM users').get().n === 0) {
  const hash = bcrypt.hashSync('demo1234', 10);
  db.prepare(`INSERT INTO users (id,email,password,nom,prenom,rpps,specialite,adresse)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run('u1','dr.maiga@medivoix.fr',hash,'MAIGA','Fatoumata','10000000001','Gynécologie','Centre Diagnostic de Libreville');
  db.prepare(`INSERT INTO users (id,email,password,nom,prenom,rpps,specialite,adresse)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run('u2','dr.ekome@medpilot.fr',hash,'EKOME','Patrick','10000000002','Cardiologie','Centre Diagnostic de Libreville');
  console.log('Médecins : dr.maiga@medivoix.fr / dr.ekome@medpilot.fr — mdp : demo1234');
}

// Seed demo patients
if (db.prepare('SELECT COUNT(*) as n FROM patients').get().n === 0) {
  const ins = db.prepare(`INSERT INTO patients (id,nom,prenom,dateNaissance,sexe,telephone,email,adresse,typeAssurance,numAssurance,antecedents,allergies,traitements)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('p1','ONDO','Patience','1981-04-15','F','077 12 34 56','patience.ondo@gmail.com','Quartier Louis, Libreville','CNAMGS','CN-2341-8821','HTA, hypothyroïdie','Pénicilline','Lévothyrox 75µg, Ramipril 5mg');
  ins.run('p2','NGUEMA','Bertrand','1965-09-22','M','066 98 76 54','bertrand.nguema@gmail.com','PK8, Libreville','CNSS','SS-7712-4490','Diabète type 2, dyslipidémie','Aucune connue','Metformine 1000mg, Atorvastatine 20mg');
  ins.run('p3','OBAME','Carine','1992-12-03','F','077 11 22 33','carine.obame@gmail.com','Batterie IV, Libreville','Privée (Saham)','SAH-0034-2291','Asthme','AINS','Ventoline si besoin');
  ins.run('p4','MINTSA','Rodrigue','1978-07-30','M','066 55 44 33','rodrigue.mintsa@gmail.com','Nkembo, Libreville','CNAMGS','CN-5509-1173','Lombalgies chroniques','Codéine','Ibuprofène 400mg au besoin');
  ins.run('p5','MBOUMBA','Laetitia','2001-03-12','F','077 22 33 44','laetitia.mboumba@gmail.com','Glass, Libreville','Aucune','','Aucun','Aucune connue','Aucun');
  console.log('5 patients de démo créés');
}

// Seed demo consultations
if (db.prepare('SELECT COUNT(*) as n FROM consultations').get().n === 0) {
  const noteONDO = JSON.stringify({
    motif:"Suivi HTA et hypothyroïdie",
    histoire:"Patiente de 44 ans suivie pour HTA et hypothyroïdie sous Lévothyrox 75µg et Ramipril 5mg. Tensionnel stable depuis 3 mois. Légère fatigue persistante. Pas de céphalées ni d'œdèmes.",
    examen:"TA 128/82 mmHg, FC 74/min, poids 67 kg (stable). Pas d'œdèmes des membres inférieurs. Auscultation cardiopulmonaire normale.",
    hypotheses:"HTA bien contrôlée sous traitement. Hypothyroïdie en cours d'équilibration — TSH à contrôler.",
    conduite:"Renouvellement du traitement. Bilan biologique dans 6 semaines : TSH, T4L, ionogramme, créatininémie. RDV de contrôle à 3 mois.",
    prescriptions:"Lévothyrox 75µg : 1 cp/j à jeun. Ramipril 5mg : 1 cp/j. Bilan biologique sous 6 semaines.",
    conseils_patient:"Continuer la prise du Lévothyrox à jeun, 30 min avant le repas. Surveiller la tension à domicile. Consulter si céphalées sévères ou vision floue.",
    drapeaux_rouges:"TA > 180/110 malgré traitement, céphalées brutales intenses, troubles visuels, œdème pulmonaire.",
    cim10:{code:"I10",libelle:"Hypertension essentielle"}
  });
  const noteNGUEMA = JSON.stringify({
    motif:"Suivi diabète type 2 — contrôle glycémique",
    histoire:"Patient de 60 ans avec diabète type 2 et dyslipidémie. Glycémie capillaire à jeun entre 1,40 et 1,80 g/L selon le carnet. Pas d'hypoglycémie signalée. Poids stable.",
    examen:"Poids 82 kg, IMC 27. TA 134/86 mmHg, FC 78/min. Examen des pieds : pas de plaie, sensibilité conservée. Fond d'œil à programmer.",
    hypotheses:"Déséquilibre glycémique modéré. Risque cardiovasculaire élevé. Bilan cardiologique à compléter.",
    conduite:"Ajustement diététique renforcé. HbA1c + bilan lipidique + fond d'œil + adressage cardiologie pour évaluation du risque CV.",
    prescriptions:"Metformine 1000mg : 1 cp matin et soir avec les repas. Atorvastatine 20mg : 1 cp/j le soir. HbA1c dans 3 mois.",
    conseils_patient:"Surveiller la glycémie capillaire 2 fois/j. Régime pauvre en sucres rapides et graisses saturées. Marche 30 min/j.",
    drapeaux_rouges:"Glycémie > 3 g/L, douleurs thoraciques, essoufflement au repos, plaie du pied qui ne cicatrise pas.",
    cim10:{code:"E11",libelle:"Diabète sucré de type 2"}
  });
  const noteOBAME = JSON.stringify({
    motif:"Crise d'asthme légère",
    histoire:"Patiente de 33 ans asthmatique connue. Crise déclenchée après exposition à la fumée. Sifflements et gêne respiratoire depuis 2h. Ventoline 2 bouffées avec amélioration partielle.",
    examen:"FR 18/min, SpO2 97%. Légers sibilants bilatéraux à l'auscultation. Pas de tirage. DEP à 78% de la théorique.",
    hypotheses:"Crise d'asthme modérée sur facteur déclenchant (fumée). Bonne réponse aux bronchodilatateurs.",
    conduite:"Ventoline 2 bouffées toutes les 4h pendant 48h. Réévaluation si pas d'amélioration. Plan d'action asthme remis à la patiente.",
    prescriptions:"Ventoline (salbutamol 100µg) : 2 bouffées en cas de crise, max 4x/j. Consulter si fréquence > 3x/semaine.",
    conseils_patient:"Éviter les facteurs déclenchants : fumée, poussière, parfums forts. Toujours avoir la Ventoline avec soi.",
    drapeaux_rouges:"SpO2 < 92%, impossibilité de finir ses phrases, cyanose, crise ne cédant pas au bronchodilatateur.",
    cim10:{code:"J45",libelle:"Asthme"}
  });
  const ins = db.prepare(`INSERT INTO consultations (id,patientId,userId,motif,date,statut,noteJson,heureDebut,heureFin,dureeMinutes) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  ins.run('c1','p1','u1','Suivi HTA et hypothyroïdie','2026-03-15 09:15:00','validee',noteONDO,'09:15','09:40',25);
  ins.run('c2','p1','u1','Renouvellement ordonnance Lévothyrox','2026-03-28 10:00:00','en_cours',null,'10:00',null,null);
  ins.run('c3','p2','u1','Suivi diabète type 2 — contrôle glycémique','2026-03-20 11:00:00','validee',noteNGUEMA,'11:00','11:35',35);
  ins.run('c4','p2','u1','Bilan lipidique et prise en charge CV','2026-03-26 14:30:00','en_cours',null,'14:30',null,null);
  ins.run('c5','p3','u1','Crise d\'asthme légère','2026-03-10 08:45:00','validee',noteOBAME,'08:45','09:10',25);
  ins.run('c6','p4','u1','Lombalgie aiguë sur antécédents chroniques','2026-03-22 15:00:00','en_cours',null,'15:00',null,null);
  ins.run('c7','p5','u1','Bilan de santé préventif','2026-03-29 09:30:00','en_cours',null,'09:30',null,null);
  console.log('Consultations de démo créées');
}

// Seed demo appointments
if (db.prepare('SELECT COUNT(*) as n FROM appointments').get().n === 0) {
  const ins = db.prepare(`INSERT INTO appointments (id,patientId,userId,date,heure,motif,statut) VALUES (?,?,?,?,?,?,?)`);
  ins.run('a1','p1','u1','2026-03-31','09:00','Résultats bilan thyroïdien','planifie');
  ins.run('a2','p2','u1','2026-04-02','11:00','Suivi diabète + résultats HbA1c','confirme');
  ins.run('a3','p3','u1','2026-04-01','14:00','Contrôle asthme post-crise','confirme');
  ins.run('a4','p4','u1','2026-04-05','10:00','Suivi lombalgies — bilan imagerie','planifie');
  ins.run('a5','p5','u1','2026-04-07','09:00','Résultats bilan de santé','planifie');
  ins.run('a6','p1','u1','2026-03-30','10:30','Consultation urgente — tension élevée','confirme');
  console.log('Rendez-vous de démo créés');
}

// Seed demo honoraires
try {
  if (db.prepare('SELECT COUNT(*) as n FROM honoraires').get().n === 0) {
    const ins = db.prepare(`INSERT OR IGNORE INTO honoraires (id,consultationId,userId,montant,statut,caisse,typeActe,dateFacturation,datePaiement) VALUES (?,?,?,?,?,?,?,?,?)`);
    ins.run('h1','c1','u1',25000,'paye','CNAMGS','Consultation spécialisée','2026-03-15','2026-03-17');
    ins.run('h2','c3','u1',25000,'en_attente','CNSS','Consultation spécialisée','2026-03-20',null);
    ins.run('h3','c5','u1',20000,'paye','Privée (Saham)','Consultation simple','2026-03-10','2026-03-10');
    console.log('Honoraires de démo créés');
  }
} catch(e) { console.warn('Seed honoraires ignoré:', e.message); }

// Seed demo discussion
try { if (db.prepare('SELECT COUNT(*) as n FROM discussions').get().n === 0) {
  db.prepare(`INSERT INTO discussions (id,patientId,titre,createdBy,createdAt) VALUES (?,?,?,?,?)`).run('d1','p2','Évaluation risque cardiovasculaire — NGUEMA B.','u1','2026-03-21 08:00:00');
  db.prepare(`INSERT INTO discussion_participants (discussionId,userId,joinedAt) VALUES (?,?,?)`).run('d1','u1','2026-03-21 08:00:00');
  db.prepare(`INSERT INTO discussion_participants (discussionId,userId,joinedAt) VALUES (?,?,?)`).run('d1','u2','2026-03-21 08:05:00');
  const insMsg = db.prepare(`INSERT INTO messages (id,discussionId,userId,contenu,createdAt) VALUES (?,?,?,?,?)`);
  insMsg.run('m1','d1','u1','Bonjour Patrick, je te contacte au sujet de M. NGUEMA Bertrand, 60 ans, diabétique de type 2 avec dyslipidémie. Lors de sa consultation de suivi hier, j\'ai noté une TA à 134/86 et des glycémies entre 1,40 et 1,80 à jeun. Je pense qu\'un avis cardiologique serait utile avant d\'intensifier son traitement. Peux-tu le recevoir ?','2026-03-21 08:02:00');
  insMsg.run('m2','d1','u2','Bonjour Fatoumata, merci pour le transfert. Profil à risque CV élevé en effet, diabète + dyslipidémie + légère HTA. Je peux le voir semaine du 7 avril. Il faudrait qu\'il ait fait son ECG et son bilan lipidique complet avant. Tu peux les prescrire de ton côté ?','2026-03-21 08:45:00');
  insMsg.run('m3','d1','u1','Parfait, je lui prescris l\'ECG + lipides complets + créatininémie dès aujourd\'hui. Je lui fixe le RDV au 9 avril chez toi. Je t\'envoie le compte-rendu de consultation dès qu\'il est validé.','2026-03-21 09:10:00');
  insMsg.run('m4','d1','u2','Super. N\'hésite pas à me contacter si la situation évolue défavorablement. À bientôt.','2026-03-21 09:15:00');
  console.log('Discussion de démo créée');
}} catch(e) { console.warn('Seed discussion ignoré:', e.message); }

// Seed secretary alerts
if (db.prepare('SELECT COUNT(*) as n FROM secretary_alerts').get().n === 0) {
  const insA = db.prepare(`INSERT INTO secretary_alerts (id,userId,fromName,message,type,isRead,createdAt) VALUES (?,?,?,?,?,?,?)`);
  insA.run('a1','u1','Marie-Claire (Secrétariat)','M. Nguema a appelé : il demande un renouvellement d\'ordonnance urgent (Metformine). Il ne peut pas se déplacer cette semaine.','urgent','0','2026-03-30 07:45:00');
  insA.run('a2','u1','Marie-Claire (Secrétariat)','Rappel : la patiente Mme Obame a un rendez-vous de contrôle asthme demain à 10h. Elle confirme sa présence.','rdv','0','2026-03-29 16:30:00');
  insA.run('a3','u1','Marie-Claire (Secrétariat)','Le laboratoire Biomédical a transmis les résultats de Mme Ondo (TSH, T4L). Résultats disponibles en pièce jointe.','info','0','2026-03-28 14:00:00');
  insA.run('a4','u1','Marie-Claire (Secrétariat)','CNAMGS a retourné 2 feuilles de soins pour complément de dossier (Nguema et Mintsa). À régulariser avant le 5 avril.','admin','0','2026-03-27 09:00:00');
  console.log('Alertes secrétaire de démo créées');
}

export default db;
