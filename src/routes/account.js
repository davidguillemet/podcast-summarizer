import { Router } from 'express';
import { getUserById, setUserApiKey, setUserSummaryLevel, setUserModel } from '../db.js';
import { encryptSecret } from '../services/auth.js';
import { SUMMARY_LEVELS } from '../services/summary-schema.js';
import { CLAUDE_MODEL, CLAUDE_MODELS, MISTRAL_MODEL, MISTRAL_MODELS } from '../services/summarize.js';

const router = Router();

router.get('/account', (req, res) => {
    const user = getUserById(req.session.user_id);
    res.json({
        username: user.username,
        plan: user.plan,
        claudeKeySet: Boolean(user.claude_api_key_enc),
        mistralKeySet: Boolean(user.mistral_api_key_enc),
        summaryLevel: user.summary_level,
        claudeModel: user.claude_model || CLAUDE_MODEL,
        mistralModel: user.mistral_model || MISTRAL_MODEL,
        claudeModels: CLAUDE_MODELS,
        mistralModels: MISTRAL_MODELS
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
 * Body: { claudeModel?, mistralModel? }. A present value must be one of that backend's
 * MODELS; an omitted field leaves it untouched. Default model per backend for this user's
 * jobs — see resolveModel() in services/pipeline.js.
 */
router.put('/account/models', (req, res) => {
    const { claudeModel, mistralModel } = req.body ?? {};
    if (claudeModel !== undefined) {
        if (!CLAUDE_MODELS.some((m) => m.id === claudeModel)) {
            return res.status(400).json({ error: `claudeModel must be one of: ${CLAUDE_MODELS.map((m) => m.id).join(', ')}` });
        }
        setUserModel(req.session.user_id, 'claude', claudeModel);
    }
    if (mistralModel !== undefined) {
        if (!MISTRAL_MODELS.some((m) => m.id === mistralModel)) {
            return res.status(400).json({ error: `mistralModel must be one of: ${MISTRAL_MODELS.map((m) => m.id).join(', ')}` });
        }
        setUserModel(req.session.user_id, 'mistral', mistralModel);
    }
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
