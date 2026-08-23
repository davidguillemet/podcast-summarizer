# Podcast Summarizer

Search any podcast, transcribe an episode **on-device**, and get a structured summary.
Runs locally: a small Express server, SQLite, whisper.cpp on the GPU, and a choice of three
summarizers — the Claude API, the hosted Mistral API, or a local Mistral model. Audio never
leaves the machine either way.

```
search (iTunes + Podcast Index) → episode list → download → ffmpeg → whisper.cpp (Metal)
    → Claude API ─or─ Mistral API ─or─ Mistral Small 3.2 via llama.cpp (Metal) → SQLite
```

## Quick start

```bash
npm install
cp .env.example .env
npm start                 # http://localhost:4300
```

With `SUMMARIZER=local` (the fully offline path) nothing else is needed once the model is in
place. With `SUMMARIZER=claude` or `SUMMARIZER=mistral` you need the matching API key
(`ANTHROPIC_API_KEY` or `MISTRAL_API_KEY`); the server refuses to boot without it so you find
out immediately rather than at the end of a job.

## Requirements

| Need | Why | Install |
|---|---|---|
| Node ≥ 22 | native `.env` loading, modern streams | — |
| CMake (arm64) | builds whisper.cpp and llama.cpp | see below |
| Xcode CLT | C++ compiler + Metal | `xcode-select --install` |

> **On Apple silicon, do not install CMake via Homebrew if your Homebrew lives in `/usr/local`.**
> That is the Intel prefix running under Rosetta. The resulting builds lose Metal (5–10× slower),
> and CMake will also try to link Intel libraries into arm64 binaries — which is exactly how the
> llama.cpp build fails, with an x86_64 OpenSSL from `/usr/local/Cellar`.

```bash
mkdir -p ~/.local/opt ~/.local/bin && cd ~/.local/opt
curl -LO https://github.com/Kitware/CMake/releases/download/v4.4.2/cmake-4.4.2-macos-universal.tar.gz
tar xzf cmake-4.4.2-macos-universal.tar.gz
ln -sf ~/.local/opt/cmake-4.4.2-macos-universal/CMake.app/Contents/bin/cmake ~/.local/bin/cmake
export PATH="$HOME/.local/bin:$PATH"     # add to ~/.zshrc
which cmake                              # must print ~/.local/bin/cmake before building
```

### Build whisper.cpp (transcription — always needed)

`nodejs-whisper` vendors the whisper.cpp source; we compile it once and drive the resulting
`whisper-cli` binary directly, which gives us progress output and language detection without
the wrapper's interactive model prompts.

```bash
cd node_modules/nodejs-whisper/cpp/whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 \
      -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
cmake --build build --config Release -j$(sysctl -n hw.ncpu)
```

```bash
curl -fL -o data/models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
ln -sf "$PWD/data/models/ggml-large-v3-turbo.bin" \
  node_modules/nodejs-whisper/cpp/whisper.cpp/models/ggml-large-v3-turbo.bin
```

Models live in `data/models/` and are symlinked into `node_modules`, so reinstalling deps
doesn't cost a re-download.

### Build llama.cpp (only for `SUMMARIZER=local`)

Note `LLAMA_OPENSSL=OFF` and the ignored `/usr/local` prefix — without them CMake picks up
Intel Homebrew libraries and the link fails.

```bash
git clone --depth 1 https://github.com/ggml-org/llama.cpp.git vendor/llama.cpp
cd vendor/llama.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 \
      -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
      -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON \
      -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF \
      -DCMAKE_IGNORE_PREFIX_PATH=/usr/local -DCMAKE_IGNORE_PATH=/usr/local/lib
cmake --build build --config Release -j$(sysctl -n hw.ncpu)
./build/bin/llama-server --list-devices     # must list your GPU, e.g. "MTL0: Apple M2 Max"
```

