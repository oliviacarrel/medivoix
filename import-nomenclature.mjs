/**
 * import-nomenclature.mjs
 * Importe la tarification CDL complète depuis les deux fichiers Excel
 * Sources : assets/Tarification CDL.xlsx + assets/Grille_tarifaire(1).xlsx
 * Usage : node import-nomenclature.mjs
 * Usage programmatique : import { runNomenclatureImport } from './import-nomenclature.mjs'
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import db from './db.js';

const require  = createRequire(import.meta.url);
const XLSX     = require('xlsx');
const __dirname = dirname(fileURLToPath(import.meta.url));

const CDL_PATH    = resolve(__dirname, 'assets/Tarification CDL.xlsx');
const GRILLE_PATH = resolve(__dirname, 'assets/Grille_tarifaire(1).xlsx');

// ── Génère un code court unique à partir du libellé + catégorie ───────────────
const codeCounters = {};
function makeCode(prefix, libelle) {
  // Essaie d'abord de mapper les libellés connus sur les codes CEMAC existants
  const KNOWN = {
    'numeration formule':   'NFS',   'nfs':                   'NFS',
    'hemogramme':           'NFS',   'glycemie':              'GLY',
    'glucose sanguin':      'GLY',   'electrocardiogramme':   'ECG',
    'ecg':                  'ECG',   'creatinine':            'CREA',
    'uree':                 'UREE',  'crp':                   'CRP',
    'proteine c reactive':  'CRP',   'bilan hepatique':       'BHC',
    'transaminase':         'BHC',   'cholesterol':           'LIPID',
    'bilan lipidique':      'LIPID', 'tsh':                   'TSH',
    'paludisme':            'GE',    'recherche de paludisme':'GE',
    'vih':                  'VIH',   'ag hbs':                'HBS',
    'hepatite b':           'HBS',   'ecbu':                  'ECBU',
    'consultation generale':'C',     'consultation specialise':'CS',
    'echographie abdominale':'ECH1', 'echographie obstetricale':'ECH2',
    'echographie cardiaque':'ECH3',  'echo doppler':          'ECH4',
    'radiographie pulmonaire':'RX1', 'radiographie osseuse':  'RX2',
    'scanner cerebral':     'TDM1',  'scanner thoracique':    'TDM2',
    'scanner abdomino':     'TDM3',  'suture simple':         'PC1',
    'suture complexe':      'PC2',   'incision':              'PC3',
    'pansement simple':     'S1',    'pansement complexe':    'S2',
    'vaccination':          'VAC',   'spirometrie':           'SPI',
    'accouchement normal':  'ACC',   'cesarienne':            'ACC-C',
    'consultation prenatale':'CPN',  'prise de sang':         'PR',
    'prelevement':          'PR',    'injection intramusculaire':'I1',
    'injection intraveineuse':'I2',  'perfusion':             'I3',
    'hba1c':                'HBA1C', 'ionogramme':            'IONO',
    'bhcg':                 'BHCG',  'beta hcg':              'BHCG',
    'fond d oeil':          'FO',    'endoscopie':            'ENDO',
    'eeg':                  'EEG',   'encephalogramme':       'EEG',
  };
  const norm = libelle.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  for (const [key, code] of Object.entries(KNOWN)) {
    if (norm.includes(key)) return code;
  }
  // Génère un code unique préfixé
  if (!codeCounters[prefix]) codeCounters[prefix] = 1;
  return `${prefix}-${String(codeCounters[prefix]++).padStart(3,'0')}`;
}

// ── Normalise un libellé pour déduplication ───────────────────────────────────
function normLib(s) {
  return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
}

// ── Valeur numérique sûre ─────────────────────────────────────────────────────
function num(v) {
  const n = parseFloat(v);
  return isNaN(n) || n <= 0 ? null : Math.round(n);
}

// ── Collecte toutes les lignes depuis les deux fichiers ───────────────────────
export async function runNomenclatureImport() {
  const items = new Map(); // normLib → item

  const addItem = (libelle, categorie, montant_cdl, montant_cnamgs, montant_ascoma, nomenclature_cnamgs) => {
    const key = normLib(libelle);
    if (!key || !montant_cdl) return;
    if (!items.has(key)) {
      items.set(key, { libelle: String(libelle).trim(), categorie, montant_cdl, montant_cnamgs, montant_ascoma, nomenclature_cnamgs });
    } else {
      // Enrichir les données manquantes
      const ex = items.get(key);
      if (!ex.montant_cnamgs && montant_cnamgs) ex.montant_cnamgs = montant_cnamgs;
      if (!ex.montant_ascoma && montant_ascoma) ex.montant_ascoma = montant_ascoma;
      if (!ex.nomenclature_cnamgs && nomenclature_cnamgs) ex.nomenclature_cnamgs = nomenclature_cnamgs;
    }
  };

  // ── Source 1 : Grille_tarifaire — Nomenclature Complète ──────────────────
  const wb2   = XLSX.readFile(GRILLE_PATH);
  const grille = XLSX.utils.sheet_to_json(wb2.Sheets['Nomenclature Complète'], { header: 1 }).slice(1);
  for (const r of grille) {
    const [spec, libelle, nomCnam, paillasse, , , , , , tarifCDL, tarifCNAMGS, ascoma] = r;
    if (!libelle || !tarifCDL) continue;
    const cat = paillasse || spec || 'Divers';
    addItem(libelle, cat, num(tarifCDL), num(tarifCNAMGS), num(ascoma), nomCnam && nomCnam !== '-' ? String(nomCnam).trim() : null);
  }

  // ── Source 2 : Tarification CDL ──────────────────────────────────────────
  const wb1 = XLSX.readFile(CDL_PATH);

  // Imagerie : cols [Désignation, NomCNAMGS, Paillasse, TarifCDL, NouvelleTargification]
  const imgs = XLSX.utils.sheet_to_json(wb1.Sheets['Imagerie'], { header: 1 }).slice(1);
  for (const r of imgs) {
    const [lib, nomCnam, paillasse, tarifCDL, nouvTarif] = r;
    if (!lib || !tarifCDL) continue;
    addItem(lib, paillasse || 'Imagerie', num(nouvTarif || tarifCDL), null, null, nomCnam && nomCnam !== '-' ? String(nomCnam).trim() : null);
  }

  // Laboratoire : cols [Désignation, NomCNAMGS, TarifCDL, NouvelleTargification]
  const labs = XLSX.utils.sheet_to_json(wb1.Sheets['Laboratoire'], { header: 1 }).slice(1);
  for (const r of labs) {
    const [lib, nomCnam, tarifCDL, nouvTarif] = r;
    if (!lib || !tarifCDL) continue;
    addItem(lib, 'Laboratoire', num(nouvTarif || tarifCDL), null, null, nomCnam && nomCnam !== '-' ? String(nomCnam).trim() : null);
  }

  // Consultations : cols [Spécialité, Désignation, NomCNAMGS, TarifCDL]
  const consults = XLSX.utils.sheet_to_json(wb1.Sheets['Consultations'], { header: 1 }).slice(1);
  for (const r of consults) {
    const [spec, lib, nomCnam, tarifCDL] = r;
    if (!lib || !tarifCDL) continue;
    addItem(lib, spec || 'Consultation', num(tarifCDL), null, null, nomCnam && nomCnam !== '-' ? String(nomCnam).trim() : null);
  }

  // Divers : cols [Désignation, TarifCDL]
  const divers = XLSX.utils.sheet_to_json(wb1.Sheets['Divers'], { header: 1 }).slice(1);
  for (const r of divers) {
    const [lib, tarifCDL] = r;
    if (!lib || !tarifCDL) continue;
    addItem(lib, 'Divers', num(tarifCDL), null, null, null);
  }

  // Infirmerie : cols [Désignation, NomCNAMGS, TarifCDL]
  const inf = XLSX.utils.sheet_to_json(wb1.Sheets['Infirmerie'], { header: 1 }).slice(1);
  for (const r of inf) {
    const [lib, nomCnam, tarifCDL] = r;
    if (!lib || !tarifCDL) continue;
    addItem(lib, 'Infirmerie', num(tarifCDL), null, null, nomCnam && nomCnam !== '-' ? String(nomCnam).trim() : null);
  }

  // Hospitalisation : cols [Désignation, TarifCDL]
  const hosp = XLSX.utils.sheet_to_json(wb1.Sheets['Hospitalisation'], { header: 1 }).slice(1);
  for (const r of hosp) {
    const [lib, tarifCDL] = r;
    if (!lib || !tarifCDL) continue;
    addItem(lib, 'Hospitalisation', num(tarifCDL), null, null, null);
  }

  // Urgences : cols [Désignation, TarifCDL]
  const urg = XLSX.utils.sheet_to_json(wb1.Sheets['Urgences'], { header: 1 }).slice(1);
  for (const r of urg) {
    const [lib, tarifCDL] = r;
    if (!lib || !tarifCDL) continue;
    addItem(lib, 'Urgences', num(tarifCDL), null, null, null);
  }

  // ── Catégorie → préfixe de code ───────────────────────────────────────────
  const PREFIX_MAP = {
    'Imagerie':             'IMG',
    'Laboratoire':          'LAB',
    'Consultation':         'CONS',
    'Cardiologie':          'CARD',
    'Chirurgie générale':   'CHIR',
    'Dentisterie':          'DENT',
    'Gastro-Enterologie':   'GAST',
    'Gastro-enterologie':   'GAST',
    'Gynécologie & Obstétrique': 'GYNO',
    'Gynécologie':          'GYNO',
    'Ophtalmologie':        'OPHT',
    'Opthalmologie':        'OPHT',
    'ORL':                  'ORL',
    'Orthophonie':          'ORPH',
    'Pneumologie':          'PNEU',
    'Rhumatologie':         'RHUM',
    'Urologie':             'UROL',
    'Infirmerie':           'INF',
    'Hospitalisation':      'HOSP',
    'Urgences':             'URG',
    'Divers':               'DIV',
    'Certificat Médical':   'CERT',
    'Certificat':           'CERT',
    'Pcr':                  'PCR',
    'ANATHOMO-PATHOLOGIE':  'ANAT',
    'BACTERIOLOGIE':        'BACT',
    'BIOCHIMIE':            'BIO',
    'HEMATOLOGIE':          'HEM',
    'IMMUNOLOGIE':          'IMM',
    'PARASITOLOGIE':        'PARA',
    'SEROLOGIE':            'SERO',
    'HORMONOLOGIE':         'HORM',
    'Échographie':          'ECH',
    'Radiographie':         'RX',
    'Scanner':              'SCAN',
  };

  // ── Insertion en base ─────────────────────────────────────────────────────
  const stmt = db.prepare(`
    INSERT INTO nomenclature (code, libelle, categorie, montant_base, tarif_cnamgs, tarif_ascoma, nomenclature_cnamgs)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      libelle             = excluded.libelle,
      categorie           = excluded.categorie,
      montant_base        = excluded.montant_base,
      tarif_cnamgs        = excluded.tarif_cnamgs,
      tarif_ascoma        = excluded.tarif_ascoma,
      nomenclature_cnamgs = excluded.nomenclature_cnamgs
  `);

  const doImport = db.transaction((entries) => {
    let inserted = 0, updated = 0;
    for (const [, item] of entries) {
      const prefix = PREFIX_MAP[item.categorie] || 'ACT';
      const code   = makeCode(prefix, item.libelle);
      const existing = db.prepare('SELECT code FROM nomenclature WHERE code=?').get(code);
      stmt.run(code, item.libelle, item.categorie, item.montant_cdl, item.montant_cnamgs, item.montant_ascoma, item.nomenclature_cnamgs);
      if (existing) updated++; else inserted++;
    }
    return { inserted, updated };
  });

  console.log(`Nomenclature CDL : ${items.size} actes uniques collectés…`);
  const { inserted, updated } = doImport(items);
  const total = db.prepare('SELECT COUNT(*) as n FROM nomenclature').get().n;
  console.log(`✓ Nomenclature terminée — ${inserted} insérés, ${updated} mis à jour. Total en base : ${total}`);
  return { inserted, updated, total };
}

// ── Exécution autonome ────────────────────────────────────────────────────────
const isMain = process.argv[1]?.endsWith('import-nomenclature.mjs');
if (isMain) {
  runNomenclatureImport().catch(e => { console.error(e); process.exit(1); });
}
