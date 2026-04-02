/**
 * backup.mjs — Sauvegarde automatique SQLite → S3
 *
 * Variables d'environnement requises :
 *   AWS_ACCESS_KEY_ID       — Clé d'accès AWS
 *   AWS_SECRET_ACCESS_KEY   — Clé secrète AWS
 *   AWS_S3_BUCKET           — Nom du bucket (ex: medivox-backup)
 *   AWS_S3_REGION           — Région (ex: eu-west-3)
 *
 * Si les variables ne sont pas définies, les fonctions logguent un avertissement
 * et retournent silencieusement — le serveur continue de fonctionner.
 */

import { createGzip, createGunzip } from 'zlib';
import { createReadStream, createWriteStream, existsSync, statSync } from 'fs';
import { pipeline } from 'stream/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = resolve(__dirname, 'data.db');

// ── S3 client (lazy — seulement si les vars sont présentes) ──────────────────
function getS3() {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET, AWS_S3_REGION } = process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_S3_BUCKET) return null;
  return {
    client: new S3Client({
      region: AWS_S3_REGION || 'eu-west-3',
      credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
    }),
    bucket: AWS_S3_BUCKET,
  };
}

// ── Backup : compresse data.db et l'envoie sur S3 ────────────────────────────
export async function backupToS3(db) {
  const s3 = getS3();
  if (!s3) {
    console.warn('ℹ️  Backup S3 ignoré — AWS_ACCESS_KEY_ID / AWS_S3_BUCKET non configurés');
    return { skipped: true };
  }

  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const key = `backups/medivox-${ts}.db.gz`;

  // Utilise l'API backup de better-sqlite3 pour un snapshot cohérent (pas de lecture à chaud)
  const tmpPath = DB_PATH + '.backup.tmp';
  await new Promise((resolve, reject) => db.backup(tmpPath).then(resolve).catch(reject));

  // Compression gzip + upload
  const gzipStream = createGzip({ level: 9 });
  const readStream = createReadStream(tmpPath);

  const chunks = [];
  gzipStream.on('data', c => chunks.push(c));
  await pipeline(readStream, gzipStream);
  // Wait for gzip to flush
  await new Promise(r => setTimeout(r, 100));
  const body = Buffer.concat(chunks);

  await s3.client.send(new PutObjectCommand({
    Bucket: s3.bucket,
    Key: key,
    Body: body,
    ContentType: 'application/gzip',
    Metadata: {
      'db-size': String(statSync(tmpPath).size),
      'backup-date': now.toISOString(),
    },
  }));

  // Nettoyer le tmp
  try { (await import('fs')).unlinkSync(tmpPath); } catch {}

  console.log(`✅ Backup S3 — ${key} (${(body.length / 1024).toFixed(0)} KB compressé)`);
  return { key, size: body.length };
}

// ── Restore : télécharge le backup le plus récent depuis S3 ──────────────────
export async function restoreFromS3() {
  const s3 = getS3();
  if (!s3) return { skipped: true };

  // Lister les backups pour trouver le plus récent
  const list = await s3.client.send(new ListObjectsV2Command({
    Bucket: s3.bucket,
    Prefix: 'backups/medivox-',
  }));

  if (!list.Contents?.length) {
    console.log('ℹ️  Aucun backup S3 trouvé.');
    return { skipped: true };
  }

  // Trier par date (les noms incluent le timestamp ISO)
  const latest = list.Contents.sort((a, b) => b.Key.localeCompare(a.Key))[0];
  console.log(`⬇️  Restauration depuis S3 : ${latest.Key}`);

  const obj = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: latest.Key }));

  // Décompresser et écrire data.db
  const gunzip = createGunzip();
  const out = createWriteStream(DB_PATH);
  await pipeline(obj.Body, gunzip, out);

  console.log(`✅ Restauration terminée — ${DB_PATH}`);
  return { restored: latest.Key };
}

// ── Scheduler : lance un backup toutes les 24h ────────────────────────────────
export function scheduleBackup(db) {
  const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

  const run = async () => {
    try { await backupToS3(db); }
    catch (e) { console.error('Backup S3 échoué :', e.message); }
  };

  // Premier backup 5 min après le démarrage (laisser le temps au seed de finir)
  setTimeout(run, 5 * 60 * 1000);
  // Puis toutes les 24h
  setInterval(run, INTERVAL_MS);

  console.log('🗓  Backup automatique S3 planifié (toutes les 24h)');
}
