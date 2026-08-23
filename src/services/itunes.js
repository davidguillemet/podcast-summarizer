import { config, USER_AGENT } from '../config.js';

const SEARCH_URL = 'https://itunes.apple.com/search';

/**
 * iTunes Search API — no key, no auth, no registration.
 * Returns shows only; episode listing comes from Podcast Index or the RSS feed.
 */
export async function searchShows(term, { limit = 25 } = {}) {
    const url = new URL(SEARCH_URL);
    url.searchParams.set('media', 'podcast');
    url.searchParams.set('entity', 'podcast');
    url.searchParams.set('term', term);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('country', config.itunesCountry);

    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`iTunes search failed (${res.status})`);

    const body = await res.json();
    return (body.results || [])
        // Shows without a feed URL are useless to us — we can never fetch episodes.
        .filter((r) => r.feedUrl)
        .map((r) => ({
            source: 'itunes',
            sourceId: String(r.collectionId ?? ''),
            feedUrl: r.feedUrl,
            title: r.collectionName ?? r.trackName ?? 'Untitled',
            author: r.artistName ?? null,
            description: null, // the search endpoint does not return one
            artworkUrl: r.artworkUrl600 ?? r.artworkUrl100 ?? null,
            genres: r.genres ?? [],
            episodeCount: r.trackCount ?? null
        }));
}
