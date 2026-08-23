import { XMLParser } from 'fast-xml-parser';
import { USER_AGENT } from '../config.js';

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true
});

const toArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Elements may be a bare string or `{ '#text': ... }` depending on attributes. */
const text = (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'object') return v['#text'] !== undefined ? String(v['#text']).trim() : null;
    return String(v).trim();
};

function stripHtml(s) {
    if (!s) return null;
    return String(s)
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || null;
}

/** iTunes duration is either seconds ("3723") or clock form ("1:02:03" / "02:03"). */
export function parseDuration(raw) {
    const s = text(raw);
    if (!s) return null;
    if (/^\d+$/.test(s)) return Number(s);
    const parts = s.split(':').map(Number);
    if (parts.some(Number.isNaN)) return null;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** Pick a transcript URL from Podcasting 2.0 `<podcast:transcript>`, preferring timestamped formats. */
function pickTranscript(item) {
    const entries = toArray(item['podcast:transcript']).filter(Boolean);
    if (entries.length === 0) return null;
    const byType = (re) => entries.find((t) => t['@_url'] && re.test(t['@_type'] || ''))?.['@_url'];
    return byType(/srt/i) || byType(/vtt/i) || entries.find((t) => t['@_url'])?.['@_url'] || null;
}

/**
 * Fetch and parse an RSS feed. This is the fallback used whenever Podcast Index
 * doesn't know a feed (or no API key is configured).
 */
export async function fetchFeed(feedUrl) {
    const res = await fetch(feedUrl, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
        redirect: 'follow'
    });
    if (!res.ok) throw new Error(`Feed fetch failed (${res.status}) for ${feedUrl}`);

    const xml = await res.text();
    const doc = parser.parse(xml);
    const channel = doc?.rss?.channel ?? doc?.feed ?? null;
    if (!channel) throw new Error('Feed is not valid RSS');

    const show = {
        title: text(channel.title) ?? 'Untitled',
        author: text(channel['itunes:author']) ?? text(channel.managingEditor) ?? null,
        description: stripHtml(text(channel.description) ?? text(channel['itunes:summary'])),
        artworkUrl:
            channel['itunes:image']?.['@_href'] ??
            text(channel.image?.url) ??
            null
    };

    const episodes = toArray(channel.item).map((item, index) => {
        const enclosure = toArray(item.enclosure)[0];
        const guid = text(item.guid) || enclosure?.['@_url'] || `${feedUrl}#${index}`;
        const pubDate = text(item.pubDate);
        const parsedDate = pubDate ? new Date(pubDate) : null;

        return {
            guid,
            title: text(item.title) ?? 'Untitled',
            description: stripHtml(text(item.description) ?? text(item['itunes:summary'])),
            publishedAt:
                parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
            durationSec: parseDuration(item['itunes:duration']),
            audioUrl: enclosure?.['@_url'] ?? null,
            transcriptUrl: pickTranscript(item)
        };
    });

    return { show, episodes };
}
