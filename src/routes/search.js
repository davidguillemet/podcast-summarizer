import { Router } from 'express';
import { searchShows } from '../services/search.js';

const router = Router();

router.get('/search', async (req, res) => {
    const term = String(req.query.q ?? '').trim();
    if (term.length < 2) {
        return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }
    res.json(await searchShows(term));
});

export default router;
