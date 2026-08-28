import crypto from 'node:crypto';
import { config } from '../config.js';

const KEY_LENGTH = 64;

/** scrypt with a random salt — no extra dependency, and deliberately expensive to brute-force. */
export function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex');
    return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
    const candidate = crypto.scryptSync(password, salt, KEY_LENGTH);
    const stored = Buffer.from(hash, 'hex');
    return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

/** Opaque, unguessable, looked up server-side — no need to sign or encode anything into it. */
export const generateSessionToken = () => crypto.randomBytes(32).toString('hex');

const ENC_ALGO = 'aes-256-gcm';

/**
 * Users' own Claude/Mistral keys, encrypted at rest with ENCRYPTION_KEY. This protects the
 * key from anyone who gets hold of the SQLite file (a stolen backup, a copied disk) — it does
 * NOT and cannot protect the key from this server's own process, which must decrypt it to make
 * the API call on the user's behalf. That limit is inherent to any server-side BYOK design.
 */
export function encryptSecret(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ENC_ALGO, Buffer.from(config.encryptionKey, 'hex'), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptSecret(stored) {
    const [ivHex, tagHex, dataHex] = stored.split(':');
    const decipher = crypto.createDecipheriv(ENC_ALGO, Buffer.from(config.encryptionKey, 'hex'), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
