# CLAUDE.md

Guidance for Claude Code working in this repository.

Local podcast summarizer: search a podcast, transcribe an episode on-device with whisper.cpp,
summarize it with either the Claude API or a local Mistral model. Express + SQLite + vanilla
frontend. No build step, no framework, no TypeScript.

**`README.md` covers setup, build commands and the API surface — read it first.** This file
covers the things that are *not* obvious from reading the code.

## Commands

```bash
npm start          # server on http://localhost:4300
npm run dev        # same, with --watch
```

There is no test suite, no linter and no build step. Verify changes by running the server and
exercising the API with `curl`.

## Critical gotchas

These have each cost real debugging time. Read them before touching the build or the process
lifecycle.

### Never stop the server with `pkill -f "node src/server.js"`

That pattern also matches the **shell wrapper** whose command line contains the string, so pkill
kills the wrong process and leaves the server running. Subsequent restarts then silently fail to
bind and you end up testing stale code for a long time without realising. Always:

```bash
kill -9 $(lsof -ti TCP:4300 -sTCP:LISTEN)
```

Confirm the restart actually took effect by checking the PID's start time
(`ps -eo pid,lstart,command | grep "[s]rc/server.js"`), not by assuming.

### This machine's Homebrew is Intel-only (`/usr/local`, under Rosetta)

There is no `/opt/homebrew`. Never `brew install` a build dependency for whisper.cpp or
llama.cpp — you get x86_64 binaries with no Metal, or worse, CMake links an x86_64 library into
an arm64 binary and the build fails. This already happened once: llama.cpp picked up
`/usr/local/Cellar/openssl@3` and died at 81%.

CMake must resolve to `~/.local/bin/cmake` (the universal binary). Both builds pass
`-DCMAKE_OSX_ARCHITECTURES=arm64`, and llama.cpp additionally needs
`-DLLAMA_OPENSSL=OFF -DCMAKE_IGNORE_PREFIX_PATH=/usr/local`.

Verify Metal after any rebuild — silence here means a 5–10× slowdown that nothing else reports:
- `vendor/llama.cpp/build/bin/llama-server --list-devices` must list `MTL0`
- the server log must show `ggml_metal_init` on the first transcription

### `llama-server` is a child process and can be orphaned

A hard kill of the Node app leaves it running on port 8110. `llamaServer.js` detects this,
adopts it, and — importantly — sizes the prompt budget against the **running** server's `n_ctx`
via `effectiveContext()`, not against `LLAMA_CONTEXT`. Do not "simplify" that back to reading
config; the two genuinely diverge. To start clean: `pkill -9 -f llama-server`.

### Port 4300 is deliberate

3000 is CRA and 4000/5002/5003/9099/9199 are the Firebase emulators for the unrelated `photosub`
project, which runs on the same machine. Don't change the default.

### `.env` is not auto-synced with `.env.example`

Adding a key to `.env.example` does not add it to an existing `.env`, and a `sed` replacing a
line that isn't there silently does nothing. When adding a config key, update both.

## Architecture notes

**Three summarizer backends, one contract.** `summary-schema.js` holds the JSON schema and
prompts used by `summarize-claude.js`, `summarize-mistral.js` (hosted Mistral API) and
`summarize-local.js` (llama.cpp); `summarize.js` is just a dispatcher keyed by backend name.
Keep the schema shared — comparing backends on the same episode is a core feature
(`GET /api/episodes/:id/summaries`, and the "Re-run with…" button).

**Transcripts are cached in SQLite and stages are skipped when their artifacts exist.** This is
what makes re-summarizing cheap: one model call, no re-download, no re-transcription. Preserve
that property in any pipeline change.

**Whisper is driven directly, not through the `nodejs-whisper` wrapper.** The package is present
only to vendor a pinned whisper.cpp source tree. `transcribe.js` spawns `whisper-cli` itself to
get progress output and language detection, and to avoid the wrapper's interactive model
prompts. Don't "fix" this by switching to `nodewhisper()`.

**Jobs are in-process and serial.** Whisper and Mistral each saturate the GPU, so concurrency
buys nothing. Anything still marked running at boot is marked failed
(`recoverInterruptedJobs()`) because in-process work cannot survive a restart.

**The local backend's map-reduce path degrades proper nouns.** Single-pass keeps them; the notes
step compresses and rare names get corrupted ("Mocci" → "Moxie"). Prefer raising `LLAMA_CONTEXT`
over lowering the chunk threshold. ~250 tokens per minute of speech, so 32k covers ~2 hours.

