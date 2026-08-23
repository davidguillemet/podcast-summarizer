import { config } from '../config.js';
import * as claude from './summarize-claude.js';
import * as local from './summarize-local.js';

/**
 * Backend dispatcher. Both implementations share `summary-schema.js`, so their
 * output is directly comparable — re-summarizing a cached transcript with the
 * other backend costs one model call and no re-transcription.
 */
const backends = { claude, local };

export const resolveBackend = (name) => backends[name] ?? backends.claude;

export function summarizeTranscript(transcriptText, options = {}) {
    const name = options.backend || config.summarizer;
    return resolveBackend(name).summarizeTranscript(transcriptText, options);
}

/** Rough cost estimate for the Claude backend. Opus 5: $5/$25 per MTok. Local is free. */
export function estimateCost(usage, backend = config.summarizer) {
    if (backend === 'local' || !usage) return 0;
    const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    const output = usage.output_tokens ?? 0;
    return Number(((input * 5) / 1e6 + (output * 25) / 1e6).toFixed(4));
}

export const CLAUDE_MODEL = claude.MODEL;
