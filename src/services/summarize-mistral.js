import { config } from '../config.js';
import {
    DEFAULT_SUMMARY_LEVEL,
    buildSummarySchema,
    buildSystemPrompt,
    buildUserContent
} from './summary-schema.js';

export const MODEL = config.mistral.model;

const API_URL = 'https://api.mistral.ai/v1/chat/completions';

/**
 * Summarize in a single pass via the hosted Mistral API. Mistral Large's 128k context
 * comfortably covers even long episodes, so — like Claude — no map-reduce is needed.
 */
export async function summarizeTranscript(
    transcriptText,
    { episodeTitle, showTitle, apiKey, level = DEFAULT_SUMMARY_LEVEL, onStatus = () => {} } = {}
) {
    onStatus('Writing the summary…');

    const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey || config.mistral.apiKey}`
        },
        body: JSON.stringify({
            model: MODEL,
            temperature: 0.15,
            max_tokens: 8000,
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
        model: result.model || MODEL,
        usage: {
            input_tokens: result.usage?.prompt_tokens ?? null,
            output_tokens: result.usage?.completion_tokens ?? null
        }
    };
}
