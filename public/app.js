const app = document.getElementById('app');
const statusLine = document.getElementById('status-line');

/* ------------------------------------------------------------- utilities */

const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

async function api(path, options) {
    const res = await fetch(`/api${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
}

function formatDuration(sec) {
    if (!sec) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

const STAGES = ['downloading', 'converting', 'transcribing', 'summarizing', 'done'];
const STAGE_LABEL = {
    queued: 'Queued',
    downloading: 'Downloading audio',
    converting: 'Converting audio',
    transcribing: 'Transcribing (on-device)',
    summarizing: 'Summarizing',
    done: 'Done',
    failed: 'Failed'
};

/** Keep the search term across navigation so Back to results still shows them. */
const session = {
    term: '',
    results: null,
    status: null,
    backend: null,
    favoriteFeedUrls: new Set(),
    podcastsFilter: { favorites: true, transcribed: true }
};
let activeStream = null;

const BACKEND_LABEL = { claude: 'Claude', local: 'Mistral (local)' };

/** Feed URLs vary by trailing slash / case; normalize before comparing search results to DB rows. */
const normalizeFeedUrl = (url) => String(url || '').trim().toLowerCase().replace(/\/+$/, '');

/** Upserts show metadata and sets its favorite flag — works whether the show is in the DB yet or not. */
function postFavorite(feedUrl, meta, favorite) {
    return api('/shows/favorite', { method: 'POST', body: JSON.stringify({ feedUrl, ...meta, favorite }) });
}

/** Which backend new jobs should use — defaults to the server's SUMMARIZER setting. */
const currentBackend = () => session.backend || session.status?.summarizer || 'claude';

function backendPicker() {
    const available = session.status?.backends ?? {};
    const options = ['claude', 'local'].filter((b) => available[b]);
    if (options.length < 2) return '';
    return `
        <label class="small muted" style="display:flex;align-items:center;gap:6px">
            Summarize with
            <select id="backend-picker">
                ${options
                    .map(
                        (b) =>
                            `<option value="${b}" ${b === currentBackend() ? 'selected' : ''}>${esc(BACKEND_LABEL[b])}</option>`
                    )
                    .join('')}
            </select>
        </label>`;
}

function wireBackendPicker() {
    document.getElementById('backend-picker')?.addEventListener('change', (e) => {
        session.backend = e.target.value;
    });
}

function closeStream() {
    if (activeStream) {
        activeStream.close();
        activeStream = null;
    }
}

/* ----------------------------------------------------------------- views */

async function viewSearch() {
    app.innerHTML = `
        <h1>Find a podcast</h1>
        <p class="muted small">Searches iTunes and Podcast Index, then transcribes on-device.</p>
        <form class="searchbar" id="search-form">
            <input id="q" placeholder="Search podcasts…" value="${esc(session.term)}" autocomplete="off" autofocus />
            <button class="primary" type="submit">Search</button>
        </form>
        <div id="results"></div>
    `;

    const form = document.getElementById('search-form');
    const results = document.getElementById('results');

    const run = async (term) => {
        session.term = term;
        results.innerHTML = '<div class="loading">Searching…</div>';
        try {
            const data = await api(`/search?q=${encodeURIComponent(term)}`);
            session.results = data;
            renderResults(results, data);
        } catch (err) {
            results.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
        }
    };

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const term = document.getElementById('q').value.trim();
        if (term.length >= 2) run(term);
    });

    if (session.results) renderResults(results, session.results);
}

function renderResults(container, data) {
    const notices = [];
    if (!data.podcastIndexEnabled) {
        notices.push(
            `<div class="notice">Searching iTunes only. Add <code>PODCASTINDEX_KEY</code> and
             <code>PODCASTINDEX_SECRET</code> to <code>.env</code> to also search Podcast Index
             and pick up free publisher transcripts.</div>`
        );
    }
    for (const err of data.errors ?? []) {
        notices.push(`<div class="notice warn">${esc(err)}</div>`);
    }

    if (data.results.length === 0) {
        container.innerHTML = notices.join('') + '<div class="notice">No podcasts found.</div>';
        return;
    }

    container.innerHTML =
        notices.join('') +
        `<div class="cards">${data.results
            .map((r, i) => {
                const isFav = session.favoriteFeedUrls.has(normalizeFeedUrl(r.feedUrl));
                return `
        <div class="card" data-index="${i}">
            <img class="art" src="${esc(r.artworkUrl || '')}" alt="" onerror="this.style.visibility='hidden'" />
            <div class="card-body">
                <div class="card-title">${esc(r.title)}</div>
                <div class="card-sub">${esc(r.author || 'Unknown')}${
                    r.episodeCount ? ` · ${r.episodeCount} episodes` : ''
                }</div>
                ${r.description ? `<div class="card-desc">${esc(r.description)}</div>` : ''}
                <div class="badges">
                    ${r.sources.map((s) => `<span class="badge">${esc(s)}</span>`).join('')}
                    ${(r.genres ?? []).slice(0, 2).map((g) => `<span class="badge neutral">${esc(g)}</span>`).join('')}
                </div>
            </div>
            <button class="fav-btn ${isFav ? 'active' : ''}" style="align-self:center" data-action="favorite" data-index="${i}"
                    title="${isFav ? 'Remove from favorites' : 'Add to favorites'}">${isFav ? '★' : '☆'}</button>
        </div>`;
            })
            .join('')}</div>`;

    container.querySelectorAll('.card').forEach((el) => {
        el.addEventListener('click', async () => {
            const show = data.results[Number(el.dataset.index)];
            el.style.opacity = '0.6';
            el.querySelector('.card-title').textContent = `${show.title} — loading episodes…`;
            try {
                const res = await api('/shows', { method: 'POST', body: JSON.stringify(show) });
                location.hash = `#/show/${res.show.id}`;
            } catch (err) {
                container.insertAdjacentHTML('afterbegin', `<div class="notice error">${esc(err.message)}</div>`);
                el.style.opacity = '';
                el.querySelector('.card-title').textContent = show.title;
            }
        });
    });

    container.querySelectorAll('[data-action="favorite"]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const show = data.results[Number(btn.dataset.index)];
            const key = normalizeFeedUrl(show.feedUrl);
            const nowFavorite = !session.favoriteFeedUrls.has(key);
            btn.disabled = true;
            try {
                await postFavorite(
                    show.feedUrl,
                    {
                        title: show.title,
                        author: show.author,
                        description: show.description,
                        artworkUrl: show.artworkUrl,
                        source: show.source,
                        sourceId: show.sourceId
                    },
                    nowFavorite
                );
                if (nowFavorite) session.favoriteFeedUrls.add(key);
                else session.favoriteFeedUrls.delete(key);
                btn.textContent = nowFavorite ? '★' : '☆';
                btn.classList.toggle('active', nowFavorite);
                btn.title = nowFavorite ? 'Remove from favorites' : 'Add to favorites';
            } catch (err) {
                container.insertAdjacentHTML('afterbegin', `<div class="notice error">${esc(err.message)}</div>`);
            }
            btn.disabled = false;
        });
    });
}

