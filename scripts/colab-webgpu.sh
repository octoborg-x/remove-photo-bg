#!/usr/bin/env bash
#
# Run the WebGPU evaluation on a Google Colab GPU runtime (a free T4).
#
# This is "variant B": the whole test runs on Colab — the app is built and served
# locally there, and Chromium runs on the same machine, so it can actually reach
# the GPU. A tunnel from a GPU-less machine cannot work for this: WebGPU uses the
# *browser's* local GPU, so the browser must run where the GPU is.
#
# Usage (from the repository root, in a Colab cell):
#   !bash scripts/colab-webgpu.sh                      # full 64-image sweep
#   !bash scripts/colab-webgpu.sh --only accessory     # one category
#   !bash scripts/colab-webgpu.sh --provider wasm      # CPU cross-check
#
# Colab prerequisites: Runtime → Change runtime type → T4 GPU.
#
# Why the flags below: headless Chrome disables the GPU by default, and on Linux
# WebGPU is behind a flag. The Chrome team's guide
# (https://developer.chrome.com/blog/supercharge-web-ai-testing) is authoritative:
# the harness adds --use-angle=vulkan --enable-features=Vulkan
# --disable-vulkan-surface --enable-unsafe-webgpu and uses the new headless mode
# when RUN_GPU=1 (see scripts/lib/gpu-browser.mjs). This script's job is to make
# the GPU *visible* to Chrome by installing the matching NVIDIA driver.
set -euo pipefail

PROVIDER="webgpu"
OUT="eval-results/colab-${PROVIDER}"
PASSTHRU=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider) PROVIDER="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) PASSTHRU+=("$1"); shift ;;
  esac
done

log() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

if [[ ! -f package.json ]] || [[ ! -d scripts/eval ]]; then
  echo "Run this from the repository root (package.json + scripts/eval not found)." >&2
  exit 1
fi

# 1. Confirm a GPU is present and is not a software renderer.
log "GPU check"
if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "nvidia-smi not found — this runtime has no GPU. In Colab: Runtime → Change runtime type → T4 GPU." >&2
  exit 1
fi
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader

# 2. Install the matching NVIDIA GL/Vulkan driver. Colab's default userspace GL
#    driver makes Chrome fall back to SwiftShader (software), where WebGPU is
#    "available" but unusable — the exact trap the Chrome guide documents. The
#    driver major version must match the kernel module, so derive it from
#    nvidia-smi rather than hard-coding one (the guide's example used 525).
log "Install GPU drivers + Vulkan tools"
DRIVER_MAJOR="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -n1 | cut -d. -f1)"
apt-get update -qq
if ! apt-get install -y -qq "libnvidia-gl-${DRIVER_MAJOR}" vulkan-tools; then
  echo "libnvidia-gl-${DRIVER_MAJOR} unavailable; falling back to the guide's 525." >&2
  apt-get install -y -qq libnvidia-gl-525 vulkan-tools
fi

# 3. Verify Vulkan now sees the real GPU (not SwiftShader). This is the check the
#    Chrome guide uses to confirm the driver fix actually took effect.
log "Vulkan device (must name the NVIDIA GPU, not SwiftShader)"
vulkaninfo --summary 2>/dev/null | grep -iE "deviceName|driverName|deviceType" || vulkaninfo | grep -iE "deviceName" | head -3

# 4. Install a real Chrome (Colab's Chromium may be a snap shim / absent). Chrome
#    for Testing matches the CI setup and is what puppeteer-core drives.
log "Install Chrome"
if [[ -z "${CHROME_BIN:-}" ]]; then
  if command -v google-chrome-stable >/dev/null 2>&1; then
    export CHROME_BIN="$(command -v google-chrome-stable)"
  else
    wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    apt-get install -y -qq /tmp/chrome.deb
    export CHROME_BIN="$(command -v google-chrome-stable)"
  fi
fi
echo "CHROME_BIN=$CHROME_BIN"
"$CHROME_BIN" --version

# 5. Node deps, the WebGPU-capable ORT runtime, and the production build. The
#    --webgpu fetch copies ort.all.min.js + the jsep wasm, which the app probes
#    for before it will offer the GPU path (see provider-gate.ts).
log "npm ci"
npm ci --no-audit --no-fund

log "fetch models + WebGPU runtime"
npm run fetch-models -- --webgpu

log "build"
npm run build

# 6. Run the evaluation. run-eval.mjs serves dist/ with `vite preview` on a
#    private port (COOP/COEP headers included), so no manual server is needed.
#    RUN_GPU=1 selects the new headless mode + Vulkan flags; the harness fails
#    loudly if the adapter turns out to be software.
log "eval:run ($PROVIDER)"
RUN_GPU=1 CHROME_BIN="$CHROME_BIN" npm run eval:run -- --provider "$PROVIDER" --out "$OUT" "${PASSTHRU[@]}"

log "Done"
echo "Results: $OUT/report.json"
