/**
 * import-patients.mjs
 * Importe la liste patients CDL depuis assets/Liste Patients CDL.xlsx
 * Usage autonome : node import-patients.mjs
 * Usage programmatique : import { runImport } from './import-patients.mjs'
 */
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import db from './db.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const __dirname = dirname(fileURLToPath(import.meta.url));
const XL_PATH = resolve(__dirname, 'assets/Liste Patients CDL.xlsx');

// ── Excel serial date → YYYY-MM-DD ────────────────────────────────────────────
function excelDateToISO(serial) {
  if (!serial || typeof serial !== 'number') return null;
  const ms = (serial - 25569) * 86400 * 1000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// ── Convention → { assurance, convention } ────────────────────────────────────
function parseConvention(raw) {
  if (!raw || raw === 'AUCUNE' || raw === '0') return { assurance: 'Aucune', convention: '-' };
  const s = String(raw).trim();
  if (!s) return { assurance: 'Aucune', convention: '-' };

  if (s.startsWith('VMA ')) return { assurance: 'VMA', convention: s.slice(4) };
  if (s.startsWith('VME ')) return { assurance: 'VME', convention: s.slice(4) };

  if (s.startsWith('CNAMGS')) {
    const rest = s.slice(6).trim();
    if (!rest) return { assurance: 'CNAMGS', convention: '-' };
    if (rest.startsWith('AP '))             return { assurance: 'CNAMGS', convention: 'Agent Public ' + rest.slice(3) };
    if (rest.startsWith('SECTEUR PRIVES ')) return { assurance: 'CNAMGS', convention: 'Secteur Privé ' + rest.slice(15) };
    if (rest.startsWith('GEF '))            return { assurance: 'CNAMGS', convention: 'GEF ' + rest.slice(4) };
    if (rest.startsWith('GEF'))             return { assurance: 'CNAMGS', convention: rest };
    if (rest.startsWith('ALD '))            return { assurance: 'CNAMGS', convention: 'ALD ' + rest.slice(4) };
    if (rest.startsWith('FED '))            return { assurance: 'CNAMGS', convention: 'FED ' + rest.slice(4) };
    return { assurance: 'CNAMGS', convention: rest };
  }

  if (/\/\s*OLEA\s*$/.test(s)) {
    return { assurance: 'OLEA', convention: s.replace(/\s*\/\s*OLEA\s*$/, '').trim() };
  }
  const gsMatch = s.match(/^(.+?)\/GRAS SAVOYE (.+)$/);
  if (gsMatch) return { assurance: 'GRAS SAVOYE', convention: gsMatch[1].trim() + ' ' + gsMatch[2].trim() };

  const knownInsurers = [
    'GLOBAL ASSURANCE RE', 'Humaniis Santé', 'HUMANIS SOCIAL', 'GRAS SAVOYE', 'GECAR/OLEA',
    'Pro Assurance', 'NSIA ASSURANCES GABON', 'ASCOMA', 'SAHAM', 'SUNU', 'NSIA',
    'OGAR', 'CIGNA', 'HENNER', 'ALLIANCE', 'LARUCHE', 'MSH International', 'MSH',
    'AXA', 'GCA', 'SMUR-CNSS', 'CNSS',
  ];
  for (const ins of knownInsurers) {
    if (s === ins)               return { assurance: ins, convention: '-' };
    if (s.startsWith(ins + ' ')) return { assurance: ins, convention: s.slice(ins.length + 1).trim() };
  }

  return { assurance: s, convention: '-' };
}

// ── Fonction d'import exportable ─────────────────────────────────────────────
export async function runImport() {
  const wb = XLSX.readFile(XL_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const dataRows = rows.slice(1).filter(r => r[2]);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO patients
      (id, code_patient, nom, prenom, dateNaissance, sexe, telephone, email, adresse,
       situation, numAssurance, typeAssurance, assurance, convention)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const importMany = db.transaction((rows) => {
    let inserted = 0;
    for (const r of rows) {
      const [genre, code, nom, prenom, dateRaw, adresse, tel, email, situation, numSS, conventionRaw] = r;
      const { assurance, convention } = parseConvention(conventionRaw);
      const info = stmt.run(
        randomUUID(),
        code || null,
        String(nom || '').trim(),
        String(prenom || '').trim(),
        excelDateToISO(dateRaw),
        genre === 'Féminin' ? 'F' : 'M',
        tel ? String(tel) : null,
        email || null,
        adresse || null,
        situation && situation !== '-' ? String(situation) : null,
        numSS ? String(numSS) : null,
        conventionRaw ? String(conventionRaw).trim() : null,
        assurance,
        convention
      );
      if (info.changes > 0) inserted++;
    }
    return inserted;
  });

  console.log(`Lecture de ${dataRows.length} patients CDL…`);
  const inserted = importMany(dataRows);
  console.log(`✓ Import CDL terminé — ${inserted} nouveaux patients insérés.`);
  return inserted;
}

// ── Exécution autonome (node import-patients.mjs) ─────────────────────────────
const isMain = process.argv[1]?.endsWith('import-patients.mjs');
if (isMain) {
  runImport().catch(e => { console.error(e); process.exit(1); });
}
