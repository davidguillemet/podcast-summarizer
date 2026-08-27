import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// Node 22 loads .env natively — no dotenv dependency needed.
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
    process.loadEnvFile(envFile);
}

export const paths = {
    root,
    public: path.join(root, 'public'),
    data: path.join(root, 'data'),
    audio: path.join(root, 'data', 'audio'),
    models: path.join(root, 'data', 'models'),
    db: path.join(root, 'data', 'podsum.db')
};

for (const dir of [paths.data, paths.audio, paths.models]) {
    fs.mkdirSync(dir, { recursive: true });
}

// Some podcast CDNs reject requests with a default/absent agent.
export const USER_AGENT = 'podcast-summarizer/1.0 (+local)';

export const config = {
    // 4300 deliberately avoids the Firebase emulator suite (4000/5002/5003/9099/9199)
    // and CRA (3000), which run alongside this on the same machine.
    port: Number(process.env.PORT) || 4300,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    whisperModel: process.env.WHISPER_MODEL || 'large-v3-turbo',
    itunesCountry: process.env.ITUNES_COUNTRY || 'fr',
    podcastIndex: {
        key: process.env.PODCASTINDEX_KEY || '',
        secret: process.env.PODCASTINDEX_SECRET || ''
    },
    // How long a login stays valid, and whether the session cookie requires HTTPS —
    // turn the latter on once a reverse proxy in front of this app terminates TLS.
    sessionTtlDays: Number(process.env.SESSION_TTL_DAYS) || 30,
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    // 'claude' (API, best quality), 'mistral' (API, hosted Mistral Large) or
    // 'local' (Mistral Small via llama.cpp, free/offline)
    summarizer: (process.env.SUMMARIZER || 'claude').toLowerCase(),
    mistral: {
        apiKey: process.env.MISTRAL_API_KEY || '',
        model: process.env.MISTRAL_MODEL || 'mistral-large-latest'
    },
    local: {
        modelFile: process.env.LOCAL_MODEL_FILE || 'Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf',
        port: Number(process.env.LLAMA_PORT) || 8110,
        // 32k fits alongside Q4 weights in 26.8 GB of GPU memory with a q8_0 KV cache;
        // longer transcripts are handled by map-reduce rather than a bigger window.
        contextSize: Number(process.env.LLAMA_CONTEXT) || 32768,
        idleTimeoutMs: Number(process.env.LLAMA_IDLE_MINUTES ?? 15) * 60_000,
        startupTimeoutMs: Number(process.env.LLAMA_STARTUP_TIMEOUT_MS) || 300_000
    }
};

/** Podcast Index is optional — the app degrades to iTunes-only without it. */
export const hasPodcastIndex = () =>
    Boolean(config.podcastIndex.key && config.podcastIndex.secret);

const SUMMARIZERS = ['claude', 'mistral', 'local'];

/**
 * A key is missing, or still the placeholder from .env.example (non-empty, so a naive
 * presence check would let it through and the run would die at the very last step instead).
 */
function checkApiKey(problems, envVar, key) {
    if (!key) {
        problems.push(
            `${envVar} is missing — copy .env.example to .env and fill it in, ` +
                `or set SUMMARIZER to one of the other backends instead.`
        );
    } else if (key.endsWith('...')) {
        problems.push(`${envVar} is still the placeholder from .env.example — paste your real key.`);
    }
}

/** Fail loudly at boot rather than 90% of the way through a job. */
export function assertConfig() {
    const problems = [];

    if (!SUMMARIZERS.includes(config.summarizer)) {
        problems.push(`SUMMARIZER must be one of ${SUMMARIZERS.join(', ')} (got "${config.summarizer}").`);
    }

    // The API keys only matter for the backend actually selected; the local one needs no credentials.
    if (config.summarizer === 'claude') checkApiKey(problems, 'ANTHROPIC_API_KEY', config.anthropicApiKey);
    if (config.summarizer === 'mistral') checkApiKey(problems, 'MISTRAL_API_KEY', config.mistral.apiKey);

    if (problems.length > 0) {
        throw new Error(`Configuration error:\n  - ${problems.join('\n  - ')}`);
    }
}
