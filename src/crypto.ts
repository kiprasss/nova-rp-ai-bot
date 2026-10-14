import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** 64 hex-символа → 32 байта; любая другая строка (не короче 16 символов) → SHA-256. */
export function deriveKey(secret: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(secret)) return Buffer.from(secret, 'hex');
  if (secret.length < 16) throw new Error('ENCRYPTION_KEY слишком короткий (нужно 64 hex-символа).');
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** AES-256-GCM. Формат: v1:<iv>:<tag>:<ciphertext> (base64). */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [ver, iv, tag, data] = payload.split(':');
  if (ver !== 'v1' || !iv || !tag || data === undefined) throw new Error('Неизвестный формат зашифрованных данных');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/** sk-proj-abc...a1b2 → «sk-...a1b2». Никогда не показывает больше 4 последних символов. */
export function maskSecret(secret: string): string {
  if (secret.length <= 10) return '••••';
  const prefix = secret.match(/^[A-Za-z]{2,6}-/)?.[0] ?? secret.slice(0, 3);
  return `${prefix}...${secret.slice(-4)}`;
}

let cachedKey: Buffer | null = null;

export function initSecretKey(secret: string): void {
  cachedKey = deriveKey(secret);
}

function key(): Buffer {
  if (!cachedKey) throw new Error('Ключ шифрования не инициализирован');
  return cachedKey;
}

export const secrets = {
  encrypt: (plain: string) => encryptSecret(plain, key()),
  decrypt: (payload: string) => decryptSecret(payload, key()),
};
