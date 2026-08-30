import { EventEmitter } from 'node:events';
import {
    getEpisode,
    getShow,
    getTranscript,
    saveTranscript,
    saveSummary,
    updateJob,
    getUserById
} from '../db.js';
import { decryptSecret } from './auth.js';
import { audioPathFor, downloadAudio, convertToWav, probeDuration, removeIfExists } from './audio.js';
import {
    assertWhisperReady,
    assertWhisperRemoteReady,
    transcribeLocal,
    transcribeRemote,
    fetchPublisherTranscript,
    buildTimestampedTranscript
} from './transcribe.js';
import { summarizeTranscript, estimateCost } from './summarize.js';
import { config } from '../config.js';

/** Progress events for the SSE endpoint. Payload: the full job row. */
export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(0);

/**
 * Each stage owns a slice of the 0..1 bar so the UI advances monotonically
 * instead of resetting to zero four times.
 */
const STAGE_SPAN = {
    downloading: [0.0, 0.35],
    converting: [0.35, 0.45],
    transcribing: [0.45, 0.9],
    summarizing: [0.9, 1.0]
};

function makeReporter(jobId) {
    let lastEmit = 0;
    return function report(stage, fraction, { force = false } = {}) {
        const [lo, hi] = STAGE_SPAN[stage] ?? [0, 1];
        const progress = Math.min(1, Math.max(0, lo + (hi - lo) * Math.min(1, Math.max(0, fraction))));
        const now = Date.now();
        // Throttle DB writes + SSE frames; whisper emits progress very frequently.
        if (!force && now - lastEmit < 400) return;
        lastEmit = now;
        const job = updateJob(jobId, { status: stage, stage, progress });
        jobEvents.emit('update', job);
    };
}

const KEY_COLUMN = { claude: 'claude_api_key_enc', mistral: 'mistral_api_key_enc' };
const BACKEND_LABEL = { claude: 'Claude', mistral: 'Mistral' };

/**
 * The key to use for this backend: the job owner's own if they've set one (any plan), or
 * null — meaning "fall back to the server's .env key" — but only for a 'premium' user.
 * No billing exists yet, so free is every user's plan until an admin changes it by hand;
 * a free user with no key of their own is a hard stop, not a silent fallback to the shared
 * key, which is the entire point of the plan split. 'local' has no key concept at all, so
 * it's never restricted here. Called both as a pre-flight check in routes/jobs.js (so a
 * doomed job never queues) and again here at run time as a safety net.
 */
export function resolveApiKey(userId, backendName) {
    const column = KEY_COLUMN[backendName];
    if (!column) return null;

    const user = getUserById(userId);
    const ownKey = user?.[column] ? decryptSecret(user[column]) : null;
    if (ownKey) return ownKey;
    if (user?.plan === 'premium') return null;

    throw new Error(
        `Your account is on the free plan and has no ${BACKEND_LABEL[backendName]} API key set. ` +
            'Add one from Account, or ask the admin to upgrade your plan.'
    );
}

function fail(jobId, error) {
    const job = updateJob(jobId, {
        status: 'failed',
        stage: 'failed',
        error: String(error?.message || error).slice(0, 2000),
        finished_at: new Date().toISOString()
    });
    jobEvents.emit('update', job);
    return job;
}

/**
 * Run one episode through: download → convert → transcribe → summarize.
 * Stages whose artifacts already exist are skipped, so re-summarizing a cached
 * transcript costs nothing but the model call.
 */
export async function runJob(jobId) {
    const job = updateJob(jobId, { status: 'queued', stage: 'queued', progress: 0, error: null });
    jobEvents.emit('update', job);

    const episode = getEpisode(job.episode_id);
    if (!episode) return fail(jobId, new Error('Episode not found'));
    const show = getShow(episode.show_id);
    const report = makeReporter(jobId);

    let mp3Path = null;
    let wavPath = null;

    try {
        let transcript = getTranscript(episode.id);

        if (!transcript) {
            let result = null;

            // 1. Free path: a publisher-supplied transcript skips all the heavy lifting.
            if (episode.transcript_url) {
                try {
                    report('downloading', 0.5, { force: true });
                    const fetched = await fetchPublisherTranscript(episode.transcript_url);
                    if (fetched.text && fetched.text.length > 200) {
                        result = { ...fetched, source: 'publisher' };
                    }
                } catch {
                    result = null; // fall through to Whisper
                }
            }

            // 2. Otherwise download the audio and transcribe it on-device.
            if (!result) {
                if (!episode.audio_url) {
                    throw new Error('Episode has no audio URL and no usable transcript');
                }
                if (config.whisperRemoteUrl) {
                    await assertWhisperRemoteReady();
                } else {
                    assertWhisperReady();
                }

                mp3Path = audioPathFor(episode.id, 'mp3');
                wavPath = audioPathFor(episode.id, 'wav');
                updateJob(jobId, { audio_path: mp3Path, wav_path: wavPath });

                report('downloading', 0, { force: true });
                await downloadAudio(episode.audio_url, mp3Path, (f) => report('downloading', f));

                report('converting', 0.1, { force: true });
                await convertToWav(mp3Path, wavPath);
                const durationSec = await probeDuration(wavPath);
                removeIfExists(mp3Path); // the WAV is all whisper needs from here
                mp3Path = null;
                report('converting', 1, { force: true });

                report('transcribing', 0, { force: true });
                const transcribe = config.whisperRemoteUrl ? transcribeRemote : transcribeLocal;
                const asr = await transcribe(wavPath, {
                    onProgress: (f) => report('transcribing', f)
                });
                result = { ...asr, source: 'whisper', durationSec };
            }

            if (!result.text || result.text.trim().length === 0) {
                throw new Error('Transcription produced no text');
            }

            transcript = saveTranscript({
                episodeId: episode.id,
                text: result.text,
                srt: result.srt,
                language: result.language,
                source: result.source,
                durationSec: result.durationSec ?? episode.duration_sec ?? null
            });
        }

        // 3. Summarize with whichever backend this job asked for.
        const backendName = job.backend || config.summarizer;
        report('summarizing', 0.2, { force: true });

        const forModel = buildTimestampedTranscript(transcript.srt, transcript.text);
        const { data, refusal, model, usage, backend } = await summarizeTranscript(forModel, {
            backend: backendName,
            // The job owner's own key, if they've saved one for this backend — falls back to
            // the server's .env key inside the backend module when this is null.
            apiKey: resolveApiKey(job.user_id, backendName),
            episodeTitle: episode.title,
            showTitle: show?.title,
            // The local backend has long sub-steps (model load, per-segment notes);
            // surface them so the UI isn't a frozen bar for minutes.
            onStatus: (note) => {
                const updated = updateJob(jobId, { note });
                jobEvents.emit('update', updated);
            }
        });

        if (refusal) throw new Error(`Model declined to summarize this episode: ${refusal}`);

        saveSummary({
            episodeId: episode.id,
            data,
            model,
            backend: backend || backendName,
            inputTokens: usage?.input_tokens ?? null,
            outputTokens: usage?.output_tokens ?? null
        });

        removeIfExists(wavPath);

        const done = updateJob(jobId, {
            status: 'done',
            stage: 'done',
            progress: 1,
            error: null,
            note: null,
            finished_at: new Date().toISOString()
        });
        jobEvents.emit('update', done);
        return { job: done, cost: estimateCost(usage, backendName) };
    } catch (err) {
        removeIfExists(mp3Path, wavPath);
        return fail(jobId, err);
    }
}
