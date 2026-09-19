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
    setSummaryPreferred,
    setSummaryReadChapters,
    setEpisodeStatus,
    getEpisodeStatus,
    getTranscript,
    removeFromLibrary,
    createJob,
    getUserById
} from '../db.js';
import { enqueue, position, queueState } from '../queue.js';
import { jobEvents, resolveApiKey } from '../services/pipeline.js';
import { audioPathFor, removeIfExists } from '../services/audio.js';
import { SUMMARY_LEVELS, DEFAULT_SUMMARY_LEVEL } from '../services/summary-schema.js';
import { CLAUDE_MODELS, MISTRAL_MODELS } from '../services/summarize.js';
import { config } from '../config.js';

const router = Router();

const withQueue = (job) => (job ? { ...job, queuePosition: position(job.id) } : job);

/** Loads a summary by id and 404s (never 403 — don't confirm another user's summary exists)
 *  if it doesn't belong to the requesting session. Every route that mutates or reveals a
 *  specific summary by its (guessable, sequential) id must go through this. */
function requireOwnedSummary(req, res) {
    const summary = getSummaryById(Number(req.params.id));
    if (!summary || summary.user_id !== req.session.user_id) {
        res.status(404).json({ error: 'Summary not found' });
        return null;
    }
    return summary;
}

/**
 * Start (or rejoin) a job for an episode. `backend` overrides SUMMARIZER for this run;
 * `level` overrides the user's account default detail level for this run only — the
 * resolved value (never null) is stored on the job so history/comparison can show it.
 * `model` similarly overrides the user's account default model for this run only (claude/
 * mistral only — 'local' has no model concept, so it's silently dropped for that backend).
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

    // Per-run model override — 'local' has no model concept, so it's only checked for claude/mistral.
    const resolvedBackend = backend || config.summarizer;
    const requestedModel = req.body?.model ?? null;
    const MODELS_BY_BACKEND = { claude: CLAUDE_MODELS, mistral: MISTRAL_MODELS };
    if (requestedModel && MODELS_BY_BACKEND[resolvedBackend]) {
        const models = MODELS_BY_BACKEND[resolvedBackend];
        if (!models.some((m) => m.id === requestedModel)) {
            return res.status(400).json({ error: `model must be one of: ${models.map((m) => m.id).join(', ')}` });
        }
    }
    const model = MODELS_BY_BACKEND[resolvedBackend] ? requestedModel : null;

    // Fail before transcribing, not after — a doomed job would otherwise burn minutes of
    // whisper time only to hit the same check again at the summarize step.
    try {
        resolveApiKey(req.session.user_id, resolvedBackend);
    } catch (err) {
        return res.status(403).json({ error: err.message });
    }

    // Don't queue a second run for an episode this same user already has in flight — scoped to
    // the requester, not global, since two different users must never end up sharing a summary.
    const active = getActiveJobForEpisode(episodeId, req.session.user_id);
    if (active) return res.json({ job: withQueue(active), reused: true });

    const job = createJob(episodeId, backend, req.session.user_id, level, model);
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

/** Shared response shape for both the "latest" and "one specific run" summary views.
 *  Reading status is looked up by `summary.user_id`, not the session, since it's read-only
 *  context here — the summary itself was already fetched/authorized as belonging to the
 *  requesting user by the caller. */
function summaryDetail(episode, summary) {
    const transcript = getTranscript(episode.id);
    return {
        episode,
        show: getShow(episode.show_id),
        summary: {
            ...summary,
            data: JSON.parse(summary.json),
            json: undefined,
            readChapters: JSON.parse(summary.read_chapters || '[]'),
            read_chapters: undefined
        },
        readingStatus: getEpisodeStatus(summary.user_id, episode.id),
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

    const summary = getSummary(episodeId, req.session.user_id);
    if (!summary) return res.status(404).json({ error: 'No summary yet for this episode' });

    res.json(summaryDetail(episode, summary));
});

/** One specific summary run, addressed by its own id — used by the history view. */
router.get('/summaries/:id', (req, res) => {
    const summary = requireOwnedSummary(req, res);
    if (!summary) return;
    res.json(summaryDetail(getEpisode(summary.episode_id), summary));
});

