import express from 'express';
import fs from 'node:fs';
import { config, paths, hasPodcastIndex, assertConfig } from './config.js';
import { binaryPath, modelPath } from './services/llamaServer.js';
import { recoverInterruptedJobs } from './db.js';
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

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/status', (_req, res) => {
    res.json({
        ok: true,
        podcastIndexEnabled: hasPodcastIndex(),
        whisperModel: config.whisperModel,
        itunesCountry: config.itunesCountry,
        summarizer: config.summarizer,
        backends: {
            claude: Boolean(config.anthropicApiKey) && !config.anthropicApiKey.endsWith('...'),
            mistral: Boolean(config.mistral.apiKey) && !config.mistral.apiKey.endsWith('...'),
            local: fs.existsSync(binaryPath()) && fs.existsSync(modelPath())
        },
        localModel: config.local.modelFile.replace(/\.gguf$/i, '')
    });
});

app.use('/api', searchRoutes);
app.use('/api', showRoutes);
app.use('/api', jobRoutes);

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
