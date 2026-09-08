import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import {
    DEFAULT_SUMMARY_LEVEL,
    buildSummarySchema,
    buildSystemPrompt,
    buildUserContent
} from './summary-schema.js';

export const MODEL = 'claude-opus-5';

/**
 * Summarize in a single pass. Even a three-hour episode is ~50k tokens, well
 * inside the context window, and one pass reads better than map-reduce.
 */
export async function summarizeTranscript(
    transcriptText,
    { episodeTitle, showTitle, apiKey, level = DEFAULT_SUMMARY_LEVEL, onStatus = () => {} } = {}
) {
    onStatus('Writing the summary…');

    // A fresh client per call, since apiKey can differ per user — cheap, just config, no connection.
    const client = new Anthropic({ apiKey: apiKey || config.anthropicApiKey });
    const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 16000,
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
