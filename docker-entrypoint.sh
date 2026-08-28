#!/bin/sh
set -e

MODEL_FILE="ggml-${WHISPER_MODEL:-large-v3-turbo}.bin"
MODEL_PATH="/app/data/models/$MODEL_FILE"
WHISPER_MODELS_DIR="/app/node_modules/nodejs-whisper/cpp/whisper.cpp/models"

mkdir -p /app/data/models /app/data/audio "$WHISPER_MODELS_DIR"

if [ ! -f "$MODEL_PATH" ]; then
    echo "Downloading whisper model $MODEL_FILE ..."
    curl -fL -o "$MODEL_PATH" \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_FILE"
fi

# Recreated every start: node_modules (and the models/ dir inside it) comes from the
# image, not the volume, so a fresh container needs this even if the model itself
# was already downloaded on a previous run.
ln -sf "$MODEL_PATH" "$WHISPER_MODELS_DIR/$MODEL_FILE"

exec "$@"
