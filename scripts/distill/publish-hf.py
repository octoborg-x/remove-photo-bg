#!/usr/bin/env python3
"""Upload the optimised ONNX artifacts to the Hugging Face model host.

The deployed service worker fetches models from
`https://huggingface.co/spaces/Octoborg/remove-photo-bg/resolve/main/models/*`,
so the files must land under `models/` in that space. This script is the only
place that writes them, and it verifies each local SHA-256 against the pin in
`scripts/fetch-models.mjs` before uploading, so the manifest and the host can
never disagree.

Requires HUGGINGFACE_API_TOKEN with write access to the space.

Usage:
    python3 scripts/distill/publish-hf.py --artifacts work/opt --dry-run
    python3 scripts/distill/publish-hf.py --artifacts work/opt
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from pathlib import Path

REPO_ID = "Octoborg/remove-photo-bg"
REPO_TYPE = "space"

# local file name -> remote path inside the space
UPLOADS = {
    "int8fp16_clean.onnx": "models/model_512_int8_fp16.onnx",
    "cand_fp16_clean.onnx": "models/model_512_int0_fp16.onnx",
    "cand_none.onnx": "models/model_512_int0_fp32.onnx",
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def pins_from_fetch_script(path: Path) -> dict[str, dict]:
    """Read the pinned size/sha256 for each artifact out of fetch-models.mjs."""
    text = path.read_text()
    pins = {}
    for block in re.finditer(
        r"file: 'models/(?P<file>[\w.]+)'[\s\S]*?size: (?P<size>\d+),\s*"
        r"sha256: '(?P<sha>[0-9a-f]{64})'",
        text,
    ):
        pins[f"models/{block['file']}"] = {
            "size": int(block["size"]),
            "sha256": block["sha"],
        }
    if not pins:
        raise SystemExit(f"no pins parsed from {path}")
    return pins


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--artifacts", type=Path, required=True,
                    help="directory holding the optimised .onnx files")
    ap.add_argument("--fetch-script", type=Path,
                    default=Path("scripts/fetch-models.mjs"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    pins = pins_from_fetch_script(args.fetch_script)
    token = os.environ.get("HUGGINGFACE_API_TOKEN")
    if not token and not args.dry_run:
        raise SystemExit("HUGGINGFACE_API_TOKEN is not set")

    plans = []
    for local_name, remote in UPLOADS.items():
        local = args.artifacts / local_name
        if not local.is_file():
            raise SystemExit(f"missing artifact: {local}")
        pin = pins.get(remote)
        if pin is None:
            raise SystemExit(f"{remote} is not pinned in {args.fetch_script}")
        size = local.stat().st_size
        digest = sha256(local)
        ok = size == pin["size"] and digest == pin["sha256"]
        print(f"{remote}\n  local  {size:>10} B  {digest}")
        print(f"  pinned {pin['size']:>10} B  {pin['sha256']}  "
              f"{'OK' if ok else 'MISMATCH'}")
        if not ok:
            raise SystemExit(f"{local} does not match its pin; refusing to upload")
        plans.append((local, remote))

    if args.dry_run:
        print("\ndry run: all artifacts match their pins, nothing uploaded")
        return

    from huggingface_hub import HfApi

    api = HfApi(token=token)
    for local, remote in plans:
        print(f"uploading {local.name} -> {REPO_ID}:{remote}")
        api.upload_file(
            path_or_fileobj=str(local),
            path_in_repo=remote,
            repo_id=REPO_ID,
            repo_type=REPO_TYPE,
            commit_message=f"Optimise model: strip debug metadata and duplicate "
                           f"initializers ({remote})",
        )
    print("\nuploaded:", ", ".join(r for _, r in plans))


if __name__ == "__main__":
    sys.exit(main())
