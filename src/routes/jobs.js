import { Router } from 'express';
import {
    getEpisode,
    getShow,
    getJob,
    getActiveJobForEpisode,
    getSummary,
    listSummaries,
    getTranscript,
    createJob
} from '../db.js';
import { enqueue, position, queueState } from '../queue.js';
import { jobEvents } from '../services/pipeline.js';
import { audioPathFor, removeIfExists } from '../services/audio.js';

const router = Router();

const withQueue = (job) => (job ? { ...job, queuePosition: position(job.id) } : job);

/** Start (or rejoin) a job for an episode. `backend` overrides SUMMARIZER for this run. */
router.post('/jobs', (req, res) => {
    const episodeId = Number(req.body?.episodeId);
    const episode = getEpisode(episodeId);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });

    const backend = req.body?.backend ?? null;
    if (backend && !['claude', 'local'].includes(backend)) {
        return res.status(400).json({ error: 'backend must be "claude" or "local"' });
    }

    // Don't queue a second run for an episode already in flight.
    const active = getActiveJobForEpisode(episodeId);
    if (active) return res.json({ job: withQueue(active), reused: true });

    const job = createJob(episodeId, backend);
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

router.get('/episodes/:id/summary', (req, res) => {
    const episodeId = Number(req.params.id);
    const episode = getEpisode(episodeId);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });

    const summary = getSummary(episodeId);
    if (!summary) return res.status(404).json({ error: 'No summary yet for this episode' });

    const transcript = getTranscript(episodeId);
    res.json({
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
    });
});

/** Every summary generated for this episode — lets the UI compare backends side by side. */
router.get('/episodes/:id/summaries', (req, res) => {
    const episodeId = Number(req.params.id);
    if (!getEpisode(episodeId)) return res.status(404).json({ error: 'Episode not found' });
    res.json({
        summaries: listSummaries(episodeId).map((s) => ({
            ...s,
            data: JSON.parse(s.json),
            json: undefined
        }))
    });
});

router.get('/episodes/:id/transcript', (req, res) => {
    const transcript = getTranscript(Number(req.params.id));
    if (!transcript) return res.status(404).json({ error: 'No transcript for this episode' });
    res.type('text/plain').send(transcript.text);
});

/** Drop cached media for an episode; the transcript and summary are kept. */
router.delete('/episodes/:id/audio', (req, res) => {
    const episodeId = Number(req.params.id);
    if (!getEpisode(episodeId)) return res.status(404).json({ error: 'Episode not found' });
    removeIfExists(audioPathFor(episodeId, 'mp3'), audioPathFor(episodeId, 'wav'));
    res.json({ ok: true });
});

export default router;