async function viewShow(showId) {
    app.innerHTML = '<div class="loading">Loading episodes…</div>';
    let data;
    try {
        data = await api(`/shows/${showId}/episodes`);
    } catch (err) {
        app.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
        return;
    }

    const { show, episodes } = data;
    app.innerHTML = `
        <a class="small" href="#/">← Back to search</a>
        <div class="show-header" style="margin-top:14px">
            <img class="art lg" src="${esc(show.artwork_url || '')}" alt="" onerror="this.style.visibility='hidden'" />
            <div style="flex:1">
                <h1>${esc(show.title)}</h1>
                <div class="muted small">${esc(show.author || '')} · ${episodes.length} episodes</div>
                ${show.description ? `<div class="card-desc" style="margin-top:8px">${esc(show.description)}</div>` : ''}
            </div>
            <button class="fav-btn ${show.favorite ? 'active' : ''}" id="fav"
                    title="${show.favorite ? 'Remove from favorites' : 'Add to favorites'}">${show.favorite ? '★' : '☆'}</button>
        </div>
        <div class="spread" style="align-items:center">
            <h2>Episodes</h2>
            ${backendPicker()}
        </div>
        <div id="episodes"></div>
    `;
    wireBackendPicker();

    document.getElementById('fav').addEventListener('click', async (e) => {
        const nowFavorite = !show.favorite;
        e.target.disabled = true;
        try {
            await postFavorite(
                show.feed_url,
                { title: show.title, author: show.author, description: show.description, artworkUrl: show.artwork_url, source: show.source, sourceId: show.source_id },
                nowFavorite
            );
            show.favorite = nowFavorite ? 1 : 0;
            const key = normalizeFeedUrl(show.feed_url);
            if (nowFavorite) session.favoriteFeedUrls.add(key);
            else session.favoriteFeedUrls.delete(key);
            e.target.classList.toggle('active', nowFavorite);
            e.target.textContent = nowFavorite ? '★' : '☆';
            e.target.title = nowFavorite ? 'Remove from favorites' : 'Add to favorites';
        } catch (err) {
            app.insertAdjacentHTML('afterbegin', `<div class="notice error">${esc(err.message)}</div>`);
        }
        e.target.disabled = false;
    });

    const list = document.getElementById('episodes');
    list.innerHTML = episodes
        .map(
            (e) => `
        <div class="episode" data-id="${e.id}">
            <div class="episode-main">
                <div class="episode-title">${esc(e.title)}</div>
                <div class="muted small">
                    ${esc(formatDate(e.published_at))} · ${formatDuration(e.duration_sec)}
                    ${e.transcript_url ? ' · <span class="badge">publisher transcript</span>' : ''}
                </div>
            </div>
            <div class="row">
                ${
                    e.summary_id
                        ? `<span class="badge done">summarized</span>
                           <button class="small" data-action="view" data-id="${e.id}">Read</button>`
                        : e.active_job_id
                          ? `<button class="small" data-action="job" data-job="${e.active_job_id}">In progress…</button>`
                          : e.transcript_source
                            ? `<span class="badge warn">transcribed</span>
                               <a class="small" href="#/episode/${e.id}/transcript">Transcript</a>
                               <button class="small primary" data-action="run" data-id="${e.id}">Summarize</button>`
                            : `<button class="small primary" data-action="run" data-id="${e.id}">Summarize</button>`
                }
            </div>
        </div>`
        )
        .join('');

    list.addEventListener('click', async (event) => {
        const btn = event.target.closest('button[data-action]');
        if (!btn) return;
        const { action, id, job } = btn.dataset;

        if (action === 'view') return void (location.hash = `#/episode/${id}`);
        if (action === 'job') return void (location.hash = `#/job/${job}`);

        btn.disabled = true;
        btn.textContent = 'Starting…';
        try {
            const res = await api('/jobs', {
                method: 'POST',
                body: JSON.stringify({ episodeId: Number(id), backend: currentBackend() })
            });
            location.hash = `#/job/${res.job.id}`;
        } catch (err) {
            app.insertAdjacentHTML('afterbegin', `<div class="notice error">${esc(err.message)}</div>`);
            btn.disabled = false;
            btn.textContent = 'Summarize';
        }
    });
}

