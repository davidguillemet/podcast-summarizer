import { Router } from 'express';
import { config } from '../config.js';
import { getUserByUsername, createSession, deleteSession } from '../db.js';
import { verifyPassword, generateSessionToken } from '../services/auth.js';

const router = Router();
const SESSION_COOKIE = 'sid';
const ttlMs = () => config.sessionTtlDays * 24 * 60 * 60 * 1000;

function setSessionCookie(res, token) {
    const parts = [
        `${SESSION_COOKIE}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(ttlMs() / 1000)}`
    ];
    if (config.cookieSecure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
}

router.post('/login', (req, res) => {
    const { username, password } = req.body ?? {};
    const user = username ? getUserByUsername(username) : null;
    const ok = user && password && verifyPassword(password, user.password_hash, user.password_salt);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

    const token = generateSessionToken();
    createSession(token, user.id, new Date(Date.now() + ttlMs()).toISOString());
    setSessionCookie(res, token);
    res.json({ ok: true, username: user.username });
});

router.post('/logout', (req, res) => {
    if (req.session) deleteSession(req.session.token);
    clearSessionCookie(res);
    res.json({ ok: true });
});

/** Always 200, even when logged out — the frontend polls this to decide login vs. app. */
router.get('/session', (req, res) => {
    res.json({ authenticated: Boolean(req.session), username: req.session?.username ?? null });
});

export default router;
