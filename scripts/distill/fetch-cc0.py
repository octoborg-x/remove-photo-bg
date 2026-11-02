#!/usr/bin/env python3
"""Fetch a small, licence-verified CC0/PD training seed from Wikimedia Commons.

Implements the spec §5 licence gate for a *starter* set (a few hundred images),
enough to prove the end-to-end pipeline and run a real (small) training. The
architected bulk sources (Smithsonian CC0, Met PD, Open Images CC-BY, ...) are
implemented as separate fetchers; this one intentionally stays small so the
licence review is meaningful (spec §6-Phase1.4).

Every row written to data/manifest.csv is licence-filtered on the Commons
*machine-readable* field (``extmetadata.License``), keeping only {cc0, pd,
pdm, public domain} and dropping anything whose tag contains -sa/-nc (spec §5).
Attribution text is preserved in the manifest and the provenance file.

Files are drawn from CC0/PD-heavy Commons *categories* rather than free-text
search: search returned mostly CC-BY-SA, which the spec excludes, so the yield
was near zero. Category membership gives a high licence-pass rate.

Usage:
    python3 scripts/distill/fetch-cc0.py --categories product --count 120
    python3 scripts/distill/fetch-cc0.py --categories product,animal --dry-run

Outputs:
    data/images/<sha256>.jpg         resized max-side 1536, JPEG q90 (spec §4.2)
    data/manifest.csv                one row per approved image (spec §5)
    data/fetcher-logs/<date>.json    per-URL licence + rejection reasons
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

ROOT = Path(__file__).resolve().parents[2]            # repo root
DATA = ROOT / "data"
IMGDIR = DATA / "images"
LOGDIR = DATA / "fetcher-logs"
MANIFEST = DATA / "manifest.csv"
# Commons categories excluded outright (people / unsafe content).
EXCLUDED_CATEGORY_HINTS = ("porn", "nude", "esoteric", "sexual")
# Commons categories per target category. Topical categories are far more
# relevant than the generic CC-Zero firehose; every file is still licence-
# checked per-image (spec §5), so topical categories that mix licences are fine.
CATEGORY_SOURCES = {
    "product": ["Category:Bottles", "Category:Ceramic tableware",
                "Category:Furniture", "Category:Musical instruments",
                "Category:Coins", "Category:PD-self"],
    "shoe": ["Category:Footwear"],
    "jewelry": ["Category:Jewellery"],
    "plant": ["Category:Potted plants", "Category:Flowers"],
    "pet": ["Category:Dogs", "Category:Cats"],
    "glass": ["Category:Glass objects", "Category:Bottles"],
    "object": ["Category:CC-Zero", "Category:PD-self", "Category:PD-old-100"],
    # Tier B (hair/fur/soft edges). Category names contain "hair"/"fur" so
    # select.py tiers them B. Deliberately disjoint from fetch-eval.py's
    # categories (which use Human hair / Hair (anatomy) / Animal fur).
    "hair": ["Category:Wigs", "Category:Felt", "Category:Wool"],
    "fur": ["Category:Shih Tzu", "Category:Angora rabbits", "Category:Rabbits",
            "Category:Sheep", "Category:Teddy bears", "Category:Feathers",
            "Category:Persian cats", "Category:Chinchillas"],
}




def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()












def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--categories", default="product")
    ap.add_argument("--count", type=int, default=60, help="target per category")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--manifest", type=Path, default=MANIFEST)
    args = ap.parse_args()

    IMGDIR.mkdir(parents=True, exist_ok=True)
    LOGDIR.mkdir(parents=True, exist_ok=True)
    headers = ["id", "source", "url", "licence", "licence_url", "author",
               "attribution_text", "date_checked", "sha256", "width", "height",
               "category", "tier", "split", "reject_reason"]

    rows: list[dict] = []
    seen: set[str] = set()
    if args.manifest.exists():
        with open(args.manifest) as f:
            for r in csv.DictReader(f):
                if r.get("sha256"):
                    rows.append(r)
                    seen.add(r["sha256"])

    log = {"date": str(date.today()), "fetches": [], "rejections": []}

    writer = ManifestWriter(args.manifest, headers, rows)

    for cat in args.categories.split(","):
        got = 0
        for source in CATEGORY_SOURCES.get(cat, CATEGORY_SOURCES["object"]):
            if got >= args.count:
                break
            # Oversample: many category files are SVGs/diagrams we drop.
            titles = [t for t in category_files(source, args.count * 6)
                      if not any(k in t.lower() for k in EXCLUDED_CATEGORY_HINTS)]
            # Batch metadata (50 titles/call) instead of one call per file.
            infos = file_info_batch(titles)
            batch: list[dict] = []
            for title in titles:
                if got >= args.count:
                    break
                info = infos.get(title) or _empty_info(title)
                if not info["mime"].startswith("image/"):
                    continue
                if not is_approved(info["licence"]):
                    log["rejections"].append(
                        {"title": title, "licence": info["licence"],
                         "reject_reason": f"licence={info['licence']!r}"})
                    continue
                if info["mime"] in ("image/svg+xml", "image/tiff"):
                    log["rejections"].append({"title": title, "reject_reason": "mime"})
                    continue
                batch.append({
                    "id": None, "source": "wikimedia-commons", "url": info["url"],
                    "licence": info["licence_name"] or info["licence"],
                    "licence_url": info["licence_url"], "author": info["author"],
                    "attribution_text": info["page"],
                    "date_checked": str(date.today()), "sha256": "",
                    "width": "", "height": "", "category": cat, "tier": "",
                    "split": "", "reject_reason": "",
                })
                got += 1

            # Download this batch, writing the manifest after each image so a
            # disconnect never loses more than one image (spec §3.5 resumable).
            for e in batch:
                if args.dry_run:
                    continue
                try:
                    r = _get(e["url"])
                    tmp = IMGDIR / "tmp_dl.bin"
                    tmp.write_bytes(r.content)
                    h = sha256_file(tmp)
                    if h in seen:
                        tmp.unlink(missing_ok=True)
                        log["fetches"].append({"url": e["url"], "status": "dup"})
                        continue
                    dst = IMGDIR / f"{h}.jpg"
                    tmp.rename(dst)
                    try:
                        normalize_image(dst)
                    except Exception:
                        dst.unlink(missing_ok=True)
                        log["rejections"].append({"url": e["url"],
                                                  "reject_reason": "too-large"})
                        continue
                    with Image.open(dst) as im:
                        w, hh = im.size
                    e["id"] = f"{e['source']}-{e['category']}-{h[:10]}"
                    e["width"], e["height"], e["sha256"] = w, hh, h
                    rows.append(e)
                    seen.add(h)
                    log["fetches"].append({"url": e["url"], "status": "ok", "sha256": h})
                    writer.mark()
                    writer.maybe_flush()
                    time.sleep(0.2)
                except Exception as ex:  # never kill the whole run on one image
                    log["fetches"].append({"url": e["url"], "status": "error",
                                           "err": str(ex)})

    writer.flush()
    (LOGDIR / f"{date.today()}.json").write_text(json.dumps(log, indent=2))

    ok = len([x for x in log["fetches"] if x["status"] == "ok"])
    dups = len([x for x in log["fetches"] if x["status"] == "dup"])
    errs = len([x for x in log["fetches"] if x["status"] == "error"])
    print(f"manifest: {len(rows)} rows | this run: {ok} ok, {dups} dup, "
          f"{errs} error, {len(log['rejections'])} rejected")
    print(f"manifest -> {args.manifest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