function viewJob(jobId) {
    app.innerHTML = `
        <h1>Working on it…</h1>
        <p class="muted small" id="job-sub">Transcription runs locally on the GPU — no audio leaves your machine.</p>
        <div class="progress-wrap">
            <div class="progress"><div class="progress-bar" id="bar"></div></div>
            <div class="row" style="justify-content:space-between;margin-top:8px">
                <span class="small" id="stage-label">Starting…</span>
                <span class="small muted" id="pct"></span>
            </div>
            <div class="stages" id="stages"></div>
        </div>
        <div id="job-error"></div>
    `;

    const bar = document.getElementById('bar');
    const label = document.getElementById('stage-label');
    const pct = document.getElementById('pct');
    const stagesEl = document.getElementById('stages');
    const errorEl = document.getElementById('job-error');

    const render = (job) => {
        const progress = Math.round((job.progress || 0) * 100);
        bar.style.width = `${progress}%`;
        bar.className = `progress-bar${job.status === 'done' ? ' done' : job.status === 'failed' ? ' failed' : ''}`;
        // job.note carries sub-steps the local backend reports (model load, segment N of M).
        label.textContent = job.note || STAGE_LABEL[job.status] || job.status || 'Working';
        if (job.queuePosition > 0) label.textContent += ` (position ${job.queuePosition} in queue)`;
        pct.textContent = job.status === 'failed' ? '' : `${progress}%`;

        const currentIndex = STAGES.indexOf(job.status);
        stagesEl.innerHTML = STAGES.slice(0, 4)
            .map((s, i) => {
                const cls =
                    job.status === 'done' || (currentIndex > -1 && i < currentIndex)
                        ? 'complete'
                        : s === job.status
                          ? 'active'
                          : '';
                return `<span class="stage ${cls}">${esc(STAGE_LABEL[s])}</span>`;
            })
            .join('');

        if (job.status === 'failed') {
            closeStream();
            errorEl.innerHTML = `
                <div class="notice error">${esc(job.error || 'Job failed')}</div>
                <button class="small" id="retry">Try again</button>
                <a class="small" style="margin-left:10px" href="#/">Back to search</a>`;
            document.getElementById('retry')?.addEventListener('click', async () => {
                const res = await api('/jobs', {
                    method: 'POST',
                    body: JSON.stringify({ episodeId: job.episode_id, backend: job.backend || currentBackend() })
                });
                location.hash = `#/job/${res.job.id}`;
                router();
            });
        }

        if (job.status === 'done') {
            closeStream();
            location.hash = `#/episode/${job.episode_id}`;
        }
    };

    closeStream();
    activeStream = new EventSource(`/api/jobs/${jobId}/events`);
    activeStream.onmessage = (e) => render(JSON.parse(e.data));
    activeStream.onerror = () => {
        // The browser retries automatically; surface it only if it persists.
        label.textContent = 'Reconnecting…';
    };
}

