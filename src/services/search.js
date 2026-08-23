import { hasPodcastIndex } from '../config.js';
import * as itunes from './itunes.js';
import * as podcastIndex from './podcastindex.js';
import { fetchFeed } from './feed.js';
import { upsertShow, upsertEpisodes, listEpisodes } from '../db.js';

/** Feed URLs vary by trailing slash / scheme / case; normalize before merging. */
function feedKey(url) {
    try {
        const u = new URL(url);
        return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
    } catch {
        return String(url).toLowerCase();
    }
}

/**
 * Query iTunes and Podcast Index in parallel and merge on feed URL, so a show
 * found by both appears once carrying both source badges. Neither provider is
 * allowed to break the other: a failure degrades to the surviving source.
 */
export async function searchShows(term) {
    const [itunesRes, piRes] = await Promise.allSettled([
        itunes.searchShows(term),
        podcastIndex.searchShows(term)
    ]);

    const errors = [];
    if (itunesRes.status === 'rejected') errors.push(`iTunes: ${itunesRes.reason.message}`);
    if (piRes.status === 'rejected') errors.push(`Podcast Index: ${piRes.reason.message}`);

    const merged = new Map();
    const add = (show) => {
        const key = feedKey(show.feedUrl);
        const existing = merged.get(key);
        if (!existing) {
            merged.set(key, { ...show, sources: [show.source] });
            return;
        }
        existing.sources.push(show.source);
        // Fill gaps from the second source — iTunes has no description, PI often lacks nothing.
        existing.description ??= show.description;
        existing.artworkUrl ??= show.artworkUrl;
        existing.author ??= show.author;
        existing.episodeCount ??= show.episodeCount;
        if (existing.genres?.length === 0) existing.genres = show.genres;
    };

    // iTunes first so its artwork (600px) wins over Podcast Index thumbnails.
    if (itunesRes.status === 'fulfilled') itunesRes.value.forEach(add);
    if (piRes.status === 'fulfilled') piRes.value.forEach(add);

    return {
        results: [...merged.values()],
        errors,
        podcastIndexEnabled: hasPodcastIndex()
    };
}

/**
 * Persist a show and return it with its episodes, fetching them if we have none
 * cached. Podcast Index is preferred (it exposes transcript URLs directly);
 * the RSS feed is the fallback.
 */
export async function resolveShowWithEpisodes(showInput, { refresh = false } = {}) {
    let show = upsertShow(showInput);
    let episodes = listEpisodes(show.id);

    if (episodes.length > 0 && !refresh) {
        return { show, episodes, episodeSource: 'cache' };
    }

    let fetched = null;
    let episodeSource = null;

    try {
        fetched = await podcastIndex.listEpisodesByFeedUrl(show.feed_url);
        if (fetched) episodeSource = 'podcastindex';
    } catch {
        fetched = null;
    }

    if (!fetched) {
        const feed = await fetchFeed(show.feed_url);
        fetched = feed.episodes;
        episodeSource = 'rss';
        // The feed is authoritative for show metadata that search results lack.
        show = upsertShow({
            source: showInput.source,
            sourceId: showInput.sourceId ?? show.source_id,
            feedUrl: show.feed_url,
            title: show.title || feed.show.title,
            author: show.author || feed.show.author,
            description: show.description || feed.show.description,
            artworkUrl: show.artwork_url || feed.show.artworkUrl
        });
    }

    const usable = fetched.filter((e) => e.audioUrl || e.transcriptUrl);
    upsertEpisodes(show.id, usable);

    return { show, episodes: listEpisodes(show.id), episodeSource };
}
