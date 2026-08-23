/**
 * Shared contract between the Claude and local backends: identical output shape
 * and identical instructions, so summaries stay comparable across backends.
 */

export const SUMMARY_SCHEMA = {
    type: 'object',
    properties: {
        language: {
            type: 'string',
            description: 'ISO 639-1 code of the language used for this summary, matching the episode.'
        },
        title: { type: 'string', description: 'A short descriptive title for the episode content.' },
        tldr: { type: 'string', description: 'Two to four sentences capturing the whole episode.' },
        chapters: {
            type: 'array',
            description: 'Sequential thematic sections, in order, covering the whole episode.',
            items: {
                type: 'object',
                properties: {
                    start: { type: 'string', description: 'Timestamp from the transcript, e.g. "12:34" or "1:04:20".' },
                    title: { type: 'string' },
                    summary: { type: 'string', description: 'Two to four sentences on this section.' }
                },
                required: ['start', 'title', 'summary'],
                additionalProperties: false
            }
        },
        key_points: {
            type: 'array',
            description: 'The substantive claims, findings or arguments made.',
            items: { type: 'string' }
        },
        quotes: {
            type: 'array',
            description: 'Verbatim quotes worth remembering. Empty array if none stand out.',
            items: {
                type: 'object',
                properties: {
                    timestamp: { type: 'string' },
                    speaker: { type: 'string', description: 'Name if identifiable, otherwise "Unknown".' },
                    text: { type: 'string' }
                },
                required: ['timestamp', 'speaker', 'text'],
                additionalProperties: false
            }
        },
        people_and_terms: {
            type: 'array',
            description: 'People, places, works or jargon a listener might want explained.',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    note: { type: 'string', description: 'One line of context.' }
                },
                required: ['name', 'note'],
                additionalProperties: false
            }
        }
    },
    required: ['language', 'title', 'tldr', 'chapters', 'key_points', 'quotes', 'people_and_terms'],
    additionalProperties: false
};

export const SYSTEM_PROMPT = `You summarize podcast episodes from their transcripts.

Write the entire summary in the language spoken in the episode. If the transcript is in
French, every field you produce must be in French — do not translate to English.

The transcript is machine-generated and may contain transcription errors, misspelled proper
nouns, and no speaker labels. Infer meaning from context; do not remark on the transcript's
quality or flag that it is automated.

Timestamps in the transcript appear as [m:ss] or [h:mm:ss] markers at the start of a
paragraph. When you cite a timestamp, use one that actually appears in the transcript —
never invent or interpolate one. If a transcript has no timestamp markers at all, use "0:00".

Aim for 4-10 chapters depending on episode length, and cover the whole episode rather than
front-loading the beginning. Be concrete: name the specific claims, numbers, places and
arguments rather than describing that a discussion took place.`;

/** Used by the local backend's map step when a transcript exceeds the context window. */
export const CHUNK_NOTES_PROMPT = `You are taking notes on one segment of a longer podcast transcript.

Write dense, factual notes in the language spoken in the transcript. Keep the [m:ss]
timestamp markers next to the points they refer to, using only timestamps that actually
appear in this segment.

Capture: the topics discussed, specific claims and numbers, named people, places and works,
and any quotable lines. Do not write an introduction or conclusion, and do not mention that
this is a segment. Output plain text notes only.`;

export function buildUserContent(transcriptText, { episodeTitle, showTitle } = {}) {
    const header = [
        showTitle ? `Podcast: ${showTitle}` : null,
        episodeTitle ? `Episode: ${episodeTitle}` : null
    ]
        .filter(Boolean)
        .join('\n');
    return `${header}\n\nTranscript:\n\n${transcriptText}`.trim();
}