async function viewSummary(episodeId, summaryId) {
    app.innerHTML = '<div class="loading">Loading summary…</div>';
    let data;
    try {
        data = summaryId ? await api(`/summaries/${summaryId}`) : await api(`/episodes/${episodeId}/summary`);
    } catch (err) {
        app.innerHTML = `<div class="notice error">${esc(err.message)}</div>
                         <a class="small" href="#/">Back to search</a>`;
        return;
    }

    const { episode, show, summary, transcript } = data;
    const s = summary.data;

    app.innerHTML = `
        <a class="small" href="#/show/${show.id}">← ${esc(show.title)}</a>
        <div class="spread" style="margin-top:14px">
            <div>
                <h1>${esc(s.title || episode.title)}</h1>
                <div class="muted small">${esc(episode.title)}</div>
                <div class="meta-line">
                    <span class="badge neutral">${esc(formatDate(episode.published_at))}</span>
                    <span class="badge neutral">${formatDuration(transcript?.duration_sec || episode.duration_sec)}</span>
                    <span class="badge neutral">${esc(transcript?.source === 'publisher' ? 'publisher transcript' : 'whisper')}</span>
                    ${s.language ? `<span class="badge neutral">${esc(s.language)}</span>` : ''}
                    <span class="badge">${esc(BACKEND_LABEL[summary.backend] || summary.backend || 'unknown')}</span>
                </div>
            </div>
            <div class="row">
                <a class="small" href="#/episode/${episode.id}/history">All runs</a>
                ${otherBackend(summary.backend) ? `<button class="small" id="rerun">Re-run with ${esc(BACKEND_LABEL[otherBackend(summary.backend)])}</button>` : ''}
                <button class="small" id="copy">Copy Markdown</button>
                <button class="small danger" id="delete">Delete</button>
            </div>
        </div>

        <h2>Summary</h2>
        <div class="tldr">${esc(s.tldr)}</div>

        ${
            s.chapters?.length
                ? `<h2>Chapters</h2><div>${s.chapters
                      .map(
                          (c) => `<div class="chapter">
                            <div class="ts">${esc(c.start)}</div>
                            <div><h3>${esc(c.title)}</h3><div class="muted small">${esc(c.summary)}</div></div>
                          </div>`
                      )
                      .join('')}</div>`
                : ''
        }

        ${
            s.key_points?.length
                ? `<h2>Key points</h2><ul class="points">${s.key_points
                      .map((p) => `<li>${esc(p)}</li>`)
                      .join('')}</ul>`
                : ''
        }

        ${
            s.quotes?.length
                ? `<h2>Quotes</h2><div>${s.quotes
                      .map(
                          (q) => `<div class="quote">“${esc(q.text)}”
                            <div class="quote-meta">${esc(q.speaker)} · ${esc(q.timestamp)}</div></div>`
                      )
                      .join('')}</div>`
                : ''
        }

        ${
            s.people_and_terms?.length
                ? `<h2>People &amp; terms</h2><div class="terms">${s.people_and_terms
                      .map(
                          (t) => `<div class="term"><div class="term-name">${esc(t.name)}</div>
                            <div class="term-note">${esc(t.note)}</div></div>`
                      )
                      .join('')}</div>`
                : ''
        }

        <h2>Details</h2>
        <div class="muted small">
            Model ${esc(summary.model)} ·
            ${summary.input_tokens ?? '?'} in / ${summary.output_tokens ?? '?'} out tokens ·
            generated ${esc(formatDate(summary.created_at))}
            · <a href="#/episode/${episode.id}/transcript">view transcript</a>
        </div>
    `;

    document.getElementById('copy').addEventListener('click', async (e) => {
        await navigator.clipboard.writeText(toMarkdown(s, episode, show));
        e.target.textContent = 'Copied';
        setTimeout(() => (e.target.textContent = 'Copy Markdown'), 1500);
    });

    document.getElementById('delete').addEventListener('click', async (e) => {
        if (!confirm('Delete this summary? The transcript is kept, so you can re-summarize later.')) return;
        e.target.disabled = true;
        e.target.textContent = 'Deleting…';
        try {
            await api(`/summaries/${summary.id}`, { method: 'DELETE' });
            location.hash = `#/episode/${episode.id}/history`;
        } catch (err) {
            app.insertAdjacentHTML('afterbegin', `<div class="notice error">${esc(err.message)}</div>`);
            e.target.disabled = false;
            e.target.textContent = 'Delete';
        }
    });

    document.getElementById('rerun')?.addEventListener('click', async (e) => {
        const target = otherBackend(summary.backend);
        e.target.disabled = true;
        e.target.textContent = 'Starting…';
        try {
            // The transcript is cached, so this re-runs only the model call.
            const res = await api('/jobs', {
                method: 'POST',
                body: JSON.stringify({ episodeId: episode.id, backend: target })
            });
            location.hash = `#/job/${res.job.id}`;
        } catch (err) {
            app.insertAdjacentHTML('afterbegin', `<div class="notice error">${esc(err.message)}</div>`);
            e.target.disabled = false;
        }
    });
}

