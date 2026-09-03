import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { config, USER_AGENT } from '../config.js';

const require = createRequire(import.meta.url);

/**
 * We depend on `nodejs-whisper` for the pinned whisper.cpp source tree, but drive
 * the compiled `whisper-cli` binary directly: that gives us stderr progress
 * parsing, language detection and SRT output without the wrapper's interactive
 * model prompts or its attempt to rebuild on every call.
 */
function whisperPaths() {
    const pkg = path.dirname(require.resolve('nodejs-whisper/package.json'));
    const root = path.join(pkg, 'cpp', 'whisper.cpp');
    return {
        binary: path.join(root, 'build', 'bin', 'whisper-cli'),
        model: path.join(root, 'models', `ggml-${config.whisperModel}.bin`)
    };
}

export function assertWhisperReady() {
    const { binary, model } = whisperPaths();
    if (!fs.existsSync(binary)) {
        throw new Error(
            `whisper-cli not built at ${binary}.\n` +
                'Build it with: cd node_modules/nodejs-whisper/cpp/whisper.cpp && ' +
                'cmake -B build -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON && cmake --build build -j'
        );
    }
    if (!fs.existsSync(model)) {
        throw new Error(
            `Whisper model not found at ${model}. Download ggml-${config.whisperModel}.bin into data/models/.`
        );
    }
}

/**
 * Transcribe a 16 kHz mono WAV on-device.
 * Resolves to { text, srt, language }.
 */
export function transcribeLocal(wavPath, { onProgress = () => {} } = {}) {
    const { binary, model } = whisperPaths();
    const outPrefix = wavPath.replace(/\.wav$/, '');

    return new Promise((resolve, reject) => {
        const proc = spawn(
            binary,
            [
                '-m', model,
                '-f', wavPath,
                '-l', 'auto',
                '-osrt',
                '-otxt',
                '-of', outPrefix,
                '-pp',                              // emit progress to stderr
                '-t', String(Math.max(4, Math.min(8, os.cpus().length)))
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        );

        let language = null;
        let stderrTail = '';
        let lastPct = -1;

        const scan = (buf) => {
            const s = buf.toString();
            stderrTail = (stderrTail + s).slice(-8000);

            const lang = s.match(/auto-detected language:\s*([a-z]{2,3})/i);
            if (lang) language = lang[1].toLowerCase();

            // whisper.cpp prints "progress = 42%" repeatedly with -pp
            let m;
            const re = /progress\s*=\s*(\d+)%/g;
            while ((m = re.exec(s)) !== null) {
                const pct = Number(m[1]);
                if (pct !== lastPct) {
                    lastPct = pct;
                    onProgress(pct / 100);
                }
            }
        };

        proc.stdout.on('data', scan);
        proc.stderr.on('data', scan);
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`whisper-cli exited ${code}:\n${stderrTail.slice(-1500)}`));
            }
            const srtPath = `${outPrefix}.srt`;
            const txtPath = `${outPrefix}.txt`;
            const srt = fs.existsSync(srtPath) ? fs.readFileSync(srtPath, 'utf8') : null;
            const txt = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8') : null;

            if (!srt && !txt) return reject(new Error('whisper-cli produced no output files'));

            // Clean up the intermediates; the transcript lives in SQLite from here on.
            for (const p of [srtPath, txtPath]) {
                try { fs.unlinkSync(p); } catch { /* best effort */ }
            }

            resolve({
                text: (txt || srtToPlainText(srt)).trim(),
                srt,
                language
            });
        });
    });
}

/**
 * Node's fetch() collapses every low-level failure (connection refused, DNS, timeout, a
 * dropped socket mid-transfer) into the same unhelpful "fetch failed" TypeError — the actual
 * reason is on `.cause`, one level down, and gets lost unless callers dig it out explicitly.
 */
const describeFetchError = (err) => (err.cause?.message ? `${err.message}: ${err.cause.message}` : err.message);

/**
 * Quick reachability check for the remote whisper server, run *before* downloading the
 * episode's audio — a sleeping/unreachable machine should fail in seconds with a clear
 * message, not after minutes of download + convert only to fail at the transcribe step.
 */
export async function assertWhisperRemoteReady() {
    try {
        const res = await fetch(`${config.whisperRemoteUrl}/health`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`responded with ${res.status}`);
    } catch (err) {
        throw new Error(
            `Remote transcription service unreachable at ${config.whisperRemoteUrl} — is that ` +
                `machine awake and on the network? (${describeFetchError(err)})`
        );
    }
}

