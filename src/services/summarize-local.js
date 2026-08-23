import { config } from '../config.js';
import { ensureRunning, chat, countTokens, effectiveContext } from './llamaServer.js';
import {
    SUMMARY_SCHEMA,
    SYSTEM_PROMPT,
    CHUNK_NOTES_PROMPT,
    buildUserContent
} from './summary-schema.js';

const OUTPUT_RESERVE = 4096; // room for the JSON summary
const NOTES_RESERVE = 1600; // room for one chunk's notes

/**
 * Split on the [m:ss] paragraph boundaries produced by buildTimestampedTranscript,
 * so a chunk never starts mid-sentence and every chunk keeps real timestamps.
 */
function chunkByCharBudget(text, charBudget) {
    const lines = text.split('\n');
    const chunks = [];
    let current = [];
    let size = 0;

    for (const line of lines) {
        if (size + line.length > charBudget && current.length > 0) {
            chunks.push(current.join('\n'));
            current = [];
            size = 0;
        }
        current.push(line);
        size += line.length + 1;
    }
    if (current.length > 0) chunks.push(current.join('\n'));
    return chunks;
}

/**
 * Summarize locally with Mistral Small via llama.cpp.
 *
 * Short transcripts go through in one pass. Longer ones are mapped to per-segment
 * notes and then reduced — which also happens to fix the failure mode small models
 * have on long inputs, where they cover the opening thoroughly and skim the rest.
 */
export async function summarizeTranscript(transcriptText, { episodeTitle, showTitle, onStatus = () => {} } = {}) {
    await ensureRunning({ onStatus });

    const userContent = buildUserContent(transcriptText, { episodeTitle, showTitle });
    const totalTokens = await countTokens(userContent);
    // Size against the running server, which may differ from config if we adopted an orphan.
    const budget = effectiveContext() - OUTPUT_RESERVE - 600;

    let finalInput = userContent;
    let strategy = 'single-pass';
    let mapCalls = 0;

    console.log(
        `[summarize-local] transcript=${totalTokens} tokens, budget=${budget} ` +
            `(n_ctx=${effectiveContext()}) -> ${totalTokens > budget ? 'map-reduce' : 'single-pass'}`
    );

    if (totalTokens > budget) {
        strategy = 'map-reduce';
        // Derive the real chars-per-token ratio from the measurement we already
        // have, rather than guessing (it varies a lot between French and English).
        const charsPerToken = userContent.length / Math.max(1, totalTokens);
        const chunkCharBudget = Math.floor((budget - NOTES_RESERVE) * charsPerToken * 0.9);
        const chunks = chunkByCharBudget(transcriptText, chunkCharBudget);
        mapCalls = chunks.length;

        const notes = [];
        for (const [index, chunk] of chunks.entries()) {
            onStatus(`Reading segment ${index + 1} of ${chunks.length}…`);
            const { text } = await chat({
                system: CHUNK_NOTES_PROMPT,
                user: `Segment ${index + 1} of ${chunks.length}.\n\n${chunk}`,
                maxTokens: NOTES_RESERVE
            });
            notes.push(`--- Segment ${index + 1} of ${chunks.length} ---\n${text.trim()}`);
        }

        finalInput = buildUserContent(
            `The following are ordered notes taken across the whole episode.\n\n${notes.join('\n\n')}`,
            { episodeTitle, showTitle }
        );
    }

    onStatus('Writing the summary…');
    const { text, finishReason, usage } = await chat({
        system: SYSTEM_PROMPT,
        user: finalInput,
        schema: SUMMARY_SCHEMA,
        maxTokens: OUTPUT_RESERVE
    });

    if (finishReason === 'length') {
        throw new Error('Local model hit the output limit before completing the summary');
    }

    let data;
    try {
        data = JSON.parse(text);
    } catch (err) {
        // The grammar makes this near-impossible, so surface it loudly if it happens.
        throw new Error(`Local model returned unparseable JSON: ${err.message}`);
    }

    return {
        data,
        refusal: null,
        backend: 'local',
        model: config.local.modelFile.replace(/\.gguf$/i, ''),
        usage: {
            input_tokens: usage?.prompt_tokens ?? totalTokens,
            output_tokens: usage?.completion_tokens ?? null
        },
        meta: { strategy, mapCalls, transcriptTokens: totalTokens }
    };
}
