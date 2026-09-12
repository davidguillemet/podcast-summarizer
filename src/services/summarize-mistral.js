import { config } from '../config.js';
import {
    DEFAULT_SUMMARY_LEVEL,
    buildSummarySchema,
    buildSystemPrompt,
    buildUserContent
} from './summary-schema.js';

export const MODEL = 'mistral-large-latest';

// Same chat-completions request shape for every Mistral model, so there's no compatibility
// list to maintain here the way summarize-claude.js has to.
export const MODELS = [
    { id: 'mistral-large-latest', label: 'Mistral Large — best quality' },
    { id: 'mistral-medium-latest', label: 'Mistral Medium — balanced' },
    { id: 'mistral-small-latest', label: 'Mistral Small — faster, cheaper' },
    { id: 'ministral-8b-latest', label: 'Ministral 8B — fastest, cheapest' }
];

const API_URL = 'https://api.mistral.ai/v1/chat/completions';

// Completion length is non-deterministic — the same transcript can generate noticeably more
// or fewer tokens from one run to the next, so even an empirically-tuned per-level cap can
// still occasionally run out mid-JSON (this happened live: a cap sized from one successful
// 'detailed' run failed on a later run of a different episode). A flat, generous ceiling
// doesn't cost more — Mistral bills on tokens actually generated, not on max_tokens — and
// Mistral Large's 128k context leaves ample room even for a long transcript. Matches the
// Claude backend's ceiling for parity, though Mistral has no documented per-model output cap
// to size against the way Claude's 128K max does — this is a verified-generous estimate.
const MAX_TOKENS = 64000;

/**
 * Summarize in a single pass via the hosted Mistral API. Mistral Large's 128k context
 * comfortably covers even long episodes, so — like Claude — no map-reduce is needed.
 */
export async function summarizeTranscript(
    transcriptText,
    { episodeTitle, showTitle, apiKey, model, level = DEFAULT_SUMMARY_LEVEL, onStatus = () => {} } = {}
) {
    onStatus('Writing the summary…');

    const chosenModel = MODELS.some((m) => m.id === model) ? model : MODEL;

    const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey || config.mistral.apiKey}`
        },
        body: JSON.stringify({
            model: chosenModel,
            temperature: 0.15,
            max_tokens: MAX_TOKENS,
            response_format: {
                type: 'json_schema',
                json_schema: { name: 'summary', schema: buildSummarySchema(level), strict: true }
            },
            messages: [
                { role: 'system', content: buildSystemPrompt(level) },
                { role: 'user', content: buildUserContent(transcriptText, { episodeTitle, showTitle }) }
            ]
        }),
        signal: AbortSignal.timeout(20 * 60 * 1000)
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Mistral API request failed (${res.status}): ${detail.slice(0, 400)}`);
    }

    const result = await res.json();
    const choice = result.choices?.[0];
    if (!choice) throw new Error('Mistral API returned no choices');

    if (choice.finish_reason === 'length') {
        throw new Error('Mistral API hit the output token limit before completing the summary');
    }

    let data;
    try {
        data = JSON.parse(choice.message.content);
    } catch (err) {
        throw new Error(`Mistral API returned unparseable JSON: ${err.message}`);
    }

    return {
        data,
        refusal: null,
        backend: 'mistral',
        model: result.model || chosenModel,
        usage: {
            input_tokens: result.usage?.prompt_tokens ?? null,
            output_tokens: result.usage?.completion_tokens ?? null
        }
    };
}
