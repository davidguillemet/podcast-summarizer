/**
 * Shared contract between the Claude, Mistral and local backends: identical output shape
 * and identical instructions (up to the level tuning below), so summaries stay comparable
 * across backends.
 */

export const SUMMARY_LEVELS = ['brief', 'standard', 'detailed'];
export const DEFAULT_SUMMARY_LEVEL = 'standard';

/**
 * The 3 levels only ever change *how much* the model writes, never the JSON shape —
 * chapters/quotes/key_points/people_and_terms exist at every level. That's what keeps a
 * "brief" Claude run and a "detailed" Mistral run structurally comparable, same as backends
 * already are.
 */
const LEVEL_TUNING = {
    brief: {
        tldr: 'One to two sentences',
        chapterSummary: 'One to two sentences',
        chaptersLine:
            'Aim for 3-6 chapters depending on episode length, covering only the major sections.',
        keyPoints:
            'The handful of most important claims, findings or arguments made — skip minor or ' +
            'supporting detail.',
        quotes:
            'At most two or three verbatim quotes, only if they are genuinely striking. Empty ' +
            'array if none stand out.'
    },
    standard: {
        tldr: 'Two to four sentences',
        chapterSummary: 'Two to four sentences',
        chaptersLine:
            'Aim for 4-10 chapters depending on episode length, and cover the whole episode ' +
            'rather than front-loading the beginning.',
        keyPoints: 'The substantive claims, findings or arguments made.',
        quotes: 'Verbatim quotes worth remembering. Empty array if none stand out.'
    },
    detailed: {
        tldr: 'Four to six sentences',
        chapterSummary: 'Four to eight sentences',
        chaptersLine:
            'Aim for 6-14 chapters depending on episode length, covering the whole episode ' +
            'thoroughly — prefer more, shorter chapters over fewer broad ones.',
        keyPoints:
            'Every substantive claim, finding or argument made, including supporting details ' +
            'and caveats.',
        quotes: 'Every verbatim quote worth remembering — be generous. Empty array if none stand out.'
    }
};

const tuningFor = (level) => LEVEL_TUNING[level] ?? LEVEL_TUNING[DEFAULT_SUMMARY_LEVEL];

export function buildSummarySchema(level) {
    const t = tuningFor(level);
    return {
        type: 'object',
        properties: {
            language: {
                type: 'string',
                description: 'ISO 639-1 code of the language used for this summary, matching the episode.'
            },
            title: { type: 'string', description: 'A short descriptive title for the episode content.' },
            tldr: { type: 'string', description: `${t.tldr} capturing the whole episode.` },
            chapters: {
                type: 'array',
                description: 'Sequential thematic sections, in order, covering the whole episode.',
                items: {
                    type: 'object',
                    properties: {
                        start: { type: 'string', description: 'Timestamp from the transcript, e.g. "12:34" or "1:04:20".' },
                        title: { type: 'string' },
                        summary: { type: 'string', description: `${t.chapterSummary} on this section.` }
                    },
                    required: ['start', 'title', 'summary'],
                    additionalProperties: false
                }
            },
            key_points: {
                type: 'array',
                description: t.keyPoints,
                items: { type: 'string' }
            },
            quotes: {
                type: 'array',
                description: t.quotes,
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
}

export function buildSystemPrompt(level) {
    const t = tuningFor(level);
    return `You summarize podcast episodes from their transcripts.

Write the entire summary in the language spoken in the episode. If the transcript is in
French, every field you produce must be in French — do not translate to English.

The transcript is machine-generated and may contain transcription errors, misspelled proper
nouns, and no speaker labels. Infer meaning from context; do not remark on the transcript's
quality or flag that it is automated.

Timestamps in the transcript appear as [m:ss] or [h:mm:ss] markers at the start of a
paragraph. When you cite a timestamp, use one that actually appears in the transcript —
never invent or interpolate one. If a transcript has no timestamp markers at all, use "0:00".

${t.chaptersLine} Be concrete: name the specific claims, numbers, places and
arguments rather than describing that a discussion took place.`;
}

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
