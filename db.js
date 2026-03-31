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

// ── DEMO DATA v2 ─────────────────────────────────────────────────────────────

// Ensure u2 exists (for DBs created before u2 was added to seed)
try {
  if (db.prepare("SELECT COUNT(*) as n FROM users WHERE id='u2'").get().n === 0) {
    const hash2 = bcrypt.hashSync('demo1234', 10);
    db.prepare(`INSERT OR IGNORE INTO users (id,email,password,nom,prenom,rpps,specialite,adresse) VALUES (?,?,?,?,?,?,?,?)`)
      .run('u2','dr.ekome@medpilot.fr',hash2,'EKOME','Patrick','10000000002','Cardiologie','Centre Diagnostic de Libreville');
    console.log('Médecin u2 (dr.ekome) ajouté');
  }
} catch(e) { console.warn('Seed u2 ignoré:', e.message); }

// Update p1-p5 with extended fields
try {
  const upd = db.prepare(`UPDATE patients SET
    antecedents_familiaux=?,antecedents_chirurgicaux=?,vaccinations=?,facteurs_risque=?,intolerances=?
    WHERE id=? AND antecedents_familiaux IS NULL`);
  upd.run(
    'Mère : HTA + diabète. Père : cardiopathie ischémique (IDM à 58 ans).',
    'Appendicectomie (2001). Kyste ovarien (2018).',
    'DTP à jour (2023). Hépatite B (3 doses). Fièvre jaune (2022).',
    'Sédentarité, surpoids (IMC 27), stress professionnel.',
    'Pénicilline (urticaire), AINS (dyspepsie sévère).',
    'p1'
  );
  upd.run(
    'Père : diabète type 2 + HTA. Frère : IDM à 52 ans.',
    'Hernie inguinale droite (2010).',
    'DTP (2022). Hépatite B à jour. Pneumocoque (2023).',
    'Tabac actif (15 PA), sédentarité, surpoids (IMC 27), stress.',
    'Aucune intolélance connue.',
    'p2'
  );
  upd.run(
    'Mère : asthme allergique. Pas d\'antécédents cardiaques familiaux.',
    'Aucune intervention chirurgicale.',
    'DTP à jour. Grippe annuelle. Pas de vaccin pneumocoque.',
    'Tabagisme passif (conjoint fumeur), exposition professionnelle (coiffeuse).',
    'AINS (bronchospasme), aspirine (suspicion).',
    'p3'
  );
  upd.run(
    'Père : lombalgie chronique (discopathie L4-L5). Pas de cancer familial.',
    'Discectomie L5-S1 (2015). Arthroscopie genou gauche (2020).',
    'DTP (2021). Hépatite B incomplet (2 doses).',
    'Travail physique (manutentionnaire), tabac 10 PA sevré en 2022, surpoids léger.',
    'Codéine (somnolence excessive), codéinés (nausées).',
    'p4'
  );
  upd.run(
    'Mère en bonne santé. Grand-père paternel : AVC à 70 ans.',
    'Amygdalectomie (2009).',
    'DTP à jour (2024). Hépatite B à compléter (1 dose). Rubéole vérifiée.',
    'Sédentarité étudiante, légère anxiété situationnelle. Non fumeuse.',
    'Aucune intolélance connue.',
    'p5'
  );
  console.log('Patients p1-p5 : champs étendus mis à jour');
} catch(e) { console.warn('Update patients étendus ignoré:', e.message); }