/** All summary runs for an episode, newest first — lets duplicates and old runs be reviewed and deleted. */
async function viewHistory(episodeId) {
    app.innerHTML = '<div class="loading">Loading history…</div>';
    let data;
    try {
        data = await api(`/episodes/${episodeId}/summaries`);
    } catch (err) {
        app.innerHTML = `<div class="notice error">${esc(err.message)}</div>
                         <a class="small" href="#/">Back to search</a>`;
        return;
    }

    const { episode, show, summaries } = data;
    app.innerHTML = `
        <a class="small" href="#/show/${show.id}">← ${esc(show.title)}</a>
        <h1 style="margin-top:14px">${esc(episode.title)}</h1>
        <div class="muted small">All summary runs — ${summaries.length}</div>
        <div id="runs" style="margin-top:16px"></div>
    `;

    const list = document.getElementById('runs');
    list.innerHTML = summaries.length
        ? summaries
              .map(
                  (s) => `
        <div class="episode" data-id="${s.id}">
            <div class="episode-main">
                <div class="episode-title">${esc(s.data?.title || episode.title)}</div>
                <div class="muted small">
                    <span class="badge">${esc(BACKEND_LABEL[s.backend] || s.backend || 'unknown')}</span>
                    ${esc(s.model || '')} ·
                    ${s.input_tokens ?? '?'} in / ${s.output_tokens ?? '?'} out ·
                    ${esc(formatDate(s.created_at))}
                </div>
            </div>
            <div class="row">
                <button class="small" data-action="view" data-id="${s.id}">View</button>
                <button class="small danger" data-action="delete" data-id="${s.id}">Delete</button>
            </div>
        </div>`
              )
              .join('')
        : '<div class="notice">No summaries left for this episode.</div>';

    list.addEventListener('click', async (event) => {
        const btn = event.target.closest('button[data-action]');
        if (!btn) return;
        const { action, id } = btn.dataset;

        if (action === 'view') return void (location.hash = `#/episode/${episode.id}/summary/${id}`);

        if (!confirm('Delete this summary? The transcript is kept, so you can re-summarize later.')) return;
        btn.disabled = true;
        btn.textContent = 'Deleting…';
        try {
            await api(`/summaries/${id}`, { method: 'DELETE' });
            viewHistory(episodeId);
        } catch (err) {
            app.insertAdjacentHTML('afterbegin', `<div class="notice error">${esc(err.message)}</div>`);
            btn.disabled = false;
            btn.textContent = 'Delete';
        }
    });
}

