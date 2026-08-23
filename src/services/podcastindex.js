import crypto from 'node:crypto';
import { config, hasPodcastIndex, USER_AGENT } from '../config.js';

const BASE = 'https://api.podcastindex.org/api/1.0';

/**
 * Podcast Index signs every request with sha1(key + secret + unixSeconds).
 * All four headers are mandatory — a missing User-Agent is rejected too.
 */
function authHeaders() {
    const authDate = Math.floor(Date.now() / 1000).toString();
    const hash = crypto
        .createHash('sha1')
        .update(config.podcastIndex.key + config.podcastIndex.secret + authDate)
        .digest('hex');
    return {
        'X-Auth-Key': config.podcastIndex.key,
        'X-Auth-Date': authDate,
        Authorization: hash,
        'User-Agent': USER_AGENT
    };
}

async function call(path, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Podcast Index ${path} failed (${res.status})`);
    return res.json();
}

export async function searchShows(term, { limit = 25 } = {}) {
    if (!hasPodcastIndex()) return [];
    const body = await call('/search/byterm', { q: term, max: limit });
    return (body.feeds || [])
        .filter((f) => f.url)
        .map((f) => ({
            source: 'podcastindex',
            sourceId: String(f.id),
            feedUrl: f.url,
            title: f.title ?? 'Untitled',
            author: f.author ?? f.ownerName ?? null,
            description: f.description ?? null,
            artworkUrl: f.artwork ?? f.image ?? null,
            genres: Object.values(f.categories ?? {}),
            episodeCount: f.episodeCount ?? null
        }));
}

/** Resolve a feed URL to a Podcast Index feed id, so we can list its episodes. */
export async function getFeedIdByUrl(feedUrl) {
    if (!hasPodcastIndex()) return null;
    try {
        const body = await call('/podcasts/byfeedurl', { url: feedUrl });
        return body.feed?.id ?? null;
    } catch {
        return null;
    }
}

/**
 * Episode listing. This is where Podcast Index earns its place: it hands back
 * enclosureUrl, duration and — crucially — any publisher transcript, so we can
 * skip transcription entirely when one exists.
 */
export async function listEpisodesByFeedUrl(feedUrl, { limit = 200 } = {}) {
    if (!hasPodcastIndex()) return null;
    const feedId = await getFeedIdByUrl(feedUrl);
    if (!feedId) return null;

    const body = await call('/episodes/byfeedid', { id: feedId, max: limit });
    const items = body.items || [];
    if (items.length === 0) return null;

    return items.map((e) => ({
        guid: e.guid || String(e.id),
        title: e.title ?? 'Untitled',
        description: stripHtml(e.description),
        publishedAt: e.datePublished ? new Date(e.datePublished * 1000).toISOString() : null,
        durationSec: e.duration || null,
        audioUrl: e.enclosureUrl ?? null,
        transcriptUrl: pickTranscript(e)
    }));
}

/** Prefer SRT/VTT over plain text or JSON — we want timestamps. */
function pickTranscript(episode) {
    const list = Array.isArray(episode.transcripts) ? episode.transcripts : [];
    const byType = (re) => list.find((t) => t.url && re.test(t.type || ''))?.url;
    return (
        byType(/srt/i) ||
        byType(/vtt/i) ||
        list.find((t) => t.url)?.url ||
        episode.transcriptUrl ||
        null
    );
}

function stripHtml(s) {
    if (!s) return null;
    return String(s)
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || null;
}