// Add 5 new patients p6-p10
try {
  if (db.prepare("SELECT COUNT(*) as n FROM patients WHERE id='p6'").get().n === 0) {
    const ins = db.prepare(`INSERT OR IGNORE INTO patients
      (id,nom,prenom,dateNaissance,sexe,telephone,email,adresse,typeAssurance,numAssurance,
       antecedents,allergies,traitements,antecedents_familiaux,antecedents_chirurgicaux,
       vaccinations,facteurs_risque,intolerances)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    ins.run('p6','ASSOUMOU','Marie-Claire','1974-02-28','F','077 60 11 22',
      'mclaire.assoumou@gmail.com','Akanda, Libreville','CNAMGS','CN-8801-3342',
      'Cardiopathie hypertensive, fibrillation auriculaire paroxystique',
      'Sulfamides','Bisoprolol 5mg, Amlodipine 5mg, Apixaban 5mg x2/j',
      'Mère : HTA sévère + AVC. Père : FA chronique.',
      'Valvuloplastie mitrale percutanée (2019).',
      'DTP à jour. Grippe annuelle. Pneumocoque (2024).',
      'HTA mal équilibrée par le passé, ménopause précoce (47 ans), stress.',
      'Sulfamides (réaction cutanée grave), AINS (risque hémorragique sous anticoagulant).'
    );
    ins.run('p7','BONGO','Théodore','1987-11-14','M','066 33 77 88',
      'theo.bongo@gmail.com','Owendo, Libreville','CNSS','SS-4421-9900',
      'Infection VIH sous ARV (Atripla depuis 2020), hépatite B chronique',
      'Cotrimoxazole','Atripla (ténofovir/emtricitabine/éfavirenz) 1cp/j',
      'Pas d\'antécédents familiaux connus (orphelin).',
      'Appendicectomie (2005).',
      'Hépatite B (couverture incomplète — ARV actif). DTP (2023).',
      'Charge virale indétectable. CD4 à surveiller. Non fumeur, abstinent.',
      'Cotrimoxazole (éruption). Névirapine (toxicité hépatique, passé).'
    );
    ins.run('p8','NKOGHE','Solange','1997-06-20','F','077 44 55 66',
      'solange.nkoghe@gmail.com','Hauts de Gué-Gué, Libreville','Privée (SUNU)','SUNU-2034-7713',
      'Grossesse G1P0 — 24 SA. Aucun antécédent médical notable.',
      'Aucune','Acide folique 5mg/j, Fer 80mg/j, Calcium 1g/j',
      'Mère : diabète gestationnel lors de 2 grossesses.',
      'Aucune intervention.',
      'DTP à jour. Rubéole immunisée. Grippe (recommandée, en cours).',
      'Primipare. Pas de tabac, pas d\'alcool. Prise de poids modérée (+5kg).',
      'Aucune intolélance connue.'
    );
    ins.run('p9','LEYAMA','Paul','1959-03-08','M','066 19 28 37',
      'paul.leyama@gmail.com','PK12, Libreville','CNAMGS','CN-1122-5567',
      'MRC stade 3b (DFG 38 mL/min), HTA résistante, diabète type 2, FAV posée (bras gauche)',
      'IEC (toux sèche sévère)','Amlodipine 10mg, Furosémide 40mg, Insuline NPH 20UI soir, Bicarbonate de sodium 500mg x3/j',
      'Père : IRC terminale (décédé à 64 ans). Frère : diabète type 2.',
      'FAV radio-céphalique bras gauche (2024). Biopsie rénale (2023).',
      'DTP à jour. Hépatite B (3 doses). Grippe annuelle. Pneumocoque.',
      'Diabète depuis 18 ans, HTA résistante, surpoids (IMC 29), sédentarité.',
      'IEC (toux sèche intense), potassium > 5,5 (hyperkaliémie sous spironolactone).'
    );
    ins.run('p10','MOUSSAVOU','Françoise','1980-08-25','F','077 88 99 00',
      'francoise.moussavou@gmail.com','Quartier Nombakélé, Libreville','CNSS','SS-6634-2281',
      'Trouble anxieux généralisé, insomnie chronique, burn-out professionnel',
      'Benzodiazépines (dépendance)','Sertraline 50mg/j (3 mois), Mélatonine 2mg le soir, Psychothérapie TCC en cours',
      'Mère : dépression récurrente. Père : alcoolisme.',
      'Aucune intervention chirurgicale.',
      'DTP à jour.',
      'Surcharge professionnelle (cadre dirigeante), divorce récent, 2 enfants à charge.',
      'Benzodiazépines (tolérance et rebond anxieux), alcool (interaction ISRS).'
    );
    console.log('5 nouveaux patients p6-p10 créés');
  }
} catch(e) { console.warn('Seed patients v2 ignoré:', e.message); }

// Ensure original consultations c1-c7 exist (guard against skipped seed)
try {
  if (db.prepare("SELECT COUNT(*) as n FROM consultations WHERE id='c1'").get().n === 0) {
    const noteONDO2 = JSON.stringify({motif:"Suivi HTA et hypothyroïdie",histoire:"Patiente de 44 ans suivie pour HTA et hypothyroïdie sous Lévothyrox 75µg et Ramipril 5mg. Tensionnel stable depuis 3 mois. Légère fatigue persistante.",examen:"TA 128/82 mmHg, FC 74/min, poids 67 kg (stable). Pas d'œdèmes.",hypotheses:"HTA bien contrôlée. Hypothyroïdie en cours d'équilibration — TSH à contrôler.",conduite:"Renouvellement du traitement. Bilan biologique dans 6 semaines : TSH, T4L, ionogramme, créatinine.",prescriptions:"Lévothyrox 75µg : 1 cp/j à jeun. Ramipril 5mg : 1 cp/j.",conseils_patient:"Continuer la prise du Lévothyrox à jeun. Surveiller la tension à domicile.",drapeaux_rouges:"TA > 180/110 malgré traitement, céphalées brutales, troubles visuels.",cim10:{code:"I10",libelle:"Hypertension essentielle"}});
    const noteNGUEMA2 = JSON.stringify({motif:"Suivi diabète type 2 — contrôle glycémique",histoire:"Patient de 60 ans avec diabète type 2 et dyslipidémie. Glycémie capillaire à jeun entre 1,40 et 1,80 g/L. Pas d'hypoglycémie.",examen:"Poids 82 kg, IMC 27. TA 134/86 mmHg. Pieds : pas de plaie.",hypotheses:"Déséquilibre glycémique modéré. Risque cardiovasculaire élevé.",conduite:"Ajustement diététique renforcé. HbA1c + bilan lipidique + fond d'œil + adressage cardiologie.",prescriptions:"Metformine 1000mg : 1 cp matin et soir. Atorvastatine 20mg : 1 cp/j le soir.",conseils_patient:"Surveiller la glycémie capillaire 2 fois/j. Régime pauvre en sucres rapides.",drapeaux_rouges:"Glycémie > 3 g/L, douleurs thoraciques, plaie du pied.",cim10:{code:"E11",libelle:"Diabète sucré de type 2"}});
    const noteOBAME2 = JSON.stringify({motif:"Crise d'asthme légère",histoire:"Patiente de 33 ans asthmatique. Crise déclenchée après exposition à la fumée. Ventoline 2 bouffées avec amélioration partielle.",examen:"FR 18/min, SpO2 97%. Légers sibilants bilatéraux. DEP à 78%.",hypotheses:"Crise d'asthme modérée sur facteur déclenchant. Bonne réponse aux bronchodilatateurs.",conduite:"Ventoline 2 bouffées toutes les 4h pendant 48h. Plan d'action asthme remis.",prescriptions:"Ventoline (salbutamol 100µg) : 2 bouffées en cas de crise.",conseils_patient:"Éviter les facteurs déclenchants : fumée, poussière, parfums.",drapeaux_rouges:"SpO2 < 92%, impossibilité de finir ses phrases, crise ne cédant pas.",cim10:{code:"J45",libelle:"Asthme"}});
    const ins2 = db.prepare(`INSERT OR IGNORE INTO consultations (id,patientId,userId,motif,date,statut,noteJson,heureDebut,heureFin,dureeMinutes) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    ins2.run('c1','p1','u1','Suivi HTA et hypothyroïdie','2026-03-15 09:15:00','validee',noteONDO2,'09:15','09:40',25);
    ins2.run('c2','p1','u1','Renouvellement ordonnance Lévothyrox','2026-03-28 10:00:00','en_cours',null,'10:00',null,null);
    ins2.run('c3','p2','u1','Suivi diabète type 2 — contrôle glycémique','2026-03-20 11:00:00','validee',noteNGUEMA2,'11:00','11:35',35);
    ins2.run('c4','p2','u1','Bilan lipidique et prise en charge CV','2026-03-26 14:30:00','en_cours',null,'14:30',null,null);
    ins2.run('c5','p3','u1','Crise d\'asthme légère','2026-03-10 08:45:00','validee',noteOBAME2,'08:45','09:10',25);
    ins2.run('c6','p4','u1','Lombalgie aiguë sur antécédents chroniques','2026-03-22 15:00:00','en_cours',null,'15:00',null,null);
    ins2.run('c7','p5','u1','Bilan de santé préventif','2026-03-29 09:30:00','en_cours',null,'09:30',null,null);
    console.log('Consultations c1-c7 (récupération) créées');
  }
} catch(e) { console.warn('Seed c1-c7 récupération ignoré:', e.message); }

// Add rich consultation history
try {
  const ins = db.prepare(`INSERT OR IGNORE INTO consultations
    (id,patientId,userId,motif,date,statut,noteJson,heureDebut,heureFin,dureeMinutes)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  // ONDO Patience — historique
  ins.run('c1b','p1','u1','Bilan thyroïdien — TSH élevée','2025-11-12 10:00:00','validee', JSON.stringify({
    motif:"Bilan thyroïdien — TSH élevée",
    histoire:"Patiente de 44 ans, fatigue intense depuis 6 semaines, prise de poids de 3kg, constipation. Bilan biologique demandé.",
    examen:"TA 136/84 mmHg, FC 62/min. Légère bradycardie. Thyroïde non palpable. Réflexes ostéotendineux lents.",
    hypotheses:"Hypothyroïdie décompensée sur Lévothyrox sous-dosé. TSH à 8.4 µUI/mL (N<4).",
    conduite:"Augmentation Lévothyrox de 75 à 100µg. Contrôle TSH dans 6 semaines. Conseil diététique pour la prise de poids.",
    prescriptions:"Lévothyrox 100µg : 1cp/j à jeun, 30min avant repas. Contrôle TSH + T4L dans 6 semaines.",
    conseils_patient:"Ne pas changer la dose sans avis médical. Éviter thé, café et calcium dans l'heure suivant la prise.",
    drapeaux_rouges:"Palpitations, tachycardie, nervosité excessive : TSH trop basse possible, consulter.",
    cim10:{code:"E03.9",libelle:"Hypothyroïdie, sans précision"}
  }),'10:00','10:30',30);

  ins.run('c1c','p1','u1','Renouvellement et suivi tensionnel','2025-08-20 09:00:00','validee', JSON.stringify({
    motif:"Renouvellement ordonnances — suivi tensionnel",
    histoire:"Suivi trimestriel. Tension bien contrôlée à domicile entre 125 et 135/80. Pas d'effet secondaire signalé. Observance bonne.",
    examen:"TA 130/80 mmHg au cabinet. FC 70/min. Pas d'œdème. Auscultation normale.",
    hypotheses:"HTA bien contrôlée sous Ramipril 5mg. Hypothyroïdie stable.",
    conduite:"Renouvellement du traitement pour 3 mois. Bilan annuel à programmer.",
    prescriptions:"Lévothyrox 75µg : 1cp/j. Ramipril 5mg : 1cp/j. Bilan annuel : TSH, ionogramme, créatinine, lipides, glycémie.",
    conseils_patient:"Continuer la surveillance tensionnelle à domicile. Régime pauvre en sel.",
    drapeaux_rouges:"TA > 180/110, céphalées en coup de tonnerre, douleurs thoraciques.",
    cim10:{code:"I10",libelle:"Hypertension essentielle"}
  }),'09:00','09:25',25);

  // NGUEMA Bertrand — historique
  ins.run('c2b','p2','u1','Résultats HbA1c — déséquilibre glycémique','2025-12-05 11:30:00','validee', JSON.stringify({
    motif:"Résultats HbA1c — déséquilibre glycémique",
    histoire:"HbA1c à 8,9% (objectif < 7%). Patient peu compliant au régime. Glycémies capillaires irrégulières. Poids stable à 82 kg.",
    examen:"TA 138/88 mmHg. FC 76/min. IMC 27. Pieds : pas de plaie, sensibilité conservée.",
    hypotheses:"Diabète type 2 déséquilibré. Résistance à l'insuline probable. Risque microangiopathique.",
    conduite:"Ajout de Glicazide 30mg au traitement. Objectif HbA1c < 7,5% à 3 mois. Diététicienne adressée. Fond d'œil urgent.",
    prescriptions:"Metformine 1000mg x2/j. Glicazide LP 30mg : 1cp/j au petit-déjeuner. Atorvastatine 20mg maintenue.",
    conseils_patient:"Glycémies capillaires 3x/j. Alimentation : éliminer boissons sucrées, féculents raffinés. Marche 30 min/j.",
    drapeaux_rouges:"Glycémie < 0,70 (hypoglycémie) : resucrage immédiat. Glycémie > 3 g/L : urgences.",
    cim10:{code:"E11.9",libelle:"Diabète sucré de type 2 sans complication"}
  }),'11:30','12:05',35);

  ins.run('c2c','p2','u1','Consultation initiale diabète — diagnostic','2024-06-18 10:00:00','validee', JSON.stringify({
    motif:"Bilan glycémie élevée découverte en médecine du travail",
    histoire:"Glycémie à jeun à 1,85 g/L lors du bilan annuel du travail. Patient asymptomatique. Pas de syndrome polyuro-polydipsique signalé. Poids 80 kg.",
    examen:"TA 140/90 mmHg, FC 80/min, poids 80 kg, taille 174 cm (IMC 26,4). Fond d'œil : normal.",
    hypotheses:"Diabète type 2 nouvellement diagnostiqué. HTA associée.",
    conduite:"Instauration Metformine 500mg x2/j (titration progressive). Règles hygiéno-diététiques. Bilan complémentaire complet.",
    prescriptions:"Metformine 500mg : 1cp matin et soir avec les repas pendant 2 semaines, puis 1000mg x2/j. HbA1c + lipides + créatinine + micro-albuminurie dans 3 mois.",
    conseils_patient:"Réduction sucres rapides, graisses saturées. Activité physique 150min/semaine. Arrêt du tabac conseillé.",
    drapeaux_rouges:"Nausées sévères sous Metformine (diminuer dose), essoufflement, douleurs abdominales.",
    cim10:{code:"E11",libelle:"Diabète sucré de type 2"}
  }),'10:00','10:50',50);

  // OBAME Carine — historique
  ins.run('c3b','p3','u1','Suivi asthme — révision traitement de fond','2025-10-28 14:00:00','validee', JSON.stringify({
    motif:"Suivi asthme persistant léger — révision traitement de fond",
    histoire:"Fréquence des crises : 2-3 fois par semaine depuis 1 mois. Utilisation Ventoline > 3x/semaine. Retentissement sur le sommeil.",
    examen:"FR 16/min, SpO2 99%. DEP : 85% de la théorique. Auscultation : propre au repos.",
    hypotheses:"Asthme persistant léger non contrôlé. Passage à un traitement de fond recommandé.",
    conduite:"Introduction Flixotide 50µg : 2 bouffées x2/j (CSI faible dose). Réévaluation dans 4 semaines. Enquête allergologique à programmer.",
    prescriptions:"Flixotide 50µg : 2 bouffées matin et soir (rincer bouche après). Ventoline en réserve uniquement si crise.",
    conseils_patient:"Ne pas arrêter le traitement de fond même en période calme. Éviter triggers. Tenir un journal des crises.",
    drapeaux_rouges:"Crise sévère ne cédant pas à la Ventoline, SpO2 < 92%, parole impossible.",
    cim10:{code:"J45.1",libelle:"Asthme allergique persistant léger"}
  }),'14:00','14:35',35);

  // MINTSA Rodrigue — historique
  ins.run('c4b','p4','u1','Lombalgie aiguë — épisode de rechute','2025-09-15 16:00:00','validee', JSON.stringify({
    motif:"Rechute lombalgie aiguë après effort de soulèvement",
    histoire:"Patient manutentionnaire. Douleur L4-L5 brutale après port de charge 40 kg. EVA 7/10 au repos. Irradiation jusqu'à la fesse droite. Pas de déficit moteur.",
    examen:"Contracture paravertébrale lombaire bilatérale. Lasègue droit positif à 45°. ROT conservés. Pas de déficit sensitif.",
    hypotheses:"Lombalgie aiguë par contracture + possible hernie L4-L5 de confirmation. Pas de signe de gravité.",
    conduite:"Ibuprofène 400mg x3/j (7 jours). Myorelaxant : Méthocarbamol 750mg x3/j. Arrêt de travail 5 jours. IRM lombaire programmée.",
    prescriptions:"Ibuprofène 400mg : 1cp x3/j au repas pendant 7 jours. Myorelaxant 750mg x3/j. Arrêt de travail 5 jours.",
    conseils_patient:"Éviter le port de charges. Mouvements de chaleur locale. Reprise progressive. Kinésithérapie à envisager.",
    drapeaux_rouges:"Troubles sphinctériens (urines/selles), déficit moteur d'installation rapide, douleur insomniante.",
    cim10:{code:"M54.5",libelle:"Lombalgie basse"}
  }),'16:00','16:40',40);

  // MBOUMBA Laetitia — historique
  ins.run('c5b','p5','u1','Consultation générale — première visite','2025-07-10 09:30:00','validee', JSON.stringify({
    motif:"Première visite — établissement du dossier médical",
    histoire:"Patiente de 24 ans, étudiante, en bonne santé apparente. Pas d'antécédent notable. Venue pour bilan de santé et mise à jour vaccins.",
    examen:"TA 112/70, FC 66/min, poids 58 kg, taille 168 cm (IMC 20,6). Examen général normal.",
    hypotheses:"Patiente en bonne santé. Vaccination hépatite B incomplète.",
    conduite:"Bilan sanguin complet : NFS, glycémie, lipides, TSH, créatinine, sérologies hépatites A et B. Vaccination HVB à compléter.",
    prescriptions:"Bilan biologique complet. Vaccin HVB dose 1 réalisée ce jour. Rappel à 1 mois puis 6 mois.",
    conseils_patient:"Revenir avec les résultats du bilan dans 15 jours. Conserver le carnet de vaccination.",
    drapeaux_rouges:"Aucun signalé.",
    cim10:{code:"Z00.0",libelle:"Examen médical général"}
  }),'09:30','10:00',30);

  // ASSOUMOU Marie-Claire (p6)
  ins.run('c6a','p6','u1','Bilan cardiologique — FA paroxystique confirmée','2026-02-10 09:00:00','validee', JSON.stringify({
    motif:"Palpitations intermittentes — confirmation FA paroxystique",
    histoire:"Patiente de 52 ans, HTA connue. Palpitations depuis 3 semaines, durée 20-30 min, résolution spontanée. Légère dyspnée d'effort stade II NYHA. Bilan Holter Holter demandé.",
    examen:"TA 148/92 mmHg, FC 78/min (rythme sinusal au repos). Auscultation cardiaque : pas de souffle. Holter 24h : 3 épisodes FA paroxystique < 30 min.",
    hypotheses:"FA paroxystique sur cardiopathie hypertensive. Score CHA₂DS₂-VASc = 4 → anticoagulation indiquée.",
    conduite:"Introduction Apixaban 5mg x2/j. Maintien Bisoprolol et Amlodipine. Echocardiographie trans-thoracique. Bilan thyroïdien. Adressage rythmologie.",
    prescriptions:"Apixaban 5mg : 1cp matin et soir (ne pas oublier). Bisoprolol 5mg x1/j. Amlodipine 5mg x1/j. ETT + TSH + NFS + INR sous 3 semaines.",
    conseils_patient:"Ne jamais arrêter l'Apixaban sans avis médical. Éviter ibuprofène, aspirine. Signaler tout saignement inhabituel.",
    drapeaux_rouges:"Palpitations durables > 1h, syncope, douleurs thoraciques, saignement anormal.",
    cim10:{code:"I48.0",libelle:"Fibrillation auriculaire paroxystique"}
  }),'09:00','09:50',50);

  ins.run('c6b','p6','u2','Avis cardiologie — ETT et stratégie rythmologique','2026-03-05 14:00:00','validee', JSON.stringify({
    motif:"Avis cardiologique — ETT résultats + stratégie antiarythmique",
    histoire:"ETT : FEVG 58%, OG légèrement dilatée (42mm), pas de valvulopathie significative. Pas de thrombus. Anticoagulation en place depuis 3 semaines.",
    examen:"TA 140/88 mmHg (mieux contrôlée). FC 72/min sinusal. Pas de signes de décompensation.",
    hypotheses:"FA paroxystique sans cardiopathie structurelle significative. Contrôle du rythme privilégié à ce stade.",
    conduite:"Introduction Flécaïnide 100mg x2/j (après vérification FEVG et QRS). Poursuite Apixaban. RDV dans 6 semaines pour Holter de contrôle.",
    prescriptions:"Flécaïnide 100mg : 1cp matin et soir. Apixaban 5mg x2/j maintenu. Bisoprolol 5mg réduit à 2,5mg si FC < 55.",
    conseils_patient:"Prendre le Flécaïnide avec les repas. Signaler tout vertige, vision trouble ou nouveau trouble du rythme.",
    drapeaux_rouges:"Malaise, perte de connaissance, ECG avec flutter 1:1 (risque sous Flécaïnide seul).",
    cim10:{code:"I48.0",libelle:"Fibrillation auriculaire paroxystique"}
  }),'14:00','14:45',45);

  // BONGO Théodore (p7)
  ins.run('c7a','p7','u1','Suivi VIH — bilan CD4 et charge virale','2026-01-20 11:00:00','validee', JSON.stringify({
    motif:"Suivi semestriel VIH sous Atripla",
    histoire:"Patient de 38 ans sous Atripla depuis 2020. Bonne observance autodéclarée. Pas d'effet secondaire notable. Hépatite B en co-infection traitée par ténofovir (composant Atripla).",
    examen:"Poids 72 kg (stable). TA 118/76, FC 68/min. Pas d'adénopathie palpable. Peau et muqueuses normales. Pas de candidose.",
    hypotheses:"VIH contrôlé. Charge virale indétectable (< 20 copies/mL). CD4 à 680 cells/µL. Hépatite B : ADN VHB indétectable.",
    conduite:"Poursuite Atripla. Bilan annuel : glycémie, lipides, créatinine, ASAT/ALAT, NFS. Dépistage IST. Consultation dans 6 mois.",
    prescriptions:"Atripla 1cp/j le soir au coucher (sans interruption). Bilan biologique dans 6 mois.",
    conseils_patient:"Ne jamais interrompre le traitement sans avis médical. Protection rapports sexuels. Pas d'alcool en excès.",
    drapeaux_rouges:"Fièvre inexpliquée > 38,5°C, amaigrissement > 5%, diarrhée prolongée, lésions cutanées atypiques.",
    cim10:{code:"B20",libelle:"Maladie due au VIH avec maladies infectieuses et parasitaires"}
  }),'11:00','11:40',40);

  // NKOGHE Solange (p8)
  ins.run('c8a','p8','u1','Consultation prénatale — 24 SA','2026-03-18 10:00:00','validee', JSON.stringify({
    motif:"Consultation prénatale du 6e mois — 24 SA",
    histoire:"Primipare de 29 ans. Grossesse bien tolérée. Légères nausées le matin en diminution. Mouvements actifs bien perçus depuis 20 SA. Pas de métrorragies, pas de contractions.",
    examen:"TA 110/70 mmHg. Poids 63 kg (+5kg depuis début grossesse). HU 24 cm (concordant). BCF 144/min réguliers. Pas d'œdème.",
    hypotheses:"Grossesse évolutive normale à 24 SA. Bonne croissance fœtale. Pas de complication.",
    conduite:"Échographie morphologique à 22 SA normale (rendu). Glycémie de dépistage HGPO 75g à programmer (24-28 SA). Groupe sanguin et RAI rappelés.",
    prescriptions:"Acide folique 5mg/j jusqu'à 28 SA. Fer 80mg/j en dehors des repas. Calcium 1g/j. HGPO 75g dans 2 semaines.",
    conseils_patient:"Dormir sur le côté gauche. Éviter alimentation à risque (listériose). Cours de préparation à la naissance.",
    drapeaux_rouges:"Métrorragies, contractions régulières avant 37 SA, perte de liquide amniotique, absence de MVF sur 12h.",
    cim10:{code:"Z34.2",libelle:"Surveillance de grossesse normale — deuxième trimestre"}
  }),'10:00','10:40',40);

  // LEYAMA Paul (p9)
  ins.run('c9a','p9','u1','Suivi MRC stade 3b — ajustement traitement','2026-03-10 09:00:00','validee', JSON.stringify({
    motif:"Suivi néphro-diabétique — MRC stade 3b",
    histoire:"Patient de 67 ans. DFG stable à 38 mL/min (–2 depuis 6 mois). HTA difficile à contrôler malgré 3 molécules. Glycémies moins instables sous insuline. FAV fonctionnelle mais non utilisée (préparation dialyse).",
    examen:"TA 158/94 mmHg au cabinet. FC 72/min. Poids 84 kg (+2kg, œdème cheville +++). FAV : frémissement palpable, souffle ausculté.",
    hypotheses:"MRC stade 3b stable mais HTA résistante. Surcharge hydrosodée. Optimisation diurétique nécessaire.",
    conduite:"Augmentation Furosémide à 80mg. Restriction sodée et hydrique renforcée. Adressage néphrologue pour programmation dialyse. Ajout spironolactone différé (risque K+).",
    prescriptions:"Furosémide 80mg/j le matin. Amlodipine 10mg maintenue. Bicarbonate sodium 500mg x3/j. Régime : sel < 3g/j, eau < 1,5L/j. Bilan MRC complet dans 1 mois.",
    conseils_patient:"Peser chaque matin. Si +2kg en 2 jours : consulter. Éviter AINS, produits de contraste, néphrotoxiques.",
    drapeaux_rouges:"OAP (orthopnée, dyspnée sévère), anurie, kaliémie > 5,5 (crampes, palpitations), confusion.",
    cim10:{code:"N18.3",libelle:"Maladie rénale chronique, stade 3"}
  }),'09:00','09:55',55);

  // MOUSSAVOU Françoise (p10)
  ins.run('c10a','p10','u1','Consultation initiale — burnout et anxiété','2026-01-08 16:00:00','validee', JSON.stringify({
    motif:"Épuisement professionnel et anxiété généralisée",
    histoire:"Patiente de 45 ans, cadre dirigeante. Depuis 4 mois : fatigue intense, insomnie d'endormissement, irritabilité, difficultés de concentration, sentiment d'échec. Divorce récent. Pas d'idées suicidaires.",
    examen:"Patiente fatiguée mais coopérante. TA 118/76, FC 82/min. Pas de signe d'organicité. Score HAD : anxiété 14/21, dépression 8/21.",
    hypotheses:"Syndrome d'épuisement professionnel (burn-out). Trouble anxieux généralisé associé. Pas de dépression caractérisée.",
    conduite:"Introduction Sertraline 50mg/j. Mélatonine 2mg le soir. Arrêt de travail 1 mois. Psychothérapie TCC adressée. Réévaluation à 4 semaines.",
    prescriptions:"Sertraline 50mg : 1cp/j le matin avec repas (effets attendus à 3-4 semaines). Mélatonine 2mg : 30min avant coucher. Arrêt de travail 1 mois.",
    conseils_patient:"L'ISRS prend 3-4 semaines à agir. Ne pas arrêter brutalement. Limiter écrans le soir. Activité physique douce.",
    drapeaux_rouges:"Idées suicidaires, agitation intense sous Sertraline (syndrome sérotoninergique rare), alcool à éviter absolument.",
    cim10:{code:"F41.1",libelle:"Anxiété généralisée"}
  }),'16:00','17:00',60);

  ins.run('c10b','p10','u1','Suivi burn-out — réévaluation à 4 semaines','2026-02-05 16:00:00','validee', JSON.stringify({
    motif:"Réévaluation anxiété et burn-out sous Sertraline",
    histoire:"Patiente en légère amélioration. Insomnie réduite (endormissement en 45min vs 2h). Anxiété encore présente mais moins invalidante. A débuté la psychothérapie TCC (3 séances). Arrêt de travail prolongé 1 mois.",
    examen:"TA 116/74, FC 78/min. Humeur : mieux mais encore fluctuante. Score HAD : anxiété 10/21, dépression 6/21 (amélioration).",
    hypotheses:"Réponse partielle à la Sertraline. Poursuite du traitement. Maintien TCC.",
    conduite:"Maintien Sertraline 50mg. Arrêt de travail prolongé 1 mois supplémentaire. RDV dans 6 semaines.",
    prescriptions:"Sertraline 50mg : continuer. Mélatonine 2mg maintenue. Arrêt de travail 1 mois renouvelé.",
    conseils_patient:"Continuer la TCC régulièrement. Reprendre une activité physique légère (marche, yoga). Pas d'alcool.",
    drapeaux_rouges:"Toute pensée de passage à l'acte : appeler le 15 ou se rendre aux urgences immédiatement.",
    cim10:{code:"Z73.0",libelle:"Surmenage — burn-out"}
  }),'16:00','16:40',40);

  console.log('Consultations v2 créées (c1b, c1c, c2b, c2c, c3b, c4b, c5b, c6a-b, c7a, c8a, c9a, c10a-b)');
} catch(e) { console.warn('Seed consultations v2 ignoré:', e.message); }

// Add prescriptions (schema: id, consultationId, lignes JSON, validee, createdAt)
try {
  if (db.prepare("SELECT COUNT(*) as n FROM prescriptions WHERE id='rx1'").get().n === 0) {
    const ins = db.prepare(`INSERT OR IGNORE INTO prescriptions (id,consultationId,lignes,validee,createdAt) VALUES (?,?,?,?,?)`);
    ins.run('rx1','c1', JSON.stringify([
      {medicament:'Lévothyrox 75µg', posologie:'1 cp/j à jeun 30 min avant repas', duree:'3 mois'},
      {medicament:'Ramipril 5mg', posologie:'1 cp/j le matin', duree:'3 mois'}
    ]), 1, '2026-03-15 09:40:00');
    ins.run('rx2','c3', JSON.stringify([
      {medicament:'Metformine 1000mg', posologie:'1 cp matin et soir avec les repas', duree:'3 mois'},
      {medicament:'Atorvastatine 20mg', posologie:'1 cp le soir', duree:'3 mois'}
    ]), 1, '2026-03-20 11:35:00');
    ins.run('rx3','c5', JSON.stringify([
      {medicament:'Ventoline (salbutamol 100µg)', posologie:'2 bouffées en cas de crise, max 4x/j', duree:'À la demande'}
    ]), 1, '2026-03-10 09:10:00');
    ins.run('rx4','c6a', JSON.stringify([
      {medicament:'Apixaban 5mg', posologie:'1 cp matin et soir — ne jamais interrompre', duree:'Indéfini'},
      {medicament:'Bisoprolol 5mg', posologie:'1 cp/j le matin', duree:'3 mois'},
      {medicament:'Amlodipine 5mg', posologie:'1 cp/j le matin', duree:'3 mois'}
    ]), 1, '2026-02-10 09:50:00');
    ins.run('rx5','c10a', JSON.stringify([
      {medicament:'Sertraline 50mg', posologie:'1 cp/j le matin avec repas', duree:'3 mois'},
      {medicament:'Mélatonine 2mg', posologie:'1 cp 30 min avant coucher', duree:'3 mois'}
    ]), 1, '2026-01-08 17:00:00');
    ins.run('rx6','c9a', JSON.stringify([
      {medicament:'Furosémide 80mg', posologie:'1 cp le matin', duree:'Continu'},
      {medicament:'Amlodipine 10mg', posologie:'1 cp/j', duree:'Continu'},
      {medicament:'Bicarbonate de sodium 500mg', posologie:'1 cp x3/j', duree:'Continu'}
    ]), 1, '2026-03-10 09:55:00');
    ins.run('rx7','c8a', JSON.stringify([
      {medicament:'Acide folique 5mg', posologie:'1 cp/j', duree:'Jusqu\'à 28 SA'},
      {medicament:'Fer 80mg', posologie:'1 cp/j en dehors des repas', duree:'Jusqu\'à l\'accouchement'},
      {medicament:'Calcium 1g', posologie:'1 cp/j', duree:'Jusqu\'à l\'accouchement'}
    ]), 1, '2026-03-18 10:40:00');
    console.log('Prescriptions rx1-rx7 créées');
  }
} catch(e) { console.warn('Seed prescriptions v2 ignoré:', e.message); }

// Add new discussions
try {
  if (db.prepare("SELECT COUNT(*) as n FROM discussions WHERE id='d2'").get().n === 0) {
    db.prepare(`INSERT OR IGNORE INTO discussions (id,patientId,titre,createdBy,createdAt) VALUES (?,?,?,?,?)`)
      .run('d2','p6','Prise en charge FA paroxystique — ASSOUMOU M.-C.','u1','2026-02-11 08:00:00');
    db.prepare(`INSERT OR IGNORE INTO discussion_participants (discussionId,userId,joinedAt) VALUES (?,?,?)`).run('d2','u1','2026-02-11 08:00:00');
    db.prepare(`INSERT OR IGNORE INTO discussion_participants (discussionId,userId,joinedAt) VALUES (?,?,?)`).run('d2','u2','2026-02-11 08:10:00');
    const im = db.prepare(`INSERT OR IGNORE INTO messages (id,discussionId,userId,contenu,createdAt) VALUES (?,?,?,?,?)`);
    im.run('m5','d2','u1','Patrick, je viens de voir Mme ASSOUMOU Marie-Claire, 52 ans. Holter 24h positif : 3 épisodes FA paroxystique. CHA₂DS₂-VASc à 4 (HTA + âge + sexe féminin + valvulopathie à préciser). J\'ai déjà introduit l\'Apixaban. Est-ce que tu peux la prendre en rythmologie pour discuter contrôle du rythme vs fréquence ?','2026-02-11 08:02:00');
    im.run('m6','d2','u2','Bien reçu. Score de risque élevé, anticoagulation justifiée. Pour la stratégie rythmologique, j\'aurais besoin d\'une ETT d\'abord pour évaluer la fonction systolique avant d\'envisager le Flécaïnide (contre-indiqué si FEVG altérée). Tu peux la programmer ?','2026-02-11 09:30:00');
    im.run('m7','d2','u1','ETT demandée pour la semaine prochaine. Je lui ai expliqué l\'importance de l\'Apixaban. Elle est compliante et bien informée. Je te transfère le dossier complet avec le Holter.','2026-02-11 10:00:00');
    im.run('m8','d2','u2','Parfait. Je la verrai après l\'ETT. Si FEVG > 50% et QRS fins, on démarre le Flécaïnide. Sinon, Amiodarone en discussion. À bientôt.','2026-02-11 10:45:00');
    console.log('Discussion d2 (ASSOUMOU FA) créée');
  }
} catch(e) { console.warn('Seed discussion d2 ignoré:', e.message); }

try {
  if (db.prepare("SELECT COUNT(*) as n FROM discussions WHERE id='d3'").get().n === 0) {
    db.prepare(`INSERT OR IGNORE INTO discussions (id,patientId,titre,createdBy,createdAt) VALUES (?,?,?,?,?)`)
      .run('d3','p9','Préparation dialyse — LEYAMA Paul, MRC 3b','u1','2026-03-11 07:30:00');
    db.prepare(`INSERT OR IGNORE INTO discussion_participants (discussionId,userId,joinedAt) VALUES (?,?,?)`).run('d3','u1','2026-03-11 07:30:00');
    db.prepare(`INSERT OR IGNORE INTO discussion_participants (discussionId,userId,joinedAt) VALUES (?,?,?)`).run('d3','u2','2026-03-11 07:40:00');
    const im = db.prepare(`INSERT OR IGNORE INTO messages (id,discussionId,userId,contenu,createdAt) VALUES (?,?,?,?,?)`);
    im.run('m9','d3','u1','Bonjour Patrick, je te contacte pour M. LEYAMA Paul, 67 ans, MRC stade 3b (DFG 38). Sa FAV est fonctionnelle depuis 2024. HTA résistante malgré 3 lignes. Surcharge hydrosodée ce matin, œdèmes chevilles +++. Je pense qu\'il faut anticiper la dialyse. Peux-tu le voir en consultation néphro-cardiologique ?','2026-03-11 07:35:00');
    im.run('m10','d3','u2','Merci pour le transfert. DFG en déclin progressif, HTA résistante sur néphropathie diabétique : tableau classique. La FAV est bien anticipée. Je le vois mardi 17 mars pour bilan pré-dialyse complet + écho rénale. Il faudra aussi planifier la transition Furosémide → ultrafiltration.','2026-03-11 08:20:00');
    im.run('m11','d3','u1','Super. J\'augmente le Furosémide à 80mg en attendant ton bilan. Restriction hydrosodée renforcée. Il est informé de la possibilité de dialyse, bien préparé psychologiquement depuis 1 an.','2026-03-11 08:45:00');
    im.run('m12','d3','u2','Bonne décision. Si la surcharge ne répond pas sous 48h, envisage hospitalisation pour épuration. Tiens-moi informé.','2026-03-11 09:00:00');
    console.log('Discussion d3 (LEYAMA MRC) créée');
  }
} catch(e) { console.warn('Seed discussion d3 ignoré:', e.message); }

// Ensure all discussion messages exist (separate guard so they survive re-seeds)
try {
  const im = db.prepare(`INSERT OR IGNORE INTO messages (id,discussionId,userId,contenu,createdAt) VALUES (?,?,?,?,?)`);
  // d1 messages
  im.run('m1','d1','u1','Bonjour Patrick, je te contacte au sujet de M. NGUEMA Bertrand, 60 ans, diabétique de type 2 avec dyslipidémie. Lors de sa consultation de suivi hier, j\'ai noté une TA à 134/86 et des glycémies entre 1,40 et 1,80 à jeun. Je pense qu\'un avis cardiologique serait utile avant d\'intensifier son traitement. Peux-tu le recevoir ?','2026-03-21 08:02:00');
  im.run('m2','d1','u2','Bonjour Fatoumata, merci pour le transfert. Profil à risque CV élevé en effet, diabète + dyslipidémie + légère HTA. Je peux le voir semaine du 7 avril. Il faudrait qu\'il ait fait son ECG et son bilan lipidique complet avant. Tu peux les prescrire de ton côté ?','2026-03-21 08:45:00');
  im.run('m3','d1','u1','Parfait, je lui prescris l\'ECG + lipides complets + créatininémie dès aujourd\'hui. Je lui fixe le RDV au 9 avril chez toi. Je t\'envoie le compte-rendu de consultation dès qu\'il est validé.','2026-03-21 09:10:00');
  im.run('m4','d1','u2','Super. N\'hésite pas à me contacter si la situation évolue défavorablement. À bientôt.','2026-03-21 09:15:00');
  // d2 messages
  im.run('m5','d2','u1','Patrick, je viens de voir Mme ASSOUMOU Marie-Claire, 52 ans. Holter 24h positif : 3 épisodes FA paroxystique. CHA₂DS₂-VASc à 4. J\'ai déjà introduit l\'Apixaban. Est-ce que tu peux la prendre en rythmologie pour discuter contrôle du rythme vs fréquence ?','2026-02-11 08:02:00');
  im.run('m6','d2','u2','Bien reçu. Score de risque élevé, anticoagulation justifiée. Pour la stratégie rythmologique, j\'aurais besoin d\'une ETT d\'abord pour évaluer la fonction systolique avant d\'envisager le Flécaïnide (contre-indiqué si FEVG altérée). Tu peux la programmer ?','2026-02-11 09:30:00');
  im.run('m7','d2','u1','ETT demandée pour la semaine prochaine. Je lui ai expliqué l\'importance de l\'Apixaban. Elle est compliante et bien informée. Je te transfère le dossier complet avec le Holter.','2026-02-11 10:00:00');
  im.run('m8','d2','u2','Parfait. Je la verrai après l\'ETT. Si FEVG > 50% et QRS fins, on démarre le Flécaïnide. Sinon, Amiodarone en discussion. À bientôt.','2026-02-11 10:45:00');
  // d3 messages
  im.run('m9','d3','u1','Bonjour Patrick, je te contacte pour M. LEYAMA Paul, 67 ans, MRC stade 3b (DFG 38). Sa FAV est fonctionnelle depuis 2024. HTA résistante malgré 3 lignes. Surcharge hydrosodée ce matin, œdèmes chevilles +++. Je pense qu\'il faut anticiper la dialyse. Peux-tu le voir en consultation néphro-cardiologique ?','2026-03-11 07:35:00');
  im.run('m10','d3','u2','Merci pour le transfert. DFG en déclin progressif, HTA résistante sur néphropathie diabétique : tableau classique. La FAV est bien anticipée. Je le vois mardi 17 mars pour bilan pré-dialyse complet + écho rénale.','2026-03-11 08:20:00');
  im.run('m11','d3','u1','Super. J\'augmente le Furosémide à 80mg en attendant ton bilan. Restriction hydrosodée renforcée. Il est informé de la possibilité de dialyse, bien préparé psychologiquement depuis 1 an.','2026-03-11 08:45:00');
  im.run('m12','d3','u2','Bonne décision. Si la surcharge ne répond pas sous 48h, envisage hospitalisation pour épuration. Tiens-moi informé.','2026-03-11 09:00:00');
  console.log('Messages m1-m12 (d1, d2, d3) créés ou ignorés');
} catch(e) { console.warn('Seed messages ignoré:', e.message); }

// Ensure discussion_participants for d2/d3
try {
  const ip = db.prepare(`INSERT OR IGNORE INTO discussion_participants (discussionId,userId,joinedAt) VALUES (?,?,?)`);
  ip.run('d1','u1','2026-03-21 08:00:00'); ip.run('d1','u2','2026-03-21 08:05:00');
  ip.run('d2','u1','2026-02-11 08:00:00'); ip.run('d2','u2','2026-02-11 08:10:00');
  ip.run('d3','u1','2026-03-11 07:30:00'); ip.run('d3','u2','2026-03-11 07:40:00');
} catch(e) { console.warn('Seed participants ignoré:', e.message); }

// Ensure original honoraires h1-h3
try {
  const ih = db.prepare(`INSERT OR IGNORE INTO honoraires (id,consultationId,userId,montant,statut,caisse,typeActe,dateFacturation,datePaiement) VALUES (?,?,?,?,?,?,?,?,?)`);
  ih.run('h1','c1','u1',25000,'paye','CNAMGS','Consultation spécialisée','2026-03-15','2026-03-17');
  ih.run('h2','c3','u1',25000,'en_attente','CNSS','Consultation spécialisée','2026-03-20',null);
  ih.run('h3','c5','u1',20000,'paye','Privée (Saham)','Consultation simple','2026-03-10','2026-03-10');
} catch(e) { console.warn('Seed honoraires h1-h3 ignoré:', e.message); }

// Ensure original appointments a1-a6
try {
  const ia = db.prepare(`INSERT OR IGNORE INTO appointments (id,patientId,userId,date,heure,motif,statut) VALUES (?,?,?,?,?,?,?)`);
  ia.run('a1','p1','u1','2026-03-31','09:00','Résultats bilan thyroïdien','planifie');
  ia.run('a2','p2','u1','2026-04-02','11:00','Suivi diabète + résultats HbA1c','confirme');
  ia.run('a3','p3','u1','2026-04-01','14:00','Contrôle asthme post-crise','confirme');
  ia.run('a4','p4','u1','2026-04-05','10:00','Suivi lombalgies — bilan imagerie','planifie');
  ia.run('a5','p5','u1','2026-04-07','09:00','Résultats bilan de santé','planifie');
  ia.run('a6','p1','u1','2026-03-30','10:30','Consultation urgente — tension élevée','confirme');
} catch(e) { console.warn('Seed appointments a1-a6 ignoré:', e.message); }

// Add additional appointments
try {
  const ins = db.prepare(`INSERT OR IGNORE INTO appointments (id,patientId,userId,date,heure,motif,statut) VALUES (?,?,?,?,?,?,?)`);
  ins.run('a7','p6','u2','2026-04-08','14:00','Holter de contrôle — suivi Flécaïnide','planifie');
  ins.run('a8','p7','u1','2026-04-15','11:00','Suivi VIH semestriel — résultats bilan','planifie');
  ins.run('a9','p8','u1','2026-04-03','10:00','HGPO 75g — dépistage diabète gestationnel','confirme');
  ins.run('a10','p9','u2','2026-03-17','09:00','Bilan pré-dialyse — consultation néphro-cardio','confirme');
  ins.run('a11','p10','u1','2026-03-19','16:00','Réévaluation burn-out — 6 semaines','confirme');
  ins.run('a12','p6','u1','2026-04-01','09:30','Contrôle tensionnel et bilan biologique','planifie');
  console.log('Rendez-vous a7-a12 créés');
} catch(e) { console.warn('Seed appointments v2 ignoré:', e.message); }

// Add additional honoraires
try {
  const ins = db.prepare(`INSERT OR IGNORE INTO honoraires
    (id,consultationId,userId,montant,statut,caisse,typeActe,dateFacturation,datePaiement)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  ins.run('h4','c6a','u1',35000,'paye','CNAMGS','Consultation spécialisée','2026-02-10','2026-02-14');
  ins.run('h5','c6b','u2',40000,'paye','CNAMGS','Consultation cardiologique','2026-03-05','2026-03-08');
  ins.run('h6','c7a','u1',25000,'en_attente','CNSS','Consultation spécialisée','2026-01-20',null);
  ins.run('h7','c8a','u1',25000,'paye','Privée (SUNU)','Consultation prénatale','2026-03-18','2026-03-18');
  ins.run('h8','c9a','u1',35000,'en_attente','CNAMGS','Consultation spécialisée','2026-03-10',null);
  ins.run('h9','c10a','u1',25000,'paye','CNSS','Consultation simple','2026-01-08','2026-01-10');
  ins.run('h10','c10b','u1',25000,'paye','CNSS','Consultation simple','2026-02-05','2026-02-07');
  ins.run('h11','c1b','u1',25000,'paye','CNAMGS','Consultation spécialisée','2025-11-12','2025-11-15');
  ins.run('h12','c2b','u1',25000,'paye','CNSS','Consultation spécialisée','2025-12-05','2025-12-09');
  ins.run('h13','c3b','u1',20000,'paye','Privée (Saham)','Consultation simple','2025-10-28','2025-10-28');
  ins.run('h14','c4b','u1',25000,'en_attente','CNAMGS','Consultation spécialisée','2025-09-15',null);
  ins.run('h15','c2c','u1',30000,'paye','CNSS','Consultation longue (première visite)','2024-06-18','2024-06-20');
  console.log('Honoraires h4-h15 créés');
} catch(e) { console.warn('Seed honoraires v2 ignoré:', e.message); }

export default db;
