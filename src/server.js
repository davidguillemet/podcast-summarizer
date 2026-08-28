import express from 'express';
import fs from 'node:fs';
import { config, paths, hasPodcastIndex, assertConfig } from './config.js';
import { binaryPath, modelPath } from './services/llamaServer.js';
import { recoverInterruptedJobs, getSession, deleteExpiredSessions, getUserById } from './db.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import searchRoutes from './routes/search.js';
import showRoutes from './routes/shows.js';
import jobRoutes from './routes/jobs.js';

try {
    assertConfig();
} catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
}

// Jobs run in-process, so anything mid-flight died with the previous process.
const recovered = recoverInterruptedJobs();
if (recovered > 0) {
    console.log(`Marked ${recovered} interrupted job(s) as failed after restart.`);
}
deleteExpiredSessions();

const app = express();
app.use(express.json({ limit: '1mb' }));

/** Hand-rolled — the app has no other use for cookies, so a dependency isn't worth it. */
function parseCookies(header = '') {
    const cookies = {};
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i === -1) continue;
        const key = part.slice(0, i).trim();
        if (key) cookies[key] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return cookies;
}

app.use((req, _res, next) => {
    const token = parseCookies(req.headers.cookie).sid;
    const session = token ? getSession(token) : null;
    req.session = session && session.expires_at > new Date().toISOString() ? session : null;
    next();
});

function requireAuth(req, res, next) {
    if (!req.session) return res.status(401).json({ error: 'Not authenticated' });
    next();
}

app.use('/api', authRoutes);

app.get('/api/status', (req, res) => {
    // A user's own key always makes a backend usable; the server's shared key only counts
    // for a 'premium' user — a free user must never be offered a choice that resolveApiKey()
    // (services/pipeline.js) would then reject, so this mirrors that function's rule exactly.
    const user = req.session ? getUserById(req.session.user_id) : null;
    const serverHasClaudeKey = Boolean(config.anthropicApiKey) && !config.anthropicApiKey.endsWith('...');
    const serverHasMistralKey = Boolean(config.mistral.apiKey) && !config.mistral.apiKey.endsWith('...');
    const isPremium = user?.plan === 'premium';
    res.json({
        ok: true,
        podcastIndexEnabled: hasPodcastIndex(),
        whisperModel: config.whisperModel,
        itunesCountry: config.itunesCountry,
        summarizer: config.summarizer,
        backends: {
            claude: Boolean(user?.claude_api_key_enc) || (isPremium && serverHasClaudeKey),
            mistral: Boolean(user?.mistral_api_key_enc) || (isPremium && serverHasMistralKey),
            local: fs.existsSync(binaryPath()) && fs.existsSync(modelPath())
        },
        localModel: config.local.modelFile.replace(/\.gguf$/i, '')
    });
});

app.use('/api', requireAuth, accountRoutes);
app.use('/api', requireAuth, searchRoutes);
app.use('/api', requireAuth, showRoutes);
app.use('/api', requireAuth, jobRoutes);

app.use(express.static(paths.public));

// SPA fallback for hash-free deep links.
app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile('index.html', { root: paths.public });
});

app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, _req, res, _next) => {
    console.error('[error]', err);
    res.status(500).json({ error: err.message || 'Internal error' });
});

app.listen(config.port, () => {
    console.log(`\n  Podcast Summarizer → http://localhost:${config.port}`);
    console.log(`  Transcription: whisper.cpp / ${config.whisperModel} (on-device)`);
    console.log(
        `  Summarization: ${
            config.summarizer === 'local' ? `${config.local.modelFile.replace(/\.gguf$/i, '')} (on-device)` : 'Claude API'
        }`
    );
    console.log(
        `  Search sources: iTunes${hasPodcastIndex() ? ' + Podcast Index' : ' only (set PODCASTINDEX_KEY/SECRET for more)'}\n`
    );
});