/**
 * Whisper writes one line per short recognized segment (a few words each), so rendering one
 * <p> per line reads as a choppy list, not prose. Reflow into sentence-grouped paragraphs instead.
 */
function groupIntoParagraphs(text, targetLength = 500) {
    const flat = text.replace(/\s+/g, ' ').trim();
    const sentences = flat.match(/[^.!?…]+[.!?…]+(\s+|$)/g) || [flat];
    const paragraphs = [];
    let current = '';
    for (const sentence of sentences) {
        if (current && current.length + sentence.length > targetLength) {
            paragraphs.push(current.trim());
            current = '';
        }
        current += sentence;
    }
    if (current.trim()) paragraphs.push(current.trim());
    return paragraphs;
}

/** The full transcript, read in-app as paragraphs instead of a raw text file in a new tab. */
async function viewTranscript(episodeId) {
    app.innerHTML = '<div class="loading">Loading transcript…</div>';
    let data;
    try {
        data = await api(`/episodes/${episodeId}/transcript?format=json`);
    } catch (err) {
        app.innerHTML = `<div class="notice error">${esc(err.message)}</div>
                         <a class="small" href="#/">Back to search</a>`;
        return;
    }

    const { episode, show, transcript } = data;
    const paragraphs = groupIntoParagraphs(transcript.text);

    app.innerHTML = `
        <a class="small" href="#/show/${show.id}">← ${esc(show.title)}</a>
        <div class="spread" style="margin-top:14px">
            <div>
                <h1>${esc(episode.title)}</h1>
                <div class="muted small">${esc(show.title)}</div>
                <div class="meta-line">
                    <span class="badge neutral">${formatDuration(transcript.duration_sec || episode.duration_sec)}</span>
                    <span class="badge neutral">${esc(transcript.source === 'publisher' ? 'publisher transcript' : 'whisper')}</span>
                    ${transcript.language ? `<span class="badge neutral">${esc(transcript.language)}</span>` : ''}
                </div>
            </div>
            <div class="row">
                <button class="small" id="copy-transcript">Copy transcript</button>
            </div>
        </div>

        <div class="transcript-text">${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}</div>
    `;

    document.getElementById('copy-transcript').addEventListener('click', async (e) => {
        await navigator.clipboard.writeText(transcript.text);
        e.target.textContent = 'Copied';
        setTimeout(() => (e.target.textContent = 'Copy transcript'), 1500);
    });
}

/** The backend a summary was NOT produced with, if that one is also available. */
function otherBackend(used) {
    const available = session.status?.backends ?? {};
    const target = used === 'local' ? 'claude' : 'local';
    return available[target] ? target : null;
}

function toMarkdown(s, episode, show) {
    const lines = [`# ${s.title || episode.title}`, '', `*${show.title} — ${episode.title}*`, '', s.tldr, ''];
    if (s.chapters?.length) {
        lines.push('## Chapters', '');
        for (const c of s.chapters) lines.push(`### ${c.start} — ${c.title}`, '', c.summary, '');
    }
    if (s.key_points?.length) {
        lines.push('## Key points', '');
        for (const p of s.key_points) lines.push(`- ${p}`);
        lines.push('');
    }
    if (s.quotes?.length) {
        lines.push('## Quotes', '');
        for (const q of s.quotes) lines.push(`> ${q.text}`, `> — ${q.speaker}, ${q.timestamp}`, '');
    }
    if (s.people_and_terms?.length) {
        lines.push('## People & terms', '');
        for (const t of s.people_and_terms) lines.push(`- **${t.name}** — ${t.note}`);
    }
    return lines.join('\n');
}

