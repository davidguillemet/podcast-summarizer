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

## Conventions

- ESM everywhere (`"type": "module"`), Node ≥ 22. Use `process.loadEnvFile()`, not `dotenv`.
- Plain JavaScript with JSDoc where useful. No TypeScript.
- Frontend is vanilla HTML/CSS/JS served statically — no bundler, no framework. Keep it that way;
  instant `npm start` is the point.
- 4-space indent, single quotes, semicolons.
- Comments explain *why*, especially for the non-obvious constraints above. Don't add comments
  restating what the next line does.
