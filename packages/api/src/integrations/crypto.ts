import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALG = 'aes-256-gcm';
const KEY_BYTES = 32;

function parseKey(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error(`TENANT_ENCRYPTION_KEY must be a ${KEY_BYTES * 2}-char hex string (got ${hexKey.length} chars)`);
  }
  return key;
}

// Returns "ivHex:ciphertextHex:tagHex"
export function encrypt(plaintext: string, hexKey: string): string {
  const key = parseKey(hexKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), encrypted.toString('hex'), tag.toString('hex')].join(':');
}

export function decrypt(ciphertext: string, hexKey: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid ciphertext format');
  const [ivHex, encHex, tagHex] = parts;
  const key = parseKey(hexKey);
  const iv = Buffer.from(ivHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
