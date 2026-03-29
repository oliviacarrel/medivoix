import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const KEY = scryptSync(process.env.JWT_SECRET || 'medivoix-dev-fallback-key', 'medivoix-salt', 32);
const MARKER = 'enc:'; // prefix to detect encrypted data

export function encrypt(text) {
  if (!text) return text;
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return MARKER + iv.toString('hex') + ':' + encrypted.toString('hex');
}

export function decrypt(text) {
  if (!text || !text.startsWith(MARKER)) return text; // not encrypted or null
  try {
    const raw = text.slice(MARKER.length);
    const colonIdx = raw.indexOf(':');
    const iv  = Buffer.from(raw.slice(0, colonIdx), 'hex');
    const enc = Buffer.from(raw.slice(colonIdx + 1), 'hex');
    const decipher = createDecipheriv('aes-256-cbc', KEY, iv);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return text; // fallback: return as-is if decryption fails
  }
}
