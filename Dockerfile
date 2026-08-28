# Built for a NAS/Linux x86_64 target — CPU only, no Metal, no GPU. Local Mistral
# (llama.cpp) is deliberately not built here: without a GPU it isn't practical, so
# this image only ever summarizes via the Claude/Mistral remote backends.

# ---------------------------------------------------------- build (compile whisper.cpp)
FROM node:22-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
        cmake build-essential git python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# nodejs-whisper vendors the whisper.cpp source tree in node_modules; compile it here,
# same as the local dev setup, minus every Metal-specific flag.
RUN cd node_modules/nodejs-whisper/cpp/whisper.cpp && \
    cmake -B build -DCMAKE_BUILD_TYPE=Release \
          -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON && \
    cmake --build build --config Release -j"$(nproc)"

# --------------------------------------------------------------------------- runtime
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .

# Downloads the whisper model into the data/ volume (once, persisted) and symlinks it
# into node_modules — node_modules is rebuilt fresh on every image build, the volume isn't.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 4300
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
