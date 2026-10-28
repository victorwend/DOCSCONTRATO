import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Tokens dos links exclusivos.
 *  - 24 bytes aleatórios (192 bits) em base64url => impossível de adivinhar.
 *  - No banco ficam apenas: sha256 (para localizar) e o token cifrado com AES-256-GCM
 *    (para o RH poder copiar o link novamente). Um vazamento do banco sem a chave não expõe links.
 */
export function generateLinkToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function key(secret: string) {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptToken(token: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const enc = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${enc.toString('base64url')}.${tag.toString('base64url')}`;
}

export function decryptToken(payload: string, secret: string): string {
  const [v, iv, enc, tag] = payload.split('.');
  if (v !== 'v1' || !iv || !enc || !tag) throw new Error('Token cifrado inválido');
  const decipher = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]).toString('utf8');
}

export function isWellFormedToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(token);
}