```bash
curl -fL -o data/models/Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf \
  https://huggingface.co/unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF/resolve/main/Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf
```

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `SUMMARIZER` | no | `claude` (default), `mistral` or `local`. Transcription is on-device either way. |
| `ANTHROPIC_API_KEY` | only for `claude` | Boot fails without it, including on the `.env.example` placeholder. |
| `MISTRAL_API_KEY` | only for `mistral` | Same boot-time check as `ANTHROPIC_API_KEY`. Get one at [console.mistral.ai](https://console.mistral.ai/api-keys). |
| `MISTRAL_MODEL` | no | Default `mistral-large-latest`. |
| `PODCASTINDEX_KEY` / `_SECRET` | no | Free from [podcastindex.org/api](https://podcastindex.org/api). Adds episode-level search and surfaces free publisher transcripts. Without it, iTunes only. |
| `PORT` | no | Default `4300` — avoids the Firebase emulators (4000/5002/5003/9099/9199) and CRA (3000). |
| `WHISPER_MODEL` | no | Default `large-v3-turbo`. `base`/`small` are much faster for testing. |
| `LOCAL_MODEL_FILE` | no | GGUF in `data/models/`. |
| `LLAMA_CONTEXT` | no | Default `32768`. |
| `LLAMA_IDLE_MINUTES` | no | Unload the 13 GB model after N idle minutes. `0` keeps it resident. |
| `ITUNES_COUNTRY` | no | Search storefront. Default `fr`. |

You can also pick a backend per run from the UI, or per request:
`POST /api/jobs {"episodeId": 42, "backend": "local"}`.

## How it works

**Transcript sources.** If an episode advertises a Podcasting 2.0 `<podcast:transcript>`, that
is fetched and used directly — free and instant. Otherwise the audio is downloaded, converted
to 16 kHz mono WAV with a bundled ffmpeg, and transcribed by whisper.cpp on the GPU (~2–4 min
per audio hour on an M2 Max).

**Claude backend.** One pass, no chunking: even a three-hour episode is ~50k tokens, well inside
the context window. Output is constrained by a JSON schema. Server-side refusal fallbacks are
enabled, since Claude's safety classifiers occasionally decline benign true-crime or infosec
episodes — remove `betas`/`fallbacks` in `summarize-claude.js` if you'd rather not use them.

**Mistral (remote) backend.** Also one pass — Mistral Large's 128k context covers even long
episodes — via a plain `fetch` to the hosted API (no SDK dependency), using the same
`response_format: json_schema` structured-output contract as the local backend.

**Local backend.** `llama-server` is spawned lazily, kept warm between jobs, and unloaded after
`LLAMA_IDLE_MINUTES`. The JSON schema is compiled to a GBNF grammar, so output is structurally
valid *by construction* rather than by hope. A transcript that fits the context window is
summarized in one pass; a longer one is mapped to per-segment notes and then reduced. Roughly
250 tokens per minute of speech, so 32k context covers about a 2-hour episode single-pass.

All three backends share `summary-schema.js`, so their output is directly comparable. Because
transcripts are cached, re-summarizing with a different backend costs one model call and no
re-transcription — the summary page has a **Re-run with…** button for exactly this.

**Jobs** run in-process through a serial FIFO queue (whisper and Mistral both saturate the GPU)
and stream progress over SSE, including local sub-steps like `Reading segment 3 of 6`. Any job
still marked running at boot is marked failed, since in-process work cannot survive a restart.

## Layout

```
src/
  server.js            express bootstrap, static hosting, restart recovery
  config.js            .env loading, paths, validation
  db.js                SQLite schema, additive migrations, queries
  queue.js             serial job worker
  routes/              search · shows · jobs (incl. SSE)
  services/
    itunes.js          iTunes Search API (no auth)
    podcastindex.js    Podcast Index (SHA-1 HMAC auth)
    feed.js            RSS fallback
    search.js          merge sources, resolve episodes
    audio.js           download + ffmpeg conversion
    transcribe.js      whisper-cli driver, SRT parsing
    summary-schema.js  shared output schema + prompts
    summarize.js       backend dispatcher
    summarize-claude.js
    summarize-mistral.js hosted Mistral API, single-pass
    summarize-local.js llama.cpp backend, map-reduce for long transcripts
    llamaServer.js     llama-server lifecycle, tokenizer, chat
    pipeline.js        stage machine + progress events
public/                vanilla frontend, no build step
vendor/llama.cpp       built locally, gitignored
data/                  SQLite db, audio cache, models (gitignored)
```

## API

| Method | Path | |
|---|---|---|
| GET | `/api/status` | config + which backends are usable |
| GET | `/api/search?q=` | merged show search |
| POST | `/api/shows` | persist a search result, return episodes |
| GET | `/api/shows/:id/episodes` | cached episodes (`?refresh=1` to refetch) |
| POST | `/api/jobs` | `{episodeId, backend?}` → start or rejoin a job |
| GET | `/api/jobs/:id` | status snapshot |
| GET | `/api/jobs/:id/events` | SSE progress stream |
| GET | `/api/episodes/:id/summary` | latest summary |
| GET | `/api/episodes/:id/summaries` | every summary, for comparing backends |
| GET | `/api/episodes/:id/transcript` | raw transcript text |
| GET | `/api/library` | everything summarized so far |
| DELETE | `/api/episodes/:id/audio` | purge cached media |

## Troubleshooting

**Transcription or summarization is very slow.** Metal isn't active. Check
`vendor/llama.cpp/build/bin/llama-server --list-devices` lists your GPU, and watch the server
log for `ggml_metal_init` on the first transcription. If it's CPU-only, `which cmake` is
probably pointing at the Intel Homebrew — fix the PATH and rebuild.

**`whisper-cli not built` / `llama-server not built`.** Run the build commands above.

**Restarting the server doesn't pick up `.env` changes.** Don't stop it with
`pkill -f "node src/server.js"` — that pattern also matches the shell wrapper whose command
line contains it, so pkill can kill the wrong process and leave the server running. Use
`lsof -nP -iTCP:4300 -sTCP:LISTEN` to find the real PID.

**A stale `llama-server` is already on the port.** The app detects it, adopts it, logs the
mismatch, and sizes prompts against the *running* context window rather than the configured
one. To start clean: `pkill -9 -f llama-server`.

**Costs.** Claude is roughly $0.10–0.20 per episode; token counts are recorded on every summary.
Mistral's hosted API is billed separately (see [mistral.ai/pricing](https://mistral.ai/pricing));
local and transcription are free.