/** Shows with at least one transcribed episode — the direct route into a show's episode list. */
/** Favorited shows plus shows with at least one transcribed episode, with a favorites/transcribed filter. */
async function viewShows() {
    app.innerHTML = '<div class="loading">Loading podcasts…</div>';
    const { shows } = await api('/shows');

    if (shows.length === 0) {
        app.innerHTML = `<h1>Podcasts</h1>
            <div class="notice">Nothing favorited or transcribed yet. <a href="#/">Find a podcast</a> to get started.</div>`;
        return;
    }

    const filter = session.podcastsFilter;

    const render = () => {
        const filtered = shows.filter(
            (sh) => (filter.favorites && sh.favorite) || (filter.transcribed && sh.transcript_count > 0)
        );

        app.innerHTML = `
            <div class="spread" style="align-items:center">
                <h1>Podcasts</h1>
                <div class="row">
                    <button class="toggle-btn ${filter.favorites ? 'active' : ''}" data-filter="favorites">★ Favorites</button>
                    <button class="toggle-btn ${filter.transcribed ? 'active' : ''}" data-filter="transcribed">Transcribed</button>
                </div>
            </div>
            <p class="muted small">${filtered.length} podcast${filtered.length === 1 ? '' : 's'}.</p>
            <div class="cards">${filtered
                .map(
                    (sh, i) => `
            <div class="card" data-id="${sh.show_id}">
                <img class="art" src="${esc(sh.artwork_url || '')}" alt="" onerror="this.style.visibility='hidden'" />
                <div class="card-body">
                    <div class="card-title">${esc(sh.show_title)}</div>
                    <div class="card-sub">${esc(sh.author || '')}</div>
                    <div class="badges">
                        <span class="badge neutral">${sh.transcript_count} transcribed</span>
                        <span class="badge neutral">${sh.summarized_count} summarized</span>
                    </div>
                </div>
                <button class="fav-btn ${sh.favorite ? 'active' : ''}" style="align-self:center" data-action="favorite" data-index="${i}"
                        title="${sh.favorite ? 'Remove from favorites' : 'Add to favorites'}">${sh.favorite ? '★' : '☆'}</button>
            </div>`
                )
                .join('')}</div>
            ${filtered.length === 0 ? '<div class="notice">No podcasts match the selected filters.</div>' : ''}
        `;

        document.querySelectorAll('[data-filter]').forEach((btn) =>
            btn.addEventListener('click', () => {
                const key = btn.dataset.filter;
                const other = key === 'favorites' ? 'transcribed' : 'favorites';
                if (filter[key] && !filter[other]) return; // at least one filter must stay active
                filter[key] = !filter[key];
                render();
            })
        );

        document.querySelectorAll('.card').forEach((el) => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('[data-action="favorite"]')) return;
                location.hash = `#/show/${el.dataset.id}`;
            });
        });

        document.querySelectorAll('[data-action="favorite"]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const sh = filtered[Number(btn.dataset.index)];
                const nowFavorite = !sh.favorite;
                btn.disabled = true;
                try {
                    await postFavorite(
                        sh.feed_url,
                        { title: sh.show_title, author: sh.author, artworkUrl: sh.artwork_url, source: sh.source, sourceId: sh.source_id },
                        nowFavorite
                    );
                    sh.favorite = nowFavorite ? 1 : 0;
                    if (nowFavorite) session.favoriteFeedUrls.add(normalizeFeedUrl(sh.feed_url));
                    else session.favoriteFeedUrls.delete(normalizeFeedUrl(sh.feed_url));
                    render();
                } catch (err) {
                    app.insertAdjacentHTML('afterbegin', `<div class="notice error">${esc(err.message)}</div>`);
                    btn.disabled = false;
                }
            });
        });
    };

    render();
}

