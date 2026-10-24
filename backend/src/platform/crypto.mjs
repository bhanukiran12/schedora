import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { fail } from '../http.mjs';

// AES-256-GCM for secrets stored in the database (OAuth tokens, payment keys, SSO client secrets).
// APP_ENCRYPTION_KEY is 32 random bytes, base64-encoded. Development falls back to a fixed key so
// local data survives restarts; production refuses to store secrets without a configured key.
function key(config) {
  if (config.encryptionKey) {
    const buffer = Buffer.from(config.encryptionKey, 'base64');
    if (buffer.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
    return buffer;
  }
  if (config.production) fail(503, 'encryption_not_configured', 'Connecting integrations needs APP_ENCRYPTION_KEY on the server.');
  return createHash('sha256').update('schedora-development-only-key').digest();
}

export function encryptJson(config, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(config), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function decryptJson(config, payload) {
  const [version, iv, tag, data] = String(payload).split('.');
  if (version !== 'v1') throw new Error('Unknown secret format.');
  const decipher = createDecipheriv('aes-256-gcm', key(config), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8'));
}
