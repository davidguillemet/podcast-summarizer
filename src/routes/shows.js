import { Router } from 'express';
import { resolveShowWithEpisodes } from '../services/search.js';
import { getShow, listLibrary, listBrowsableShows, upsertShow, setFavorite } from '../db.js';

const router = Router();

/** Favorited shows, plus shows with at least one transcribed episode — the Podcasts browse page. */
router.get('/shows', (_req, res) => {
    res.json({ shows: listBrowsableShows() });
});

/**
 * Toggle a show's favorite flag. Always upserts first, since this is also how a show picked
 * straight from search gets its first DB row — favoriting shouldn't require opening it.
 */
router.post('/shows/favorite', (req, res) => {
    const { feedUrl, title } = req.body ?? {};
    if (!feedUrl || !title) {
        return res.status(400).json({ error: 'feedUrl and title are required' });
    }
    const show = upsertShow(req.body);
    setFavorite(show.id, req.body.favorite !== false);
    res.json({ show: getShow(show.id) });
});

/**
 * Persist a show picked from search results and return its episodes.
 * The body is a search result (it carries feedUrl, which is our identity key).
 */
router.post('/shows', async (req, res) => {
    const { feedUrl, title } = req.body ?? {};
    if (!feedUrl || !title) {
        return res.status(400).json({ error: 'feedUrl and title are required' });
    }
    res.json(await resolveShowWithEpisodes(req.body));
});

/**
 * Delegates entirely to resolveShowWithEpisodes rather than checking the cache itself —
 * that function already correctly falls through to a fresh fetch when there's nothing
 * cached, `refresh` or not. A show can reach this route with zero episodes saved (e.g.
 * favorited straight from search, which only persists metadata) and a naive "cache unless
 * ?refresh=1" shortcut here would serve that empty cache forever instead of ever fetching.
 */
router.get('/shows/:id/episodes', async (req, res) => {
    const show = getShow(Number(req.params.id));
    if (!show) return res.status(404).json({ error: 'Show not found' });

    res.json(
        await resolveShowWithEpisodes(
            {
                source: show.source,
                sourceId: show.source_id,
                feedUrl: show.feed_url,
                title: show.title,
                author: show.author,
                description: show.description,
                artworkUrl: show.artwork_url
            },
            { refresh: req.query.refresh === '1' }
        )
    );
});

router.get('/library', (_req, res) => {
    res.json({ items: listLibrary() });
});

export default router;