async function viewLibrary() {
    app.innerHTML = '<div class="loading">Loading library…</div>';
    const { items } = await api('/library');

    if (items.length === 0) {
        app.innerHTML = `<h1>Library</h1>
            <div class="notice">Nothing transcribed yet. <a href="#/">Find a podcast</a> to get started.</div>`;
        return;
    }

    const pendingCount = items.filter((it) => it.status === 'not_summarized').length;
    app.innerHTML = `
        <h1>Library</h1>
        <p class="muted small">
            ${items.length} episode${items.length === 1 ? '' : 's'}
            ${pendingCount ? `— ${pendingCount} awaiting summary` : 'summarized'}.
        </p>
        <div class="cards">${items
            .map(
                (it) => `
            <div class="card" data-id="${it.episode_id}" data-status="${it.status}">
                <img class="art" src="${esc(it.artwork_url || '')}" alt="" onerror="this.style.visibility='hidden'" />
                <div class="card-body">
                    <div class="card-title">${esc(it.episode_title)}</div>
                    <div class="card-sub">${esc(it.show_title)}</div>
                    <div class="badges">
                        <span class="badge neutral">${esc(formatDate(it.created_at))}</span>
                        <span class="badge neutral">${formatDuration(it.duration_sec)}</span>
                        <span class="badge neutral">${esc(it.transcript_source || '')}</span>
                        ${
                            it.status === 'not_summarized'
                                ? '<span class="badge warn">not summarized</span>'
                                : `<span class="badge">${esc(BACKEND_LABEL[it.backend] || it.backend)}</span>`
                        }
                    </div>
                </div>
                <div class="row" style="align-self:center;flex-shrink:0">
                    <a class="small" href="#/episode/${it.episode_id}/transcript"
                       onclick="event.stopPropagation()">Transcript</a>
                    ${
                        it.status === 'not_summarized'
                            ? `<button class="small primary" data-action="summarize" data-id="${it.episode_id}">Summarize</button>`
                            : ''
                    }
                    <button class="small danger" data-action="delete" data-id="${it.episode_id}">Delete</button>
                </div>
            </div>`
            )
            .join('')}</div>`;

    app.querySelectorAll('.card').forEach((el) => {
        if (el.dataset.status === 'summarized') {
            el.style.cursor = 'pointer';
            el.addEventListener('click', () => (location.hash = `#/episode/${el.dataset.id}`));
        }
    });

    app.querySelectorAll('[data-action="summarize"]').forEach((btn) =>
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            btn.disabled = true;
            btn.textContent = 'Starting…';
            try {
                const res = await api('/jobs', {
                    method: 'POST',
                    body: JSON.stringify({ episodeId: Number(btn.dataset.id), backend: currentBackend() })
                });
                location.hash = `#/job/${res.job.id}`;
            } catch (err) {
                app.insertAdjacentHTML('afterbegin', `<div class="notice error">${esc(err.message)}</div>`);
                btn.disabled = false;
                btn.textContent = 'Summarize';
            }
        })
    );

    app.querySelectorAll('[data-action="delete"]').forEach((btn) =>
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (
                !confirm(
                    'Delete the transcript and all summaries for this episode? ' +
                        'This can\'t be undone — getting a new summary will mean re-downloading and re-transcribing the audio.'
                )
            )
                return;
            btn.disabled = true;
            btn.textContent = 'Deleting…';
            try {
                await api(`/episodes/${btn.dataset.id}/transcript`, { method: 'DELETE' });
                viewLibrary();
            } catch (err) {
                app.insertAdjacentHTML('afterbegin', `<div class="notice error">${esc(err.message)}</div>`);
                btn.disabled = false;
                btn.textContent = 'Delete';
            }
        })
    );
}

/* ---------------------------------------------------------------- router */

function router() {
    closeStream();
    const hash = location.hash.replace(/^#/, '') || '/';
    const [, section, param, sub, subParam] = hash.split('/');

    if (section === 'show' && param) return void viewShow(param);
    if (section === 'job' && param) return void viewJob(param);
    if (section === 'episode' && param && sub === 'history') return void viewHistory(param);
    if (section === 'episode' && param && sub === 'transcript') return void viewTranscript(param);
    if (section === 'episode' && param && sub === 'summary' && subParam) return void viewSummary(param, subParam);
    if (section === 'episode' && param) return void viewSummary(param);
    if (section === 'library') return void viewLibrary();
    if (section === 'shows') return void viewShows();
    return void viewSearch();
}

window.addEventListener('hashchange', router);

/** Load status before the first render so views know which backends exist. */
async function boot() {
    try {
        session.status = await api('/status');
        const s = session.status;
        const summarizer = s.summarizer === 'local' ? s.localModel : 'Claude';
        statusLine.textContent =
            `transcribe: ${s.whisperModel} · summarize: ${summarizer} · ` +
            `search: iTunes${s.podcastIndexEnabled ? ' + Podcast Index' : ''}`;
    } catch {
        statusLine.textContent = 'server unreachable';
    }
    try {
        const { shows } = await api('/shows');
        session.favoriteFeedUrls = new Set(
            shows.filter((sh) => sh.favorite).map((sh) => normalizeFeedUrl(sh.feed_url))
        );
    } catch {
        /* favorites star just won't show as active yet; not worth blocking boot over */
    }
    router();
}

boot();
