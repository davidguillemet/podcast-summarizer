import { Router } from 'express';
import { getUserById, setUserApiKey, setUserSummaryLevel } from '../db.js';
import { encryptSecret } from '../services/auth.js';
import { SUMMARY_LEVELS } from '../services/summary-schema.js';

const router = Router();

router.get('/account', (req, res) => {
    const user = getUserById(req.session.user_id);
    res.json({
        username: user.username,
        plan: user.plan,
        claudeKeySet: Boolean(user.claude_api_key_enc),
        mistralKeySet: Boolean(user.mistral_api_key_enc),
        summaryLevel: user.summary_level
    });
});

/** Body: { level }. Default detail level applied to this user's new jobs; overridable per run. */
router.put('/account/summary-level', (req, res) => {
    const { level } = req.body ?? {};
    if (!SUMMARY_LEVELS.includes(level)) {
        return res.status(400).json({ error: `level must be one of: ${SUMMARY_LEVELS.join(', ')}` });
    }
    setUserSummaryLevel(req.session.user_id, level);
    res.json({ ok: true });
});

/**
 * Body: { claudeApiKey?, mistralApiKey? }. A present non-empty string sets/replaces that
 * key; an explicit empty string clears it; an omitted field leaves it untouched. The raw
 * key is never sent back — GET /account only ever reports whether one is set.
 */
router.put('/account/keys', (req, res) => {
    const { claudeApiKey, mistralApiKey } = req.body ?? {};
    if (claudeApiKey !== undefined) {
        setUserApiKey(req.session.user_id, 'claude', claudeApiKey ? encryptSecret(claudeApiKey) : null);
    }
    if (mistralApiKey !== undefined) {
        setUserApiKey(req.session.user_id, 'mistral', mistralApiKey ? encryptSecret(mistralApiKey) : null);
    }
    res.json({ ok: true });
});

export default router;
