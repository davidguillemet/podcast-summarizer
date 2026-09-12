import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import {
    DEFAULT_SUMMARY_LEVEL,
    buildSummarySchema,
    buildSystemPrompt,
    buildUserContent
} from './summary-schema.js';

export const MODEL = 'claude-opus-5';

// Both models share the same request shape (adaptive thinking, `output_config.effort`,
// JSON-schema structured output) — that's the criterion for this list, not just "recent".
// Claude Haiku 4.5 is deliberately excluded: it's on the older enabled/budget_tokens
// thinking API and doesn't support `effort`, so it would need a different request shape.
export const MODELS = [
    { id: 'claude-opus-5', label: 'Claude Opus 5 — best quality' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — faster, cheaper' }
];

// With adaptive thinking, max_tokens is a hard ceiling on thinking + final text combined,
// and thinking length is non-deterministic — the same transcript can make the model think
// a very different amount from one run to the next. A budget tuned per level (even a
// generous one) can still get unlucky and truncate before any final text is written. A flat,
// generous ceiling doesn't cost more (billed on tokens actually generated, not on this
// number) and this is a streaming request, so there's no timeout pressure to keep it tight.
const MAX_TOKENS = 64000;

/**
 * Summarize in a single pass. Even a three-hour episode is ~50k tokens, well
 * inside the context window, and one pass reads better than map-reduce.
 */
export async function summarizeTranscript(
    transcriptText,
    { episodeTitle, showTitle, apiKey, model, level = DEFAULT_SUMMARY_LEVEL, onStatus = () => {} } = {}
) {
    onStatus('Writing the summary…');

    const chosenModel = MODELS.some((m) => m.id === model) ? model : MODEL;

    // A fresh client per call, since apiKey can differ per user — cheap, just config, no connection.
    const client = new Anthropic({ apiKey: apiKey || config.anthropicApiKey });
    const stream = client.beta.messages.stream({
        model: chosenModel,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        // Opus 5's safety classifiers can decline a request outright (HTTP 200 with
        // stop_reason "refusal"). Benign true-crime / infosec / medical episodes
        // occasionally trip them, so let the API retry on a fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
            effort: 'medium',
            format: { type: 'json_schema', schema: buildSummarySchema(level) }
        },
        system: buildSystemPrompt(level),
        messages: [{ role: 'user', content: buildUserContent(transcriptText, { episodeTitle, showTitle }) }]
    });

    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
        return {
            data: null,
            refusal: message.stop_details?.explanation || 'The model declined to summarize this episode.',
            backend: 'claude',
            model: message.model,
            usage: message.usage
        };
    }

    if (message.stop_reason === 'max_tokens') {
        throw new Error('Claude hit the output token limit before completing the summary');
    }

    const textBlock = message.content.find((b) => b.type === 'text');
    if (!textBlock) throw new Error('Model returned no text content');

    let data;
    try {
        data = JSON.parse(textBlock.text);
    } catch (err) {
        throw new Error(`Model returned unparseable JSON: ${err.message}`);
    }

    return { data, refusal: null, backend: 'claude', model: message.model, usage: message.usage };
}