**DB migrations are additive only.** `CREATE TABLE IF NOT EXISTS` never alters an existing table
— use the `ensureColumn()` helper in `db.js` for new columns.

**Login is invite-only, and zero users means zero access — including yours.** There's no
signup route by design; accounts exist only via `npm run users -- add <name>`
(`scripts/manage-users.js`). Sessions are opaque tokens in the `sessions` table, not JWTs, so
they need no signing secret and survive a server restart — a stale/expired one is swept at boot
by `deleteExpiredSessions()`, the same pattern as `recoverInterruptedJobs()`. `/api/status`,
`/api/login`, `/api/logout` and `/api/session` are the only routes mounted before the
`requireAuth` middleware in `server.js`; anything else new under `/api` inherits the gate
automatically as long as it's mounted after that line — don't reorder it. `COOKIE_SECURE`
defaults to off on purpose, because the session cookie must work over plain HTTP on a LAN or
through Tailscale; flip it on only once TLS actually terminates somewhere in front of the app.

**Per-user API keys are encrypted at rest, not zero-knowledge.** `ENCRYPTION_KEY` (required at
boot, unlike the provider keys) protects `users.claude_api_key_enc` /
`mistral_api_key_enc` from someone who gets the SQLite file — it does not and cannot hide a
user's key from this server's own process, since `pipeline.js`'s `resolveApiKey()` has to
decrypt it to make the call on their behalf. Don't describe this to users as "even the admin
can't see your key" — that's only true if the API call moves client-side, which it doesn't.
`jobs.user_id` is how a job remembers whose key to use once it actually runs in the queue,
since jobs are async and the request that created them has long since finished.

**Free plan can't use the shared key — enforced twice, on purpose, and status has to agree.**
`users.plan` is `'free'` by default (no billing exists; `set-plan` in `manage-users.js` is the
only way to change it). `resolveApiKey()` in `pipeline.js` throws for a free user with no key
of their own, rather than silently falling back to `config.anthropicApiKey`/`config.mistral.
apiKey` — that fallback is exactly what the free/premium split exists to prevent. It's called
from `routes/jobs.js` at job creation (so a doomed job fails before whisper ever runs, not
after) *and* again from `pipeline.js` at the actual model call, as a safety net for a plan or
key change that happens in between. `/api/status`'s `backends` flags apply the identical rule
(own key always counts; the server's key only counts for premium) so the UI's backend picker
never offers a choice `resolveApiKey()` would then reject — if you change one, change the
other, or the picker and the enforcement will disagree. `local` has no key concept and is
never plan-restricted, at any tier.

**`jobs.user_id` has no `ON DELETE` action, and SQLite can't add one after the fact.** Deleting
a user who has ever run a job hits a foreign-key error unless their jobs are re-pointed to
`NULL` first — `deleteUser()` in `db.js` does this in a transaction before the actual delete.
Don't "simplify" that back to a bare `DELETE FROM users`; it breaks the moment the target
account has any job history, which — via `set-plan`/testing/normal use — is most of them.

**The Docker image never builds local Mistral, and downloads the whisper model at container
start, not build time.** `Dockerfile` compiles whisper.cpp CPU-only (no Metal — Linux/NAS
target) but skips llama.cpp entirely; without a GPU a 24B model isn't practical, so a
Docker deployment is Claude/Mistral-API-only by design, same as any `SUMMARIZER=claude`/
`mistral` host. `docker-entrypoint.sh` downloads the model into the `data/` volume and
symlinks it into `node_modules` on every start — `node_modules` comes from the image and is
rebuilt fresh each time, so the symlink can't be created once at build time and expected to
survive, but the model download itself is skipped once it's already on the volume. `config.js`
loads `.env` only `if (fs.existsSync(...))`, so Compose's `env_file:` (which injects vars
straight into `process.env`, no literal file in the container) works without any extra glue —
don't add one.

## Conventions

- ESM everywhere (`"type": "module"`), Node ≥ 22. Use `process.loadEnvFile()`, not `dotenv`.
- Plain JavaScript with JSDoc where useful. No TypeScript.
- Frontend is vanilla HTML/CSS/JS served statically — no bundler, no framework. Keep it that way;
  instant `npm start` is the point.
- 4-space indent, single quotes, semicolons.
- Comments explain *why*, especially for the non-obvious constraints above. Don't add comments
  restating what the next line does.
