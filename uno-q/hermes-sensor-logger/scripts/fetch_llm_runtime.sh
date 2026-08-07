#!/bin/bash
# Runs on the Uno Q's Linux host (not inside the App Lab container, which has
# no curl/tar/gcc -- see docs/ONDEVICE_ACTIVITY.md). Fetches the on-device
# activity-inference model and BOTH llama.cpp runtimes (CPU-only and
# Vulkan, the latter for the confirmed Turnip Adreno 702 GPU) into
# runtime/, which is bind-mounted into the app container as /app/runtime.
#
# Not run automatically -- deliberately a one-off provisioning step (same
# category as `python mcp-tools/scripts/enroll.py` for face-cpu): re-run
# after a factory reset or to pick up a newer llama.cpp build. Nothing here
# is committed to git (runtime/ is gitignored) -- same reasoning as the
# face-cpu ONNX models: large, rebuildable, device-specific.
#
# Usage: bash fetch_llm_runtime.sh   (run via `adb shell`, or push + exec)

set -euo pipefail

APP_DIR="/home/arduino/ArduinoApps/hermes-sensor-logger"
RUNTIME_DIR="$APP_DIR/runtime"
LLAMA_TAG="${LLAMA_CPP_TAG:-b10298}"
MODEL_URL="https://huggingface.co/unsloth/SmolLM2-135M-Instruct-GGUF/resolve/main/SmolLM2-135M-Instruct-Q8_0.gguf"

mkdir -p "$RUNTIME_DIR/cpu" "$RUNTIME_DIR/vulkan"

echo "== model: SmolLM2-135M-Instruct Q8_0 =="
if [ ! -f "$RUNTIME_DIR/model.gguf" ]; then
  curl -fL --progress-bar -o "$RUNTIME_DIR/model.gguf.part" "$MODEL_URL"
  mv "$RUNTIME_DIR/model.gguf.part" "$RUNTIME_DIR/model.gguf"
else
  echo "already present, skipping"
fi

# Release layout is a single top-level dir (llama-<tag>/) holding every
# binary + shared lib flat -- no build/bin nesting. Confirmed by inspecting
# the b10298 tarball directly rather than assumed.
fetch_backend() {
  local variant="$1" # "" for CPU-only, "-vulkan" for the Vulkan build
  local dest="$2"
  local asset="llama-${LLAMA_TAG}-bin-ubuntu${variant}-arm64.tar.gz"
  local url="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${asset}"

  echo "== runtime: ${asset} =="
  if [ -x "$dest/llama" ]; then
    echo "already present, skipping"
    return
  fi
  curl -fL --progress-bar -o "/tmp/${asset}" "$url"
  # Strip the llama-<tag>/ top-level dir so binaries land directly in $dest.
  tar -xzf "/tmp/${asset}" -C "$dest" --strip-components=1
  rm -f "/tmp/${asset}"
  chmod +x "$dest"/llama* 2>/dev/null || true
}

fetch_backend "" "$RUNTIME_DIR/cpu"
fetch_backend "-vulkan" "$RUNTIME_DIR/vulkan"

echo "== done =="
du -sh "$RUNTIME_DIR"/* 2>/dev/null
echo "Verify the Vulkan build sees the Turnip device with:"
echo "  LD_LIBRARY_PATH=$RUNTIME_DIR/vulkan $RUNTIME_DIR/vulkan/llama --list-devices"
