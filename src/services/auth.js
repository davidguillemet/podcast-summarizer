import crypto from 'node:crypto';

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
