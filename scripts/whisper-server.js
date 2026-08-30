import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { assertWhisperReady, transcribeLocal } from '../src/services/transcribe.js';

/**
 * Runs on a machine with a real GPU (Metal/CUDA) to serve transcription requests from a host
 * where local CPU transcription isn't practical — see WHISPER_REMOTE_URL in .env and
 * "Remote transcription" in README.md. Reuses transcribeLocal() as-is; this is purely a thin
 * HTTP wrapper around it, so it stays in sync with the local path automatically.
 *
 * No authentication: this is meant for a trusted home LAN only, same trust model as
 * llama-server's local port. Don't expose this port to the internet.
 */

const PORT = Number(process.env.WHISPER_SERVER_PORT) || 4301;

try {
    assertWhisperReady();
} catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, whisperModel: config.whisperModel }));
        return;
    }

    if (req.method === 'POST' && req.url === '/transcribe') {
        const tmpPath = path.join(os.tmpdir(), `whisper-remote-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
        try {
            const wav = await readBody(req);
            fs.writeFileSync(tmpPath, wav);
            console.log(`[whisper-server] transcribing ${(wav.length / 1e6).toFixed(1)} MB…`);

            const result = await transcribeLocal(tmpPath, {
                onProgress: (f) => console.log(`[whisper-server] progress: ${Math.round(f * 100)}%`)
            });

            console.log('[whisper-server] done');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[whisper-server] error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        } finally {
            fs.rm(tmpPath, { force: true }, () => {});
        }
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `No route for ${req.method} ${req.url}` }));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Whisper remote server → http://0.0.0.0:${PORT}`);
    console.log(`  Model: ${config.whisperModel}`);
    console.log('  No authentication — trusted LAN only.\n');
});
