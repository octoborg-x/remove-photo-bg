#!/usr/bin/env python3
"""Fetch the Phase 1 evaluation set (spec §6-Phase1.3).

Real images only, never used for training or tuning. Drawn from the same
licence-gated sources as the training set but from *disjoint* Commons
categories, written to a separate manifest (``data/eval-manifest.csv``) with
``split == "test"`` so the training split can never contain them. Images live
in their own directory (``data/eval-images/``) so there is no sha collision
with training.

Coverage targets (spec §6-Phase1.3): plain-background product, hair, fur,
glass/translucent, clutter, thin structures/holes, low contrast, small
subject, hard shadows. The 3 existing ``test-images/`` are added by the
evaluate step, not here.

Usage:
    python3 scripts/distill/fetch-eval.py --per-category 15
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
import time
from datetime import date
from pathlib import Path

from _bootstrap import *  # noqa: F401, E402  (sys.path fix; MUST precede 3rd-party)
from PIL import Image  # noqa: E402
from scripts.distill.commons_api import (  # noqa: E402
    _empty_info, _get, category_files, file_info_batch, is_approved)
from scripts.distill.image_ops import normalize_image  # noqa: E402
from scripts.distill.manifest_io import ManifestWriter  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
IMGDIR = DATA / "eval-images"
LOGDIR = DATA / "fetcher-logs"
MANIFEST = DATA / "eval-manifest.csv"

EXCLUDED_CATEGORY_HINTS = ("porn", "nude", "esoteric", "sexual")

# Coverage-driven categories, deliberately disjoint from fetch-cc0.py's.
EVAL_SOURCES = {
    # Plain-background product: CC0/PD-heavy isolation categories first; the
    # branded/commercial categories below are mostly CC-BY(-SA) and rarely pass.
    "product": ["Category:Household objects", "Category:Tools",
                "Category:Packaging", "Category:White background",
                "Category:Perfume bottles", "Category:Cosmetics containers",
                "Category:Footwear by brand", "Category:Teapots",
                "Category:Camera equipment"],
    "hair": ["Category:Human hair", "Category:Hair (anatomy)"],
    "fur": ["Category:Fur coats", "Category:Animal hair", "Category:Furs",
            "Category:Fox fur", "Category:Animal fur", "Category:Fur clothing"],
    "glass": ["Category:Drinking glasses", "Category:Glassware",
              "Category:Transparent materials"],
    "clutter": ["Category:Clutter", "Category:Desks"],
    "thin": ["Category:Branches", "Category:Wire",
             "Category:Sieves", "Category:Spider webs"],
    "lowcontrast": ["Category:Snow", "Category:Fog", "Category:Sand"],
    "small": ["Category:Miniature objects", "Category:Insects",
              "Category:Stamps"],
    "shadow": ["Category:Shadows", "Category:Shadow puppets"],
}

HEADERS_CSV = ["id", "source", "url", "licence", "licence_url", "author",
               "attribution_text", "date_checked", "sha256", "width", "height",
               "category", "tier", "split", "reject_reason"]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-category", type=int, default=15)
    ap.add_argument("--manifest", type=Path, default=MANIFEST)
    args = ap.parse_args()

    IMGDIR.mkdir(parents=True, exist_ok=True)
    LOGDIR.mkdir(parents=True, exist_ok=True)

    rows: list[dict] = []
    seen: set[str] = set()
    if args.manifest.exists():
        with open(args.manifest) as f:
            for r in csv.DictReader(f):
                if r.get("sha256"):
                    rows.append(r)
                    seen.add(r["sha256"])

    log = {"date": str(date.today()), "kind": "eval",
           "fetches": [], "rejections": []}
    writer = ManifestWriter(args.manifest, HEADERS_CSV, rows)

    for cat, sources in EVAL_SOURCES.items():
        got = 0
        for source in sources:
            if got >= args.per_category:
                break
            titles = [t for t in category_files(source, args.per_category * 8)
                      if not any(k in t.lower() for k in EXCLUDED_CATEGORY_HINTS)]
            infos = file_info_batch(titles)
            for title in titles:
                if got >= args.per_category:
                    break
                info = infos.get(title) or _empty_info(title)
                if not info["mime"].startswith("image/"):
                    continue
                if info["mime"] in ("image/svg+xml", "image/tiff"):
                    continue
                if not is_approved(info["licence"]):
                    log["rejections"].append(
                        {"title": title, "licence": info["licence"],
                         "reject_reason": f"licence={info['licence']!r}"})
                    continue
                try:
                    r = _get(info["url"])
                    tmp = IMGDIR / "tmp_dl.bin"
                    tmp.write_bytes(r.content)
                    h = sha256_file(tmp)
                    if h in seen:
                        tmp.unlink(missing_ok=True)
                        log["fetches"].append({"url": info["url"], "status": "dup"})
                        continue
                    dst = IMGDIR / f"{h}.jpg"
                    tmp.rename(dst)
                    try:
                        normalize_image(dst)
                    except Exception:
                        dst.unlink(missing_ok=True)
                        log["rejections"].append({"url": info["url"],
                                                  "reject_reason": "too-large"})
                        continue
                    with Image.open(dst) as im:
                        w, hh = im.size
                    row = {
                        "id": f"eval-{cat}-{h[:10]}", "source": "wikimedia-commons",
                        "url": info["url"],
                        "licence": info["licence_name"] or info["licence"],
                        "licence_url": info["licence_url"], "author": info["author"],
                        "attribution_text": info["page"],
                        "date_checked": str(date.today()), "sha256": h,
                        "width": w, "height": hh, "category": cat, "tier": "",
                        "split": "test", "reject_reason": "",
                    }
                    rows.append(row)
                    seen.add(h)
                    got += 1
                    log["fetches"].append({"url": info["url"], "status": "ok",
                                           "sha256": h, "category": cat})
                    writer.mark()
                    writer.maybe_flush()
                    time.sleep(0.2)
                except Exception as ex:
                    log["fetches"].append({"url": info["url"], "status": "error",
                                           "err": str(ex)})

    writer.flush()
    (LOGDIR / f"eval-{date.today()}.json").write_text(json.dumps(log, indent=2))

    ok = len([x for x in log["fetches"] if x["status"] == "ok"])
    print(f"eval manifest: {len(rows)} rows | this run: {ok} ok, "
          f"{len(log['rejections'])} rejected")
    print(f"eval manifest -> {args.manifest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
