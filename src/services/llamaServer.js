import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config, paths } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LLAMA_ROOT = path.resolve(here, '..', '..', 'vendor', 'llama.cpp');

export const binaryPath = () => path.join(LLAMA_ROOT, 'build', 'bin', 'llama-server');
export const modelPath = () => path.join(paths.models, config.local.modelFile);

export function assertLocalReady() {
    if (!fs.existsSync(binaryPath())) {
        throw new Error(
            `llama-server not built at ${binaryPath()}.\n` +
                'Build it with: cd vendor/llama.cpp && cmake -B build -DGGML_METAL=ON ' +
                '-DGGML_METAL_EMBED_LIBRARY=ON -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF && cmake --build build -j'
        );
    }
    if (!fs.existsSync(modelPath())) {
        throw new Error(`Local model not found at ${modelPath()}. See README for the download command.`);
    }
}

let child = null;
let readyPromise = null;
let idleTimer = null;
let logTail = '';
let activeContext = null;

const baseUrl = () => `http://127.0.0.1:${config.local.port}`;

/**
 * The context window of the server we are actually talking to, which is not
 * necessarily the configured one — see the adoption logic in `start()`.
 * Callers must size their prompt budget against this, not against config.
 */
export const effectiveContext = () => activeContext ?? config.local.contextSize;

/** Ask a server already listening on our port what context size it was started with. */
async function probeExisting() {
    try {
        const res = await fetch(`${baseUrl()}/props`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) return null;
        const props = await res.json();
        return props.default_generation_settings?.n_ctx ?? null;
    } catch {
        return null; // nothing listening — the normal case
    }
}

/** Free ~17 GB of unified memory when the model has gone unused for a while. */
function scheduleIdleShutdown() {
    clearTimeout(idleTimer);
    if (config.local.idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => stop('idle timeout'), config.local.idleTimeoutMs);
    idleTimer.unref?.();
}

export function isRunning() {
    return Boolean(child) && child.exitCode === null;
}

export async function ensureRunning({ onStatus = () => {} } = {}) {
    if (readyPromise && isRunning()) {
        scheduleIdleShutdown();
        return readyPromise;
    }
    readyPromise = start({ onStatus });
    try {
        const url = await readyPromise;
        scheduleIdleShutdown();
        return url;
    } catch (err) {
        readyPromise = null;
        throw err;
    }
}

async function start({ onStatus }) {
    assertLocalReady();

    // A previous process may have been killed without its child being reaped.
    // Adopting that orphan silently would mean running against a context window
    // we never chose, so make the size we actually got authoritative.
    const orphanContext = await probeExisting();
    if (orphanContext !== null) {
        activeContext = orphanContext;
        console.log(
            `[llama-server] reusing the instance already on port ${config.local.port} (n_ctx=${orphanContext})` +
                (orphanContext !== config.local.contextSize
                    ? ` — differs from LLAMA_CONTEXT=${config.local.contextSize}; using ${orphanContext}. ` +
                      'Run `pkill -f llama-server` to start fresh.'
                    : '')
        );
        return baseUrl();
    }

    onStatus('Loading the local model into GPU memory…');

    const args = [
        '-m', modelPath(),
        '--host', '127.0.0.1',
        '--port', String(config.local.port),
        '-c', String(config.local.contextSize),
        '-ngl', '99',                       // all layers on the GPU
        '--cache-type-k', 'q8_0',           // halves KV cache so 32k context fits alongside weights
        '--cache-type-v', 'q8_0',
        '-np', '1',
        '--jinja',                          // use the model's own chat template
        '-t', String(Math.min(8, os.cpus().length))
    ];

    child = spawn(binaryPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    logTail = '';

    const capture = (buf) => {
        logTail = (logTail + buf.toString()).slice(-8000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    child.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
            console.error(`[llama-server] exited ${code} (${signal ?? 'no signal'})\n${logTail.slice(-1200)}`);
        }
        child = null;
        readyPromise = null;
        activeContext = null;
    });

    await waitForHealth(onStatus);
    activeContext = config.local.contextSize;
    return baseUrl();
}

async function waitForHealth(onStatus) {
    const deadline = Date.now() + config.local.startupTimeoutMs;
    let lastError = 'timed out';

    while (Date.now() < deadline) {
        if (!isRunning()) {
            throw new Error(`llama-server failed to start:\n${logTail.slice(-1200)}`);
        }
        try {
            const res = await fetch(`${baseUrl()}/health`);
            if (res.ok) return;
            // 503 while the weights are still loading is expected.
            lastError = `health returned ${res.status}`;
            onStatus('Loading the local model into GPU memory…');
        } catch (err) {
            lastError = err.message;
        }
        await new Promise((r) => setTimeout(r, 700));
    }
    stop('startup timeout');
    throw new Error(`llama-server did not become healthy (${lastError}).\n${logTail.slice(-800)}`);
}

export function stop(reason = 'shutdown') {
    clearTimeout(idleTimer);
    if (child) {
        console.log(`[llama-server] stopping (${reason})`);
        child.kill('SIGTERM');
        child = null;
    }
    readyPromise = null;
    activeContext = null;
}

for (const signal of ['exit', 'SIGINT', 'SIGTERM']) {
    process.on(signal, () => stop(signal));
}

/* ------------------------------------------------------------- HTTP calls */

async function post(endpoint, body, { timeoutMs = 20 * 60 * 1000 } = {}) {
    const res = await fetch(`${baseUrl()}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`llama-server ${endpoint} failed (${res.status}): ${detail.slice(0, 400)}`);
    }
    return res.json();
}

/** Exact token count from the model's own tokenizer — no character-based guessing. */
export async function countTokens(text) {
    const body = await post('/tokenize', { content: text }, { timeoutMs: 120000 });
    return body.tokens?.length ?? 0;
}

/**
 * Chat completion. When `schema` is supplied, llama.cpp compiles it to a GBNF
 * grammar and constrains sampling, so the output is structurally valid by
 * construction rather than by hope.
 */
export async function chat({ system, user, schema = null, maxTokens = 4096, temperature = 0.15 }) {
    const body = {
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
        ],
        temperature,
        top_p: 0.95,
        max_tokens: maxTokens,
        cache_prompt: true
    };
    if (schema) {
        body.response_format = { type: 'json_schema', json_schema: { name: 'summary', schema, strict: true } };
    }

    const result = await post('/v1/chat/completions', body);
    const choice = result.choices?.[0];
    if (!choice) throw new Error('llama-server returned no choices');

    return {
        text: choice.message?.content ?? '',
        finishReason: choice.finish_reason,
        usage: result.usage ?? null
    };
}
