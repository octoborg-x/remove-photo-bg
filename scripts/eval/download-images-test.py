#!/usr/bin/env python3
"""Download the 64 raw eval images into images-test/.

Every image in `eval/manifest.json` is fetched from its pinned source URL. The
images that the shipped model fails on are written with an `error-` prefix, so a
single directory listing separates the ones that worked from the ones that did
not.

"Did not work" is the committed failure set — the 8 eval images behind the
"8/64" finding in `EVALUATION.md` (empty / near-empty / partial-subject
outputs). The ids are embedded in `FAILING_IDS`; when the failure gallery
(`artifacts/failed-inferences/manifest.json`) is present its non-synthetic eval
cases are used instead, so the two stay in sync. `--failing` overrides both.

Usage:
    python3 scripts/eval/download-images-test.py                 # all 64
    python3 scripts/eval/download-images-test.py --out images-test
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "eval" / "manifest.json"
GALLERY_PATH = ROOT / "artifacts" / "failed-inferences" / "manifest.json"
USER_AGENT = "remove-bg-photo-eval/1.0 (background-removal quality evaluation)"

# The 8 eval images the shipped model fails on — the empty / near-empty /
# partial-subject outputs behind the "8/64" finding in EVALUATION.md. Mirrors the
# non-synthetic eval cases in artifacts/failed-inferences/manifest.json (checked
# when that file is present).
FAILING_IDS = [
    "hair-fur-07",            # empty output
    "hair-fur-08",            # empty output
    "complex-bg-05",          # empty output
    "thin-structure-04",      # empty output
    "complex-bg-07",          # near-empty output
    "accessory-07",           # partial subject removal
    "hair-fur-06",            # partial subject removal
    "glass-transparent-06",   # partial subject removal
]


def gallery_failing_ids() -> list[str]:
    """Eval images the gallery records as failures (synthetic cases excluded)."""
    if not GALLERY_PATH.exists():
        return []
    gallery = json.loads(GALLERY_PATH.read_text())
    ids: list[str] = []
    for case in gallery["cases"]:
        if case.get("assetsSynthetic"):
            continue
        source = str(case.get("input", ""))
        if source.startswith("eval/images/"):
            ids.append(Path(source).stem)
    return sorted(set(ids))


def fetch_bytes(url: str, attempts: int = 5) -> bytes:
    for attempt in range(attempts):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as exc:
            if exc.code != 429 or attempt == attempts - 1:
                raise
            time.sleep(3 * (attempt + 1))
    raise RuntimeError("unreachable")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(ROOT / "images-test"))
    ap.add_argument("--manifest", default=str(MANIFEST_PATH))
    ap.add_argument(
        "--failing",
        default="gallery",
        help="'gallery' (default), 'embedded', or a comma-separated list of ids",
    )
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(Path(args.manifest).read_text())

    if args.failing == "gallery":
        failing = set(gallery_failing_ids() or FAILING_IDS)
    elif args.failing == "embedded":
        failing = set(FAILING_IDS)
    else:
        failing = {s.strip() for s in args.failing.split(",") if s.strip()}

    written: list[dict] = []
    for cat in manifest["categories"]:
        for img in cat["images"]:
            iid = img["id"]
            suffix = Path(urllib.parse.urlparse(img["download"]).path).suffix or ".jpg"
            prefix = "error-" if iid in failing else ""
            dest = out_dir / f"{prefix}{iid}{suffix}"
            if dest.exists():
                print(f"  = {dest.name}")
            else:
                data = fetch_bytes(img["download"])
                dest.write_bytes(data)
                time.sleep(2.0)  # be a good citizen; Wikimedia throttles bursts
                print(f"  + {dest.name} ({len(data)} bytes)")
            with Image.open(dest) as im:
                w, h = im.size
            written.append(
                {
                    "id": iid,
                    "file": dest.name,
                    "failed": iid in failing,
                    "width": w,
                    "height": h,
                    "bytes": dest.stat().st_size,
                    "sha256": hashlib.sha256(dest.read_bytes()).hexdigest(),
                    "source": img["download"],
                    "license": img.get("license", ""),
                    "page": img.get("page", ""),
                }
            )

    index = {
        "generatedBy": "scripts/eval/download-images-test.py",
        "total": len(written),
        "failed": sum(1 for w in written if w["failed"]),
        "failingIds": sorted(failing),
        "images": written,
    }
    (out_dir / "index.json").write_text(json.dumps(index, indent=2) + "\n")
    print(f"\n{len(written)} images -> {out_dir} ({index['failed']} prefixed 'error-')")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
