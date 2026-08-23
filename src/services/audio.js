import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpegPath from 'ffmpeg-static';
import { paths, USER_AGENT } from '../config.js';

export const audioPathFor = (episodeId, ext) => path.join(paths.audio, `${episodeId}.${ext}`);

/**
 * Stream the enclosure to disk, reporting progress from Content-Length.
 * Podcast enclosures are usually redirect-tracked (Podtrac, Megaphone, Chartable),
 * and several CDNs reject requests without a real User-Agent.
 */
export async function downloadAudio(url, destPath, onProgress = () => {}) {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
        redirect: 'follow'
    });
    if (!res.ok) throw new Error(`Audio download failed (${res.status}) for ${url}`);
    if (!res.body) throw new Error('Audio response had no body');

    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    let lastReported = 0;

    const tmp = `${destPath}.part`;
    await pipeline(
        Readable.fromWeb(res.body),
        async function* (source) {
            for await (const chunk of source) {
                received += chunk.length;
                // Throttle: progress writes hit SQLite and SSE on every chunk otherwise.
                if (total > 0 && received - lastReported > 1_000_000) {
                    lastReported = received;
                    onProgress(received / total, { received, total });
                }
                yield chunk;
            }
        },
        fs.createWriteStream(tmp)
    );

    fs.renameSync(tmp, destPath);
    onProgress(1, { received, total: total || received });
    return { path: destPath, bytes: received };
}

/** whisper.cpp only accepts 16 kHz mono 16-bit PCM. */
export function convertToWav(inputPath, wavPath) {
    return new Promise((resolve, reject) => {
        const proc = spawn(
            ffmpegPath,
            ['-nostdin', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wavPath],
            { stdio: ['ignore', 'ignore', 'pipe'] }
        );

        let stderr = '';
        proc.stderr.on('data', (d) => {
            stderr += d.toString();
            if (stderr.length > 20000) stderr = stderr.slice(-10000);
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) resolve({ path: wavPath });
            else reject(new Error(`ffmpeg exited ${code}:\n${stderr.slice(-1500)}`));
        });
    });
}

/** Duration in seconds, read from the converted WAV (ffmpeg writes it to stderr). */
export function probeDuration(filePath) {
    return new Promise((resolve) => {
        const proc = spawn(ffmpegPath, ['-nostdin', '-i', filePath], {
            stdio: ['ignore', 'ignore', 'pipe']
        });
        let stderr = '';
        proc.stderr.on('data', (d) => (stderr += d.toString()));
        proc.on('error', () => resolve(null));
        proc.on('close', () => {
            const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
            if (!m) return resolve(null);
            resolve(Math.round(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])));
        });
    });
}

export function removeIfExists(...filePaths) {
    for (const p of filePaths) {
        if (p && fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
            } catch {
                /* best effort — a locked file shouldn't fail the job */
            }
        }
    }
}
