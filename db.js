import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(resolve(__dirname, 'data.db'));

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

// Seed demo doctor
if (db.prepare('SELECT COUNT(*) as n FROM users').get().n === 0) {
  const hash = bcrypt.hashSync('demo1234', 10);
  db.prepare(`INSERT INTO users (id,email,password,nom,prenom,rpps,specialite,adresse)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run('u1','dr.maiga@medivoix.fr',hash,'MAIGA','Fatoumata','10000000001','Gynécologie','Centre Diagnostic de Libreville');
  console.log('Médecin : dr.maiga@medivoix.fr / demo1234');
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

export default db;
