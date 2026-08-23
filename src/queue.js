import { runJob, jobEvents } from './services/pipeline.js';
import { updateJob, getJob } from './db.js';

/**
 * Serial FIFO worker. Whisper saturates the GPU, so running two transcriptions
 * concurrently makes both slower without finishing anything sooner.
 */
const pending = [];
let running = null;

export function enqueue(jobId) {
    if (running === jobId || pending.includes(jobId)) return position(jobId);
    pending.push(jobId);
    const job = updateJob(jobId, { status: 'queued', stage: 'queued', progress: 0 });
    jobEvents.emit('update', job);
    drain();
    return position(jobId);
}

export function position(jobId) {
    if (running === jobId) return 0;
    const index = pending.indexOf(jobId);
    return index === -1 ? null : index + 1;
}

export const queueState = () => ({ running, pending: [...pending] });

async function drain() {
    if (running !== null) return;
    const next = pending.shift();
    if (next === undefined) return;

    running = next;
    try {
        await runJob(next);
    } catch (err) {
        // runJob handles its own failures; this is a last-resort guard so one
        // unexpected throw can never wedge the queue permanently.
        const job = updateJob(next, {
            status: 'failed',
            stage: 'failed',
            error: `Unhandled worker error: ${err.message}`,
            finished_at: new Date().toISOString()
        });
        jobEvents.emit('update', job);
    } finally {
        running = null;
        if (pending.length > 0) setImmediate(drain);
    }
}

/** Re-enqueue anything left queued (not mid-run) after a restart. */
export function resumeQueued(jobIds) {
    for (const id of jobIds) {
        if (getJob(id)) enqueue(id);
    }
}
