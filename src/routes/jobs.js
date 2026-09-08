import { Router } from 'express';
import {
    getEpisode,
    getShow,
    getJob,
    getActiveJobForEpisode,
    getSummary,
    getSummaryById,
    listSummaries,
    deleteSummary,
    getTranscript,
    deleteTranscript,
    createJob,
    getUserById
} from '../db.js';
import { enqueue, position, queueState } from '../queue.js';
import { jobEvents, resolveApiKey } from '../services/pipeline.js';
import { audioPathFor, removeIfExists } from '../services/audio.js';
import { SUMMARY_LEVELS, DEFAULT_SUMMARY_LEVEL } from '../services/summary-schema.js';
import { config } from '../config.js';

const router = Router();

const withQueue = (job) => (job ? { ...job, queuePosition: position(job.id) } : job);

/**
 * Start (or rejoin) a job for an episode. `backend` overrides SUMMARIZER for this run;
 * `level` overrides the user's account default detail level for this run only — the
 * resolved value (never null) is stored on the job so history/comparison can show it.
 */
router.post('/jobs', (req, res) => {
    const episodeId = Number(req.body?.episodeId);
    const episode = getEpisode(episodeId);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });

    const backend = req.body?.backend ?? null;
    if (backend && !['claude', 'mistral', 'local'].includes(backend)) {
        return res.status(400).json({ error: 'backend must be "claude", "mistral" or "local"' });
    }

    const requestedLevel = req.body?.level ?? null;
    if (requestedLevel && !SUMMARY_LEVELS.includes(requestedLevel)) {
        return res.status(400).json({ error: `level must be one of: ${SUMMARY_LEVELS.join(', ')}` });
    }
    const user = getUserById(req.session.user_id);
    const level = requestedLevel || user?.summary_level || DEFAULT_SUMMARY_LEVEL;

    // Fail before transcribing, not after — a doomed job would otherwise burn minutes of
    // whisper time only to hit the same check again at the summarize step.
    try {
        resolveApiKey(req.session.user_id, backend || config.summarizer);
    } catch (err) {
        return res.status(403).json({ error: err.message });
    }

    // Don't queue a second run for an episode already in flight.
    const active = getActiveJobForEpisode(episodeId);
    if (active) return res.json({ job: withQueue(active), reused: true });

    const job = createJob(episodeId, backend, req.session.user_id, level);
    enqueue(job.id);
    res.status(201).json({ job: withQueue(getJob(job.id)), reused: false });
});

router.get('/jobs/:id', (req, res) => {
    const job = getJob(Number(req.params.id));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ job: withQueue(job) });
});

router.get('/queue', (_req, res) => res.json(queueState()));

/** Server-sent events: live progress for one job. */
router.get('/jobs/:id/events', (req, res) => {
    const jobId = Number(req.params.id);
    const initial = getJob(jobId);
    if (!initial) return res.status(404).json({ error: 'Job not found' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    const send = (job) => {
        if (!job || job.id !== jobId) return;
        res.write(`data: ${JSON.stringify(withQueue(job))}\n\n`);
    };

    send(initial);
    jobEvents.on('update', send);

    // Proxy-agnostic keepalive so the connection isn't reaped while whisper runs.
    const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 15000);

    req.on('close', () => {
        clearInterval(keepAlive);
        jobEvents.off('update', send);
    });
});

/** Shared response shape for both the "latest" and "one specific run" summary views. */
function summaryDetail(episode, summary) {
    const transcript = getTranscript(episode.id);
    return {
        episode,
        show: getShow(episode.show_id),
        summary: {
            ...summary,
            data: JSON.parse(summary.json),
            json: undefined
        },
        transcript: transcript
            ? {
                  source: transcript.source,
                  language: transcript.language,
                  duration_sec: transcript.duration_sec,
                  chars: transcript.text.length
              }
            : null
    };
}

router.get('/episodes/:id/summary', (req, res) => {
    const episodeId = Number(req.params.id);
    const episode = getEpisode(episodeId);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });

    const summary = getSummary(episodeId);
    if (!summary) return res.status(404).json({ error: 'No summary yet for this episode' });

    res.json(summaryDetail(episode, summary));
});

/** One specific summary run, addressed by its own id — used by the history view. */
router.get('/summaries/:id', (req, res) => {
    const summary = getSummaryById(Number(req.params.id));
    if (!summary) return res.status(404).json({ error: 'Summary not found' });
    res.json(summaryDetail(getEpisode(summary.episode_id), summary));
});

/** Every summary generated for this episode — lets the UI compare backends and past runs. */
router.get('/episodes/:id/summaries', (req, res) => {
    const episodeId = Number(req.params.id);
    const episode = getEpisode(episodeId);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    res.json({
        episode,
        show: getShow(episode.show_id),
        summaries: listSummaries(episodeId).map((s) => ({
            ...s,
            data: JSON.parse(s.json),
            json: undefined
        }))
    });
});

/** Delete one summary run. The transcript is untouched, so re-summarizing stays cheap. */
router.delete('/summaries/:id', (req, res) => {
    const summary = getSummaryById(Number(req.params.id));
    if (!summary) return res.status(404).json({ error: 'Summary not found' });
    deleteSummary(summary.id);
    res.json({ ok: true, episodeId: summary.episode_id });
});

/** `?format=json` returns episode/show context alongside the text, for the in-app reading view. */
router.get('/episodes/:id/transcript', (req, res) => {
    const episodeId = Number(req.params.id);
    const transcript = getTranscript(episodeId);
    if (!transcript) return res.status(404).json({ error: 'No transcript for this episode' });

    if (req.query.format === 'json') {
        const episode = getEpisode(episodeId);
        return res.json({
            episode,
            show: getShow(episode.show_id),
            transcript: {
                text: transcript.text,
                language: transcript.language,
                source: transcript.source,
                duration_sec: transcript.duration_sec
            }
        });
    }
    res.type('text/plain').send(transcript.text);
});

/** Drop the transcript and every summary for this episode — the whole pipeline result. */
router.delete('/episodes/:id/transcript', (req, res) => {
    const episodeId = Number(req.params.id);
    if (!getEpisode(episodeId)) return res.status(404).json({ error: 'Episode not found' });
    if (!deleteTranscript(episodeId)) return res.status(404).json({ error: 'No transcript for this episode' });
    res.json({ ok: true });
});

/** Drop cached media for an episode; the transcript and summary are kept. */
router.delete('/episodes/:id/audio', (req, res) => {
    const episodeId = Number(req.params.id);
    if (!getEpisode(episodeId)) return res.status(404).json({ error: 'Episode not found' });
    removeIfExists(audioPathFor(episodeId, 'mp3'), audioPathFor(episodeId, 'wav'));
    res.json({ ok: true });
});

export default router;
