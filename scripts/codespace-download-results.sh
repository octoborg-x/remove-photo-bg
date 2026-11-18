#!/usr/bin/env bash
#
# Package an eval run produced in a GitHub Codespace and download it.
#
# Usage (inside the Codespace):
#   bash scripts/codespace-download-results.sh                 # eval-results/wasm
#   bash scripts/codespace-download-results.sh eval-results/colab-webgpu
#   bash scripts/codespace-download-results.sh --serve         # + browser link
#
# The eval output dir (see run-eval.mjs) holds outputs/<id>.png plus report.json.
# This zips that directory and gives you two ways to get it onto your machine:
#
#   1. `gh codespace cp`  — run the printed command on your LAPTOP (needs gh).
#   2. --serve            — starts a tiny HTTP server on a forwarded port and
#                           prints the https://<codespace>-<port>... URL to
#                           open in your browser.
#
# No `zip` binary is required: the archive is built with python3's shutil.
set -euo pipefail

RUN_DIR="eval-results/wasm"
SERVE=0
PORT=8000

while [[ $# -gt 0 ]]; do
  case "$1" in
    --serve) SERVE=1; shift ;;
    --port) PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) RUN_DIR="$1"; shift ;;
  esac
done

if [[ ! -f package.json ]] || [[ ! -d scripts/eval ]]; then
  echo "Run this from the repository root (package.json + scripts/eval not found)." >&2
  exit 1
fi

if [[ ! -d "$RUN_DIR" ]]; then
  echo "No results directory: $RUN_DIR" >&2
  echo "Run the eval first, e.g.  npm run eval:run -- --provider wasm --out $RUN_DIR" >&2
  exit 1
fi

NAME="$(basename "$RUN_DIR")"
ZIP="$(pwd)/eval-results-${NAME}.zip"

echo "Packaging $RUN_DIR -> $ZIP"
python3 - "$RUN_DIR" "$ZIP" <<'PY'
import os, sys, shutil
src, zip_path = sys.argv[1], sys.argv[2]
if os.path.exists(zip_path):
    os.remove(zip_path)
shutil.make_archive(zip_path[:-4], 'zip', src)  # strips the .zip suffix itself
n = sum(len(files) for _, _, files in os.walk(src))
print(f"  {n} file(s) archived, {os.path.getsize(zip_path)} bytes")
PY

# Codespaces inject these; used for the browser link and the gh one-liner.
CS_NAME="${CODESPACE_NAME:-}"
CS_DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"

echo
echo "Download it with any of:"
if [[ -n "$CS_NAME" ]]; then
  echo "  # from your LAPTOP (not this Codespace):"
  echo "  gh codespace cp -e \"remote:$ZIP\" -e \"local:./\""
else
  echo "  # (not inside a Codespace: no \$CODESPACE_NAME; use the file explorer"
  echo "  #  to right-click -> Download, or copy it yourself)"
fi
echo "  # VS Code web: right-click eval-results-${NAME}.zip in the Explorer -> Download"

if [[ "$SERVE" == "1" ]]; then
  echo
  if [[ -n "$CS_NAME" ]]; then
    URL="https://${CS_NAME}-${PORT}.${CS_DOMAIN}/eval-results-${NAME}.zip"
    echo "Serving on port ${PORT}. Open this (make the port Public if asked):"
    echo "  $URL"
  else
    echo "Serving on port ${PORT}: http://localhost:${PORT}/eval-results-${NAME}.zip"
  fi
  echo "Press Ctrl+C to stop."
  exec python3 -m http.server "$PORT" --bind 0.0.0.0
fi