/** Every summary this user has generated for this episode — lets the UI compare backends and
 *  past runs (their own runs only; summaries aren't shared across users). */
router.get('/episodes/:id/summaries', (req, res) => {
    const episodeId = Number(req.params.id);
    const episode = getEpisode(episodeId);
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    res.json({
        episode,
        show: getShow(episode.show_id),
        summaries: listSummaries(episodeId, req.session.user_id).map((s) => ({
            ...s,
            data: JSON.parse(s.json),
            json: undefined,
            readChapters: JSON.parse(s.read_chapters || '[]'),
            read_chapters: undefined
        }))
    });
});

/** Delete one summary run. The transcript is untouched, so re-summarizing stays cheap. */
router.delete('/summaries/:id', (req, res) => {
    const summary = requireOwnedSummary(req, res);
    if (!summary) return;
    deleteSummary(summary.id, req.session.user_id);
    res.json({ ok: true, episodeId: summary.episode_id });
});

/** Marks/unmarks a summary as this user's default view for the episode. Only one can be
 *  preferred per (episode, user) — setting one clears any other preferred summary of theirs
 *  for that episode. */
router.put('/summaries/:id/preferred', (req, res) => {
    const summary = requireOwnedSummary(req, res);
    if (!summary) return;
    const updated = setSummaryPreferred(summary.id, req.body.preferred !== false);
    res.json({
        ok: true,
        summary: {
            ...updated,
            data: JSON.parse(updated.json),
            json: undefined,
            readChapters: JSON.parse(updated.read_chapters || '[]'),
            read_chapters: undefined
        }
    });
});

/** Replaces the set of chapter indices marked read for a summary — persisted server-side
 *  (like `preferred`) so it survives across devices/browsers, not just this one. */
router.put('/summaries/:id/read-chapters', (req, res) => {
    const summary = requireOwnedSummary(req, res);
    if (!summary) return;
    const indices = Array.isArray(req.body.readChapters) ? req.body.readChapters.filter(Number.isInteger) : [];
    const updated = setSummaryReadChapters(summary.id, indices);
    res.json({
        ok: true,
        summary: {
            ...updated,
            data: JSON.parse(updated.json),
            json: undefined,
            readChapters: JSON.parse(updated.read_chapters || '[]'),
            read_chapters: undefined
        }
    });
});

/** Sets (or clears, with status 'not_started') this user's reading progress for an episode —
 *  independent of which of their summary runs is preferred. */
router.put('/episodes/:id/status', (req, res) => {
    const episode = getEpisode(Number(req.params.id));
    if (!episode) return res.status(404).json({ error: 'Episode not found' });
    const { status } = req.body ?? {};
    if (!['not_started', 'to_read', 'pending', 'read'].includes(status)) {
        return res.status(400).json({ error: 'status must be not_started, to_read, pending or read' });
    }
    setEpisodeStatus(req.session.user_id, episode.id, status);
    res.json({ ok: true, episodeId: episode.id, status });
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

/** Remove this episode from the requesting user's library: deletes their own summary and
 *  reading status. The shared transcript is only dropped once nobody else has a summary for
 *  it and no job (any user's) is still in flight — see removeFromLibrary() in db.js. */
router.delete('/episodes/:id/transcript', (req, res) => {
    const episodeId = Number(req.params.id);
    if (!getEpisode(episodeId)) return res.status(404).json({ error: 'Episode not found' });
    const { transcriptDeleted } = removeFromLibrary(req.session.user_id, episodeId);
    res.json({ ok: true, transcriptDeleted });
});

/** Drop cached media for an episode; the transcript and summary are kept. */
router.delete('/episodes/:id/audio', (req, res) => {
    const episodeId = Number(req.params.id);
    if (!getEpisode(episodeId)) return res.status(404).json({ error: 'Episode not found' });
    removeIfExists(audioPathFor(episodeId, 'mp3'), audioPathFor(episodeId, 'wav'));
    res.json({ ok: true });
});

export default router;
