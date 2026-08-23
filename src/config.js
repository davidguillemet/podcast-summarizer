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
    // 'claude' (API, best quality) or 'local' (Mistral Small via llama.cpp, free/offline)
    summarizer: (process.env.SUMMARIZER || 'claude').toLowerCase(),
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

export const usesClaude = () => config.summarizer !== 'local';

/** Podcast Index is optional — the app degrades to iTunes-only without it. */
export const hasPodcastIndex = () =>
    Boolean(config.podcastIndex.key && config.podcastIndex.secret);

/** Fail loudly at boot rather than 90% of the way through a job. */
export function assertConfig() {
    const problems = [];

    if (!['claude', 'local'].includes(config.summarizer)) {
        problems.push(`SUMMARIZER must be "claude" or "local" (got "${config.summarizer}").`);
    }

    // The API key only matters for the Claude backend; the local one needs no credentials.
    if (usesClaude()) {
        const key = config.anthropicApiKey;
        if (!key) {
            problems.push(
                'ANTHROPIC_API_KEY is missing — copy .env.example to .env and fill it in, ' +
                    'or set SUMMARIZER=local to summarize on-device instead.'
            );
        } else if (key === 'sk-ant-...' || key.endsWith('...')) {
            // The .env.example placeholder is non-empty, so a naive presence check
            // lets it through and the run dies at the very last step instead.
            problems.push('ANTHROPIC_API_KEY is still the placeholder from .env.example — paste your real key.');
        }
    }
    if (problems.length > 0) {
        throw new Error(`Configuration error:\n  - ${problems.join('\n  - ')}`);
    }
}
