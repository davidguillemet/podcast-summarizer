import Database from 'better-sqlite3';
import { paths } from './config.js';
import { SUMMARY_LEVELS } from './services/summary-schema.js';

const db = new Database(paths.db);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS shows (
    id           INTEGER PRIMARY KEY,
    source       TEXT NOT NULL,
    source_id    TEXT,
    feed_url     TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    author       TEXT,
    description  TEXT,
    artwork_url  TEXT,
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS episodes (
    id             INTEGER PRIMARY KEY,
    show_id        INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
    guid           TEXT NOT NULL,
    title          TEXT NOT NULL,
    description    TEXT,
    published_at   TEXT,
    duration_sec   INTEGER,
    audio_url      TEXT,
    transcript_url TEXT,
    created_at     TEXT NOT NULL,
    UNIQUE(show_id, guid)
);

CREATE TABLE IF NOT EXISTS jobs (
    id          INTEGER PRIMARY KEY,
    episode_id  INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,
    stage       TEXT,
    progress    REAL NOT NULL DEFAULT 0,
    error       TEXT,
    audio_path  TEXT,
    wav_path    TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS transcripts (
    id           INTEGER PRIMARY KEY,
    episode_id   INTEGER NOT NULL UNIQUE REFERENCES episodes(id) ON DELETE CASCADE,
    text         TEXT NOT NULL,
    srt          TEXT,
    language     TEXT,
    source       TEXT NOT NULL,
    duration_sec INTEGER,
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
    id            INTEGER PRIMARY KEY,
    episode_id    INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    json          TEXT NOT NULL,
    model         TEXT,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_episodes_show ON episodes(show_id);
CREATE INDEX IF NOT EXISTS idx_jobs_episode  ON jobs(episode_id);
CREATE INDEX IF NOT EXISTS idx_summaries_ep  ON summaries(episode_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

/**
 * Additive migrations for columns introduced after a database already exists.
 * `CREATE TABLE IF NOT EXISTS` above never alters an existing table.
 */
function ensureColumn(table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}
ensureColumn('summaries', 'backend', 'TEXT');
ensureColumn('summaries', 'level', 'TEXT'); // 'brief' | 'standard' | 'detailed'
// Rows written before this column existed were all produced with what is now called
// 'standard' — the original hardcoded prompt/schema text is byte-for-byte what 'standard'
// still says. Backfill them so the UI's level badge doesn't just silently disappear for
// every summary generated before this feature; safe to re-run, and a no-op once caught up.
db.prepare("UPDATE summaries SET level = 'standard' WHERE level IS NULL").run();
ensureColumn('jobs', 'backend', 'TEXT');
ensureColumn('jobs', 'level', 'TEXT'); // resolved at job creation — see routes/jobs.js
ensureColumn('jobs', 'note', 'TEXT'); // human-readable sub-status, e.g. "Reading segment 2 of 4"
ensureColumn('jobs', 'user_id', 'INTEGER REFERENCES users(id)');
ensureColumn('shows', 'favorite', 'INTEGER NOT NULL DEFAULT 0');
// AES-256-GCM ciphertext (iv:tag:data, all hex) — see services/auth.js encryptSecret/decryptSecret.
ensureColumn('users', 'claude_api_key_enc', 'TEXT');
ensureColumn('users', 'mistral_api_key_enc', 'TEXT');
// 'free' (must supply their own Claude/Mistral key) or 'premium' (may fall back to the
// server's shared key). No billing exists yet — everyone starts, and stays, 'free' until
// an admin runs `npm run users -- set-plan <name> premium` by hand.
ensureColumn('users', 'plan', "TEXT NOT NULL DEFAULT 'free'");
// Default detail level for this user's new jobs — 'brief' | 'standard' | 'detailed'.
// Overridable per job (routes/jobs.js), same relationship as backend has to config.summarizer.
ensureColumn('users', 'summary_level', "TEXT NOT NULL DEFAULT 'standard'");
// Per-user model override within a backend — NULL means "use that backend's default"
// (summarize-claude.js / summarize-mistral.js MODEL). See their MODELS exports for the
// allowed values; 'local' has no model concept, so there's no local_model column.
ensureColumn('users', 'claude_model', 'TEXT');
ensureColumn('users', 'mistral_model', 'TEXT');

const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ shows */

const insertShow = db.prepare(`
    INSERT INTO shows (source, source_id, feed_url, title, author, description, artwork_url, created_at)
    VALUES (@source, @source_id, @feed_url, @title, @author, @description, @artwork_url, @created_at)
    ON CONFLICT(feed_url) DO UPDATE SET
        title       = excluded.title,
        author      = excluded.author,
        description = COALESCE(excluded.description, shows.description),
        artwork_url = COALESCE(excluded.artwork_url, shows.artwork_url),
        source_id   = COALESCE(excluded.source_id, shows.source_id)
    RETURNING *
`);

export function upsertShow(show) {
    return insertShow.get({
        source: show.source ?? 'itunes',
        source_id: show.sourceId ?? null,
        feed_url: show.feedUrl,
        title: show.title,
        author: show.author ?? null,
        description: show.description ?? null,
        artwork_url: show.artworkUrl ?? null,
        created_at: now()
    });
}

const selectShow = db.prepare('SELECT * FROM shows WHERE id = ?');
export const getShow = (id) => selectShow.get(id);

const selectShowByFeed = db.prepare('SELECT * FROM shows WHERE feed_url = ?');
export const getShowByFeed = (feedUrl) => selectShowByFeed.get(feedUrl);

const setFavoriteStmt = db.prepare('UPDATE shows SET favorite = ? WHERE id = ?');
export const setFavorite = (id, favorite) => setFavoriteStmt.run(favorite ? 1 : 0, id).changes > 0;

/**
 * Shows worth showing on the "Podcasts" browse page: favorited, or with at least one
 * transcribed episode — as opposed to every show ever opened from search, most of which
 * have neither. LEFT JOINs throughout because a favorited-but-never-opened show may have
 * zero episodes cached yet.
 */
const selectBrowsableShows = db.prepare(`
    SELECT sh.id AS show_id, sh.title AS show_title, sh.author, sh.artwork_url, sh.feed_url,
           sh.source, sh.source_id, sh.favorite,
           COUNT(DISTINCT t.episode_id) AS transcript_count,
           COUNT(DISTINCT s.episode_id) AS summarized_count,
           MAX(COALESCE(s.created_at, t.created_at, sh.created_at)) AS last_activity
      FROM shows sh
 LEFT JOIN episodes e    ON e.show_id = sh.id
 LEFT JOIN transcripts t ON t.episode_id = e.id
 LEFT JOIN summaries s   ON s.episode_id = e.id
     WHERE sh.favorite = 1 OR t.id IS NOT NULL
     GROUP BY sh.id
     ORDER BY sh.favorite DESC, last_activity DESC
`);
export const listBrowsableShows = () => selectBrowsableShows.all();

/* --------------------------------------------------------------- episodes */

const insertEpisode = db.prepare(`
    INSERT INTO episodes (show_id, guid, title, description, published_at, duration_sec,
                          audio_url, transcript_url, created_at)
    VALUES (@show_id, @guid, @title, @description, @published_at, @duration_sec,
            @audio_url, @transcript_url, @created_at)
    ON CONFLICT(show_id, guid) DO UPDATE SET
        title          = excluded.title,
        description    = COALESCE(excluded.description, episodes.description),
        published_at   = COALESCE(excluded.published_at, episodes.published_at),
        duration_sec   = COALESCE(excluded.duration_sec, episodes.duration_sec),
        audio_url      = COALESCE(excluded.audio_url, episodes.audio_url),
        transcript_url = COALESCE(excluded.transcript_url, episodes.transcript_url)
`);

export const upsertEpisodes = db.transaction((showId, episodes) => {
    for (const ep of episodes) {
        insertEpisode.run({
            show_id: showId,
            guid: ep.guid,
            title: ep.title,
            description: ep.description ?? null,
            published_at: ep.publishedAt ?? null,
            duration_sec: ep.durationSec ?? null,
            audio_url: ep.audioUrl ?? null,
            transcript_url: ep.transcriptUrl ?? null,
            created_at: now()
        });
    }
    return episodes.length;
});

const selectEpisodes = db.prepare(`
    SELECT e.*,
           (SELECT s.id FROM summaries s WHERE s.episode_id = e.id
             ORDER BY s.created_at DESC LIMIT 1)              AS summary_id,
           (SELECT t.source FROM transcripts t WHERE t.episode_id = e.id) AS transcript_source,
           (SELECT j.id FROM jobs j WHERE j.episode_id = e.id
             AND j.status NOT IN ('done','failed') LIMIT 1)   AS active_job_id
      FROM episodes e
     WHERE e.show_id = ?
     ORDER BY COALESCE(e.published_at, '') DESC
`);
export const listEpisodes = (showId) => selectEpisodes.all(showId);

const selectEpisode = db.prepare('SELECT * FROM episodes WHERE id = ?');
export const getEpisode = (id) => selectEpisode.get(id);

/* ------------------------------------------------------------------- jobs */

const insertJob = db.prepare(`
    INSERT INTO jobs (episode_id, status, stage, progress, backend, level, user_id, created_at, updated_at)
    VALUES (?, 'queued', 'queued', 0, ?, ?, ?, ?, ?)
    RETURNING *
`);
export function createJob(episodeId, backend = null, userId = null, level = null) {
    const ts = now();
    return insertJob.get(episodeId, backend, level, userId, ts, ts);
}

const selectJob = db.prepare('SELECT * FROM jobs WHERE id = ?');
export const getJob = (id) => selectJob.get(id);

const selectActiveJob = db.prepare(`
    SELECT * FROM jobs WHERE episode_id = ? AND status NOT IN ('done','failed')
    ORDER BY id DESC LIMIT 1
`);
export const getActiveJobForEpisode = (episodeId) => selectActiveJob.get(episodeId);

/** Partial update — only the provided columns are written. */
export function updateJob(id, fields) {
    const allowed = [
        'status', 'stage', 'progress', 'error',
        'audio_path', 'wav_path', 'finished_at', 'backend', 'note'
    ];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (keys.length === 0) return getJob(id);
    const setSql = keys.map((k) => `${k} = @${k}`).join(', ');
    const stmt = db.prepare(`UPDATE jobs SET ${setSql}, updated_at = @updated_at WHERE id = @id RETURNING *`);
    return stmt.get({ ...fields, id, updated_at: now() });
}

/**
 * Jobs run in-process, so anything still marked running when the server boots
 * died with the previous process. Mark them failed rather than leaving zombies.
 */
const recoverStmt = db.prepare(`
    UPDATE jobs SET status = 'failed', error = 'Interrupted by server restart', updated_at = ?
    WHERE status NOT IN ('done','failed')
`);
export const recoverInterruptedJobs = () => recoverStmt.run(now()).changes;

/* ------------------------------------------------------------ transcripts */

const insertTranscript = db.prepare(`
    INSERT INTO transcripts (episode_id, text, srt, language, source, duration_sec, created_at)
    VALUES (@episode_id, @text, @srt, @language, @source, @duration_sec, @created_at)
    ON CONFLICT(episode_id) DO UPDATE SET
        text = excluded.text, srt = excluded.srt, language = excluded.language,
        source = excluded.source, duration_sec = excluded.duration_sec
    RETURNING *
`);
export function saveTranscript(t) {
    return insertTranscript.get({
        episode_id: t.episodeId,
        text: t.text,
        srt: t.srt ?? null,
        language: t.language ?? null,
        source: t.source,
        duration_sec: t.durationSec ?? null,
        created_at: now()
    });
}

const selectTranscript = db.prepare('SELECT * FROM transcripts WHERE episode_id = ?');
export const getTranscript = (episodeId) => selectTranscript.get(episodeId);

const deleteSummariesForEpisode = db.prepare('DELETE FROM summaries WHERE episode_id = ?');
const deleteTranscriptStmt = db.prepare('DELETE FROM transcripts WHERE episode_id = ?');

/** Drops the whole pipeline result for an episode — every summary plus the transcript itself. */
export const deleteTranscript = db.transaction((episodeId) => {
    deleteSummariesForEpisode.run(episodeId);
    return deleteTranscriptStmt.run(episodeId).changes > 0;
});

/* -------------------------------------------------------------- summaries */

const insertSummary = db.prepare(`
    INSERT INTO summaries (episode_id, json, model, backend, level, input_tokens, output_tokens, created_at)
    VALUES (@episode_id, @json, @model, @backend, @level, @input_tokens, @output_tokens, @created_at)
    RETURNING *
`);
export function saveSummary(s) {
    return insertSummary.get({
        episode_id: s.episodeId,
        json: JSON.stringify(s.data),
        model: s.model ?? null,
        backend: s.backend ?? null,
        level: s.level ?? null,
        input_tokens: s.inputTokens ?? null,
        output_tokens: s.outputTokens ?? null,
        created_at: now()
    });
}

/** Every summary ever generated for an episode, newest first — used for A/B comparison. */
const selectSummaryHistory = db.prepare(
    'SELECT * FROM summaries WHERE episode_id = ? ORDER BY created_at DESC'
);
export const listSummaries = (episodeId) => selectSummaryHistory.all(episodeId);

const selectSummary = db.prepare(
    'SELECT * FROM summaries WHERE episode_id = ? ORDER BY created_at DESC LIMIT 1'
);
export const getSummary = (episodeId) => selectSummary.get(episodeId);

const selectSummaryById = db.prepare('SELECT * FROM summaries WHERE id = ?');
export const getSummaryById = (id) => selectSummaryById.get(id);

const deleteSummaryStmt = db.prepare('DELETE FROM summaries WHERE id = ?');
export const deleteSummary = (id) => deleteSummaryStmt.run(id).changes > 0;

/**
 * Rooted at transcripts, not summaries, so an episode whose only summary was deleted still
 * shows up (as "not_summarized") instead of vanishing — the transcript is the expensive,
 * cached artifact and deleting a summary must not hide that it already exists.
 */
const selectLibrary = db.prepare(`
    SELECT s.id AS summary_id, COALESCE(s.created_at, t.created_at) AS created_at,
           s.model, s.backend, s.level, s.input_tokens, s.output_tokens,
           e.id AS episode_id, e.title AS episode_title, e.published_at, e.duration_sec,
           sh.id AS show_id, sh.title AS show_title, sh.artwork_url,
           t.source AS transcript_source,
           CASE WHEN s.id IS NULL THEN 'not_summarized' ELSE 'summarized' END AS status
      FROM transcripts t
      JOIN episodes e  ON e.id = t.episode_id
      JOIN shows sh    ON sh.id = e.show_id
 LEFT JOIN summaries s ON s.id = (SELECT MAX(s2.id) FROM summaries s2 WHERE s2.episode_id = t.episode_id)
     ORDER BY created_at DESC
`);
export const listLibrary = () => selectLibrary.all();

/* -------------------------------------------------------------- accounts */

const insertUser = db.prepare(`
    INSERT INTO users (username, password_hash, password_salt, created_at)
    VALUES (@username, @password_hash, @password_salt, @created_at)
    RETURNING *
`);
export function createUser(username, passwordHash, passwordSalt) {
    return insertUser.get({
        username,
        password_hash: passwordHash,
        password_salt: passwordSalt,
        created_at: now()
    });
}

const selectUserByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
export const getUserByUsername = (username) => selectUserByUsername.get(username);

const selectUserById = db.prepare('SELECT * FROM users WHERE id = ?');
export const getUserById = (id) => (id ? selectUserById.get(id) : undefined);

const selectUsers = db.prepare('SELECT id, username, plan, created_at FROM users ORDER BY created_at');
export const listUsers = () => selectUsers.all();

const orphanJobsStmt = db.prepare(
    'UPDATE jobs SET user_id = NULL WHERE user_id = (SELECT id FROM users WHERE username = ?)'
);
const deleteUserStmt = db.prepare('DELETE FROM users WHERE username = ?');

/**
 * `jobs.user_id` has no ON DELETE action (SQLite can't add one to an existing column
 * without rebuilding the table, which conflicts with additive-only migrations), so a user
 * who ever ran a job would otherwise be undeletable — orphan their old jobs first.
 */
export const deleteUser = db.transaction((username) => {
    orphanJobsStmt.run(username);
    return deleteUserStmt.run(username).changes > 0;
});

const KEY_COLUMN = { claude: 'claude_api_key_enc', mistral: 'mistral_api_key_enc' };
const setClaudeKeyStmt = db.prepare('UPDATE users SET claude_api_key_enc = ? WHERE id = ?');
const setMistralKeyStmt = db.prepare('UPDATE users SET mistral_api_key_enc = ? WHERE id = ?');

/** `encrypted` is the ciphertext to store, or null to clear a previously saved key. */
export function setUserApiKey(userId, provider, encrypted) {
    if (!(provider in KEY_COLUMN)) throw new Error(`Unknown key provider "${provider}"`);
    (provider === 'claude' ? setClaudeKeyStmt : setMistralKeyStmt).run(encrypted, userId);
}

const MODEL_COLUMN = { claude: 'claude_model', mistral: 'mistral_model' };
const setClaudeModelStmt = db.prepare('UPDATE users SET claude_model = ? WHERE id = ?');
const setMistralModelStmt = db.prepare('UPDATE users SET mistral_model = ? WHERE id = ?');

/** `model` null clears the override, falling back to that backend's default. */
export function setUserModel(userId, provider, model) {
    if (!(provider in MODEL_COLUMN)) throw new Error(`Unknown model provider "${provider}"`);
    (provider === 'claude' ? setClaudeModelStmt : setMistralModelStmt).run(model, userId);
}

const setSummaryLevelStmt = db.prepare('UPDATE users SET summary_level = ? WHERE id = ?');
export function setUserSummaryLevel(userId, level) {
    if (!SUMMARY_LEVELS.includes(level)) throw new Error(`Unknown summary level "${level}"`);
    setSummaryLevelStmt.run(level, userId);
}

const setPlanStmt = db.prepare('UPDATE users SET plan = ? WHERE username = ?');
export function setUserPlan(username, plan) {
    if (plan !== 'free' && plan !== 'premium') throw new Error(`Unknown plan "${plan}"`);
    return setPlanStmt.run(plan, username).changes > 0;
}

/* -------------------------------------------------------------- sessions */

const insertSession = db.prepare(`
    INSERT INTO sessions (token, user_id, created_at, expires_at)
    VALUES (@token, @user_id, @created_at, @expires_at)
`);
export function createSession(token, userId, expiresAt) {
    insertSession.run({ token, user_id: userId, created_at: now(), expires_at: expiresAt });
}

/** Joins the owning user in, so callers get the username for free. */
const selectSession = db.prepare(`
    SELECT s.token, s.expires_at, u.id AS user_id, u.username
      FROM sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.token = ?
`);
export const getSession = (token) => selectSession.get(token);

const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE token = ?');
export const deleteSession = (token) => deleteSessionStmt.run(token).changes > 0;

/** Run at boot, same spirit as recoverInterruptedJobs — sweep out what's no longer valid. */
const deleteExpiredStmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
export const deleteExpiredSessions = () => deleteExpiredStmt.run(now()).changes;

export default db;
