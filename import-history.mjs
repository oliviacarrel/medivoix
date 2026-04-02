/**
 * import-history.mjs
 * Importe l'historique complet des consultations CDL depuis diagnostics_An_2026_clean(1).xlsx
 * 13 441 consultations (Jan–Mars 2026) avec montants, conventions, diagnostics
 * Usage : node import-history.mjs
 * Usage programmatique : import { runHistoryImport } from './import-history.mjs'
 */
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import db from './db.js';

const require  = createRequire(import.meta.url);
const XLSX     = require('xlsx');
const __dirname = dirname(fileURLToPath(import.meta.url));

const XL_PATH = resolve(__dirname, 'assets/diagnostics_An_2026_clean(1).xlsx');

// ── Excel serial → YYYY-MM-DD ─────────────────────────────────────────────────
function excelDateToISO(serial) {
  if (!serial || typeof serial !== 'number') return null;
  const d = new Date((serial - 25569) * 86400 * 1000);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ── Extrait l'assurance principale depuis la convention ───────────────────────
function parseAssurance(raw) {
  if (!raw || raw === 'AUCUNE' || raw === '0') return 'Aucune';
  const s = String(raw).trim().toUpperCase();
  if (s.startsWith('CNAMGS'))  return 'CNAMGS';
  if (s.startsWith('VMA'))     return 'VMA';
  if (s.startsWith('VME'))     return 'VME';
  if (s.includes('ASCOMA'))    return 'ASCOMA';
  if (s.includes('GECAR'))     return 'GECAR/OLEA';
  if (s.includes('OLEA'))      return 'OLEA';
  if (s.includes('GRAS SAVOYE')) return 'GRAS SAVOYE';
  for (const ins of ['AXA','GCA','LARUCHE','HENNER','ALLIANCE','MSH','NSIA','OGAR','CIGNA',
       'SAHAM','SUNU','BEAC','AIRTEL','TOTAL','HUMANIS','GLOBAL','CNSS','SMUR']) {
    if (s.includes(ins)) return ins;
  }
  if (s.includes('FORESTIER')) return 'Forestiers';
  // Derive from first word
  return String(raw).trim().split(/\s+/)[0];
}

// ── Import exportable ──────────────────────────────────────────────────────────
export async function runHistoryImport() {
  const wb   = XLSX.readFile(XL_PATH);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }).slice(1).filter(r => r[1]);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO consultations_history
      (id, code_consultation, patient_nom, date_naissance, date_consultation,
       medecin, montant, montant_paye, reste_a_payer, convention, assurance,
       diagnostic, cree_par, categorie, num_ss)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const importMany = db.transaction((rows) => {
    let inserted = 0;
    for (const r of rows) {
      // Cols: Code, Patient, Né(e)le, Date, Médecin, Montant, Paiement, Reste, Convention, Diagnostic, CréePar, Catégorie, CréeLe, N°SS
      const [code, patient, dobSerial, dateSerial, medecin,
             montant, paye, reste, convention, diagnostic,
             creePar, categorie, , numSS] = r;

      const info = stmt.run(
        randomUUID(),
        code ? String(code).trim() : null,
        String(patient || '').trim() || null,
        excelDateToISO(dobSerial),
        excelDateToISO(dateSerial),
        medecin ? String(medecin).trim() : null,
        parseFloat(montant) || 0,
        parseFloat(paye)    || 0,
        parseFloat(reste)   || 0,
        convention ? String(convention).trim() : null,
        parseAssurance(convention),
        diagnostic ? String(diagnostic).trim() : null,
        creePar    ? String(creePar).trim()    : null,
        categorie  ? String(categorie).trim()  : null,
        numSS      ? String(numSS).trim()      : null
      );
      if (info.changes > 0) inserted++;
    }
    return inserted;
  });

  console.log(`Lecture de ${rows.length} consultations historiques CDL…`);
  const inserted = importMany(rows);
  const total = db.prepare('SELECT COUNT(*) as n FROM consultations_history').get().n;
  console.log(`✓ Historique CDL — ${inserted} insérées. Total en base : ${total}`);
  return { inserted, total };
}

// ── Exécution autonome ─────────────────────────────────────────────────────────
const isMain = process.argv[1]?.endsWith('import-history.mjs');
if (isMain) {
  runHistoryImport().catch(e => { console.error(e); process.exit(1); });
}
