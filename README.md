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
place. With `SUMMARIZER=claude` or `SUMMARIZER=mistral`, missing the matching API key
(`ANTHROPIC_API_KEY` or `MISTRAL_API_KEY`) only logs a warning at boot, not a hard failure —
per-user API keys (see Authentication below) mean a deployment can run entirely on BYOK with no
shared key at all. `ENCRYPTION_KEY` is the one setting that's always required; the server won't
boot without it.

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
| `ANTHROPIC_API_KEY` | no | Only needed if `SUMMARIZER=claude` and you want a shared/default key (see "Per-user API keys" below). Missing or still the `.env.example` placeholder just logs a boot warning, not a failure. |
| `MISTRAL_API_KEY` | no | Same as `ANTHROPIC_API_KEY`, for `SUMMARIZER=mistral`. Get one at [console.mistral.ai](https://console.mistral.ai/api-keys). |
| `MISTRAL_MODEL` | no | Default `mistral-large-latest`. |
| `PODCASTINDEX_KEY` / `_SECRET` | no | Free from [podcastindex.org/api](https://podcastindex.org/api). Adds episode-level search and surfaces free publisher transcripts. Without it, iTunes only. |
| `PORT` | no | Default `4300` — avoids the Firebase emulators (4000/5002/5003/9099/9199) and CRA (3000). |
| `WHISPER_MODEL` | no | Default `large-v3-turbo`. `base`/`small` are much faster for testing. |
| `WHISPER_REMOTE_URL` | no | Delegate transcription to a whisper server on another machine with a real GPU — see "Remote transcription" below. Blank means transcribe locally. |
| `LOCAL_MODEL_FILE` | no | GGUF in `data/models/`. |
| `LLAMA_CONTEXT` | no | Default `32768`. |
| `LLAMA_IDLE_MINUTES` | no | Unload the 13 GB model after N idle minutes. `0` keeps it resident. |
| `ITUNES_COUNTRY` | no | Search storefront. Default `fr`. |
| `SESSION_TTL_DAYS` | no | How long a login lasts. Default `30`. |
| `COOKIE_SECURE` | no | Set to `true` once a reverse proxy in front of the app terminates HTTPS — see Authentication below. |
| `ENCRYPTION_KEY` | **yes** | 32 bytes of hex, encrypts each user's own Claude/Mistral key at rest. Boot fails without it. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

You can also pick a backend per run from the UI, or per request:
`POST /api/jobs {"episodeId": 42, "backend": "local"}`.

**Summary detail level.** Every summary is generated at one of three levels — `brief`,
`standard` (default) or `detailed` — which only changes how much the model writes (chapter
count, sentences per chapter, how many key points/quotes to include), never the JSON shape, so
levels stay directly comparable the same way backends do. Set your default from `#/account`
(`PUT /api/account/summary-level`), or override it for one run from the UI picker or
`POST /api/jobs {"episodeId": 42, "level": "detailed"}`.

## Authentication

Every `/api/*` route except `/api/status`, `/api/login`, `/api/logout` and `/api/session`
requires a logged-in session — there's no public signup, since this is meant for you and
people you personally invite, not the open internet.

Create accounts from the command line:

```bash
npm run users -- add alice              # prompts for a password
npm run users -- list                   # shows each user's plan too
npm run users -- remove alice
npm run users -- set-plan alice premium # see "Per-user API keys" below
```

With **zero users**, nobody — including you — can log in; create at least one before relying
on this. Sessions are opaque random tokens stored in SQLite (not JWTs, nothing to sign), so
they survive a server restart, and `COOKIE_SECURE=false` (the default) is what lets the login
cookie work over plain HTTP on a LAN or through a private network like Tailscale — flip it to
`true` only once you actually have TLS in front of the app, or the cookie won't be sent at all.

**Per-user API keys, and the free/premium split.** Every account is `free` by default — there
is no billing system yet, so this is set by hand with `set-plan`. A `free` user must set their
own Claude/Mistral key from `#/account` to use that backend at all; the server's shared `.env`
key is off-limits to them. A `premium` user may still set their own key, but if they haven't,
they fall back to the server's key. This is enforced in `resolveApiKey()` (`pipeline.js`) —
checked once at job creation (`POST /api/jobs`, so a doomed job never burns minutes of whisper
time before failing) and again right before the model call, as a safety net. `/api/status`'s
backend flags mirror the same rule, so the picker never offers a backend that would just be
rejected. The `local` backend has no key concept at all and is never plan-restricted.

Keys are AES-256-GCM encrypted at rest with `ENCRYPTION_KEY` and never sent back to the browser
once saved — `GET /api/account` only reports whether one is set. That encryption protects the
key from anyone who gets hold of the SQLite file; it does **not** protect it from this server's
own process, which must decrypt it to make the API call on the user's behalf — that limit is
inherent to any server-side BYOK design, not something more encryption fixes. Tell anyone using
their own key to generate a dedicated, spend-capped key from their own provider dashboard
rather than handing over their main one.

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

All three backends share `summary-schema.js`, so their output is directly comparable — the same
holds across the three detail levels, since a level only tunes the prompt/schema descriptions
(how much to write), not the fields themselves. Because transcripts are cached, re-summarizing
with a different backend or level costs one model call and no re-transcription — the summary
page has a **Re-run with…** button for exactly this.

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
  routes/
    auth.js            login · logout · session
    account.js         per-user Claude/Mistral key storage
    search.js · shows.js · jobs.js (incl. SSE)
  services/
    auth.js            password hashing, session tokens, key encryption
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
scripts/
  manage-users.js      CLI: add/list/remove logins (npm run users -- ...)
  whisper-server.js    thin HTTP wrapper around transcribeLocal(), for a remote GPU machine
public/                vanilla frontend, no build step
vendor/llama.cpp       built locally, gitignored
data/                  SQLite db, audio cache, models (gitignored)
Dockerfile, docker-compose.yml, docker-entrypoint.sh
                       CPU-only NAS/Linux deployment — see "Deploying with Docker" below
```

## API

| Method | Path | |
|---|---|---|
| POST | `/api/login` | `{username, password}` → sets the session cookie |
| POST | `/api/logout` | clears the session |
| GET | `/api/session` | `{authenticated, username}` — always 200 |
| GET | `/api/status` | config + which backends are usable (includes the caller's own keys) |
| GET | `/api/account` | `{username, plan, claudeKeySet, mistralKeySet, summaryLevel}` — requires login |
| PUT | `/api/account/keys` | `{claudeApiKey?, mistralApiKey?}` — set/clear your own keys; `""` clears |
| PUT | `/api/account/summary-level` | `{level}` → set your default detail level (`brief`\|`standard`\|`detailed`) |
| GET | `/api/search?q=` | merged show search — requires login |
| POST | `/api/shows` | persist a search result, return episodes |
| GET | `/api/shows/:id/episodes` | cached episodes (`?refresh=1` to refetch) |
| POST | `/api/jobs` | `{episodeId, backend?, level?}` → start or rejoin a job; `403` if the backend needs a key this user can't use |
| GET | `/api/jobs/:id` | status snapshot |
| GET | `/api/jobs/:id/events` | SSE progress stream |
| GET | `/api/episodes/:id/summary` | latest summary |
| GET | `/api/episodes/:id/summaries` | every summary, for comparing backends |
| GET | `/api/episodes/:id/transcript` | raw transcript text |
| GET | `/api/library` | everything summarized so far |
| DELETE | `/api/episodes/:id/audio` | purge cached media |

## Deploying with Docker (e.g. a NAS)

`Dockerfile` + `docker-compose.yml` target a headless Linux x86_64 box with no GPU — a QNAP/
Synology NAS via Container Station/Container Manager, or any small Linux server. This is a
CPU-only build: no Metal (that's Apple-only) and no llama.cpp/local Mistral (not practical
without a GPU — a 24B model on a NAS CPU would be painfully slow). Set `SUMMARIZER=claude` or
`SUMMARIZER=mistral`; `local` will just show as unavailable, the same graceful degradation as
a missing API key.

```bash
cp .env.example .env
# Edit .env for this deployment specifically — do not reuse your dev machine's file:
#   - a FRESH ENCRYPTION_KEY (never reuse one from another deployment) — this one's
#     required, the app won't boot without it
#   - SUMMARIZER=claude or mistral, never local. The matching API key is optional —
#     boots fine without it (just a log warning) if every user brings their own via
#     #/account; only needed here if you want a shared/default key too
#   - consider a smaller WHISPER_MODEL (base/small) — CPU transcription is much
#     slower than Metal, and this trades accuracy for speed

sudo docker compose up -d --build
sudo docker compose exec podcast-summarizer npm run users -- add <yourname>   # first login
```

`data/` is a bind-mounted volume (SQLite DB, audio cache, downloaded models), so it survives
`docker compose up --build` rebuilds. The whisper model itself is downloaded once into
`data/models/` by `docker-entrypoint.sh` on first start (idempotent — skipped if already
present) and symlinked into `node_modules` on every start, since `node_modules` comes from the
image and is rebuilt fresh each time, unlike the volume.

This app has no authentication-free public signup by design (see Authentication above) — a
Docker deployment doesn't change that. Exposing the container to the actual internet still
needs its own answer (a VPN/Tailscale, or a reverse proxy with its own TLS) independent of
Container Station's port mapping, which only controls reachability on your LAN.

### Exposing this to the internet with Caddy

`docker-compose.yml` includes a `caddy` service and a `Caddyfile` for this. Caddy terminates
TLS with a free, auto-renewing Let's Encrypt certificate and reverse-proxies to the app over
the internal Docker network — the app container itself no longer publishes port 4300 to the
host, so Caddy is the only way in.

1. **A domain or Dynamic DNS hostname pointing at your router's public IP.** Residential IPs
   (Livebox included) are usually dynamic, so a free DDNS hostname (e.g. DuckDNS, No-IP, or
   your router's own built-in DDNS client if it has one) is the easy option unless you already
   own a domain. Edit the hostname in `Caddyfile` to match yours.
2. **Router port forwarding: 80 and 443 → the NAS, not 4300.** Caddy needs 80 for the
   Let's Encrypt HTTP-01 challenge (issuance *and* renewal — don't forward only 443) and 443
   for HTTPS itself. Remove any old forward that pointed straight at 4300.
3. **Set `COOKIE_SECURE=true`** in the NAS's `.env` once this is up — the session cookie is
   marked `Secure` as a static flag, not derived per-request, so this only becomes correct
   once Caddy (TLS) really is the only entry point. Leaving `4300:4300` published *and* setting
   this to `true` would be the worst of both: still bypassable in plaintext, and login broken
   for anyone still using the old `http://<nas-ip>:4300` link.
4. `sudo docker compose up -d --build` to pick up both changes.

LAN devices reach the same hostname too, as long as the router supports NAT hairpin/loopback
(most consumer routers do) — internal traffic to the public domain gets routed back to the NAS
without leaving the LAN. If it doesn't, `http://<nas-ip>:4300` is gone now (no longer
published), so the fallback is pointing that hostname at the NAS's LAN IP in the router's own
DNS/local overrides instead.

### Updating

Pull the latest code, then rebuild — `data/` and `.env` are both untouched either way, since
neither is tracked by git:

```bash
cd /path/to/podcast-summarizer   # wherever you cloned it
git pull
sudo docker compose up -d --build
```

If git isn't installed on the NAS itself (true of stock QNAP QTS — see below), do the `pull`
as a disposable container instead of installing anything system-wide: create a container from
the small `alpine/git` image, mount the project folder to `/git`, restart policy **never**,
command `-C /git pull`. Run it once — it should exit immediately with code `0`. The *initial*
clone works the same way, just with `clone <repo-url> /git` as the command instead of `pull`.

**Stop this container after use instead of deleting it** — Container Station keeps its full
config (image, volume, command, env vars) while stopped, so a future update is just "Start" on
the same container instead of recreating it from scratch. `git pull` is a harmless no-op to
re-run when there's nothing new.

Git refuses to operate on a bind-mounted directory owned by a different user than the
container's (`fatal: detected dubious ownership in repository at '/git'`) — expect this on the
very first run. Fix it with environment variables on the same container, rather than trying to
chain a second command through `alpine/git`'s fixed `git` entrypoint:

```
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=safe.directory
GIT_CONFIG_VALUE_0=*
```

### Stopping a stuck job

There's no in-app cancel button. On CPU-only hardware, whisper can legitimately take hours
(see Troubleshooting below) — if you want to abandon a run rather than wait it out:

```bash
sudo docker compose restart podcast-summarizer
```

This is safe, not a workaround: jobs run in-process and are documented as unable to survive a
restart (see **Jobs** under "How it works" below) — anything still marked running when the
server boots is automatically marked failed. Restarting the container is the same recovery
path a crash would trigger, just on purpose. The episode goes back to showing a "Try again" /
"Summarize" button afterward.

### Real-world NAS deployment notes

A few things that came up doing this for real on a QNAP TS-464, worth knowing ahead of time
rather than rediscovering:

- **Container Station's "select a compose file, preview it, Create" import flow stages the
  file into a temporary directory** and doesn't carry along sibling files from the real
  project folder. Since our compose file uses both `build: .` and `env_file: .env`, that
  import path fails validation (`env file /tmp/.env not found`) before it ever gets to
  building. Run `docker compose up -d --build` directly over SSH instead — it resolves
  relative paths against the real filesystem, so both work correctly with zero file changes.
- **`docker compose` needs `sudo`** in a stock QTS SSH session — the CLI doesn't have the
  Docker socket access that Container Station itself uses internally as a privileged service.
- **A stale or drifting NAS clock breaks the build** with a cryptic `apt-get` failure
  (`E: Release file ... is not valid yet (invalid for another Nmin)`). If the build fails at
  the `apt-get update` step, check NTP time sync is actually enabled *and working* (Control
  Panel → General Settings → Time) before looking anywhere else — this isn't a network or
  Dockerfile problem, it's the system clock being wrong.
- **A missing `ANTHROPIC_API_KEY`/`MISTRAL_API_KEY` for the configured `SUMMARIZER` no longer
  blocks boot** (see Configuration above) — but on an older copy of the code, it did, and the
  container would crash-loop under `restart: unless-stopped`. That looks confusingly like a
  networking problem: `docker compose ps` can catch it mid-restart and show `Up`, while
  `curl localhost:<port>` still refuses because nothing actually stayed up long enough to
  bind. If you see that combination, `docker compose logs` is the fastest way to the real
  cause, not the port/network settings.
- **`whisper-cli: error while loading shared libraries: libgomp.so.1: cannot open shared
  object file`** the first time you actually transcribe something. The multi-stage build
  compiles `whisper-cli` with a full `build-essential` toolchain (which pulls in OpenMP), but
  the runtime stage only installed `curl`/`ca-certificates` — the binary needs `libgomp1` at
  runtime just to start, and it isn't there. Fixed in the Dockerfile now; if this recurs after
  changing build flags, `ldd` the compiled binary to see everything it actually links against.

## Remote transcription (for CPU-only hosts)

A NAS with no GPU can transcribe, but slowly — even `WHISPER_MODEL=small` can take a very long
time on a weak CPU. If you have another machine on the same LAN with a real GPU (Metal or
CUDA) — a Mac, say — you can delegate just the transcription step to it instead, while
everything else (search, the DB, summarization, the UI) keeps running on the NAS.

**On the GPU machine**, with whisper.cpp already built there (see the setup steps at the top
of this README):

```bash
npm run whisper-server   # listens on WHISPER_SERVER_PORT, default 4301
```

This reuses the exact same `transcribeLocal()` used everywhere else in the app — it's a thin
HTTP wrapper, not a separate implementation — so it stays in sync with the local path
automatically and uses whatever `WHISPER_MODEL` that machine's own `.env` is already set to.

**On the NAS**, point at it:

```
WHISPER_REMOTE_URL=http://<gpu-machine-ip>:4301
```

That's the only change needed — `pipeline.js` picks the remote path automatically whenever
this is set, with no other config.

**No fallback, by design.** If the GPU machine is asleep or unreachable, the job fails
immediately with a clear error ("is that machine awake and on the network?") rather than
quietly falling back to slow local CPU transcription — a fast, honest failure beats a
multi-hour surprise. There's a quick reachability check before the (large) audio download even
starts, so an unreachable machine fails in seconds, not after downloading and converting the
whole episode first.

**No authentication** on the whisper server — same trust model as `llama-server`'s local port.
Only run this on a trusted home LAN, never expose that port to the internet.

**The GPU machine needs to actually be awake and reachable** whenever you want to transcribe
something new — everything else in the app (browsing, search, re-summarizing already-
transcribed episodes) keeps working via the NAS regardless. If it sleeps, Wake-on-LAN is
possible in principle but unreliable on laptops in particular (lid closed, on battery); the
simplest fix if this matters to you is just disabling sleep on that machine while it's home
and plugged in.

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