/**
 * Delegate transcription to a whisper server running elsewhere (see scripts/whisper-server.js).
 * Same resolved shape as transcribeLocal: { text, srt, language }. Deliberately does not catch
 * and fall back to local transcription on failure — WHISPER_REMOTE_URL being set means local
 * CPU transcription was judged impractical, so silently falling back to it would just replace
 * a clear, fast error with a very slow, confusing one.
 */
export async function transcribeRemote(wavPath, { onProgress = () => {} } = {}) {
    onProgress(0.02); // some visible movement while the upload + remote transcription run

    let res;
    try {
        res = await fetch(`${config.whisperRemoteUrl}/transcribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'audio/wav' },
            body: fs.readFileSync(wavPath),
            signal: AbortSignal.timeout(60 * 60 * 1000) // generous — remote is fast, but long episodes exist
        });
    } catch (err) {
        // The upload/response can fail mid-transfer (sleep, Wi-Fi drop, remote restart) well
        // after assertWhisperRemoteReady() passed, so this needs its own descriptive error too.
        throw new Error(`Remote transcription request to ${config.whisperRemoteUrl} failed: ${describeFetchError(err)}`);
    }

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Remote transcription failed (${res.status}): ${detail.slice(0, 400)}`);
    }

    onProgress(0.95);
    return res.json();
}

/**
 * Fetch a publisher-supplied transcript (Podcasting 2.0). When one exists we skip
 * download + convert + transcribe entirely — it is free and instant.
 */
export async function fetchPublisherTranscript(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
        redirect: 'follow'
    });
    if (!res.ok) throw new Error(`Transcript fetch failed (${res.status})`);

    const raw = (await res.text()).trim();
    if (!raw) throw new Error('Transcript was empty');

    const looksTimed = /-->/.test(raw);
    if (!looksTimed) {
        // Plain text or JSON transcript — usable, just without timestamps.
        if (raw.startsWith('{') || raw.startsWith('[')) {
            const text = extractJsonTranscript(raw);
            if (!text) throw new Error('Unrecognised JSON transcript format');
            return { text, srt: null, language: null };
        }
        return { text: raw, srt: null, language: null };
    }

    const srt = /^WEBVTT/i.test(raw) ? vttToSrt(raw) : raw;
    return { text: srtToPlainText(srt), srt, language: null };
}

function extractJsonTranscript(raw) {
    try {
        const data = JSON.parse(raw);
        const segments = data.segments || data.results || data.transcript;
        if (Array.isArray(segments)) {
            const parts = segments
                .map((s) => s.body ?? s.text ?? s.utterance ?? '')
                .filter(Boolean);
            if (parts.length) return parts.join(' ').replace(/\s+/g, ' ').trim();
        }
        if (typeof data.text === 'string') return data.text.trim();
    } catch {
        /* fall through */
    }
    return null;
}

/** WebVTT and SRT differ mainly in the header and the millisecond separator. */
function vttToSrt(vtt) {
    return vtt
        .replace(/^WEBVTT.*?(\r?\n){2}/is, '')
        .replace(/^NOTE[\s\S]*?(\r?\n){2}/gim, '')
        .replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2');
}

/** Parse SRT (or VTT-converted SRT) into cues. */
export function parseSrt(srt) {
    if (!srt) return [];
    const cues = [];
    const blocks = srt.replace(/\r/g, '').split(/\n{2,}/);

    for (const block of blocks) {
        const lines = block.split('\n').filter((l) => l.trim() !== '');
        if (lines.length === 0) continue;

        const timeLineIndex = lines.findIndex((l) => l.includes('-->'));
        if (timeLineIndex === -1) continue;

        const m = lines[timeLineIndex].match(
            /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
        );
        if (!m) continue;

        const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
        const end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
        const text = lines.slice(timeLineIndex + 1).join(' ').trim();
        if (text) cues.push({ start, end, text });
    }
    return cues;
}

export function srtToPlainText(srt) {
    return parseSrt(srt)
        .map((c) => c.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function formatTimestamp(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Group cues into ~40s paragraphs prefixed with [mm:ss] so the model can cite
 * real timestamps. Per-cue markers would waste a large fraction of the tokens.
 */
export function buildTimestampedTranscript(srt, plainText, { windowSec = 40 } = {}) {
    const cues = parseSrt(srt);
    if (cues.length === 0) return plainText;

    const chunks = [];
    let current = null;

    for (const cue of cues) {
        if (!current || cue.start - current.start >= windowSec) {
            if (current) chunks.push(current);
            current = { start: cue.start, parts: [] };
        }
        current.parts.push(cue.text);
    }
    if (current) chunks.push(current);

    return chunks
        .map((c) => `[${formatTimestamp(c.start)}] ${c.parts.join(' ').replace(/\s+/g, ' ').trim()}`)
        .join('\n');
}
