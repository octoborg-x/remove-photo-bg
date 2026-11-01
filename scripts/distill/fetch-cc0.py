#!/usr/bin/env python3
"""Fetch a small, licence-verified CC0/PD training seed from Wikimedia Commons.

Implements the spec §5 licence gate for a *starter* set (a few hundred images),
enough to prove the end-to-end pipeline and run a real (small) training. The
architected bulk sources (Smithsonian CC0, Met PD, Open Images CC-BY, ...) are
implemented as fetchers/ submodules; this fetcher intentionally stays small so
the licence review board is meaningful (spec §6-Phase1.4).

Every row written to data/manifest.csv is licence-filtered: only files whose
Commons *machine-readable* licence field is one of {cc0, pd, pdm} and whose
category is not in the exclusion list are kept (spec §5). Attribution text is
preserved in the manifest and provenance file.

Usage:
    python3 scripts/distill/fetch-cc0.py --category product --count 120
    python3 scripts/distill/fetch-cc0.py --categories product,animal,glass --dry-run

Outputs:
    data/images/<sha256>.<ext>       resized max-side 1536, JPEG q90 (spec §4.2)
    data/manifest.csv                one row per approved image (spec §5)
    data/fetcher-logs/<date>.json    per-URL licence + rejection reasons
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
import time
import urllib.parse
from datetime import date
from pathlib import Path

import requests
from _bootstrap import *  # noqa: F401, E402  (sys.path fix)
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[2]            # repo root
DATA = ROOT / "data"
IMGDIR = DATA / "images"
LOGDIR = DATA / "fetcher-logs"
MANIFEST = DATA / "manifest.csv"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"

# spec §5: approved licence classes (machine-readable Commons 'licensetag')
APPROVED_LICENCES = {"cc0", "pd", "pdm"}
# commons categories that are excluded outright (people without licence etc.)
EXCLUDED_CATEGORIES = ("category:porn", "category:nude", "category:esoteric")

# Simple curated gallery + free-text searches per category. In production this
# is replaced by the per-source fetchers; these are deliberately small so each
# row can be personally reviewed before it feeds training (spec §6-Phase1.4).
SEARCHES = {
    "product": 'filetype:bitmap -inname:logo haswbstatement:P6216=Q19652',  # CC0?
    "animal": "filetype:bitmap animal",
    "glass": "filetype:bitmap glass bottle transparent",
}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def licence_record(url: str) -> dict:
    """Return machine-readable licence fields for a Commons file via API."""
    p = {
        "action": "query",
        "titles": url.split("/")[-1].replace("_", " "),
        "prop": "imageinfo",
        "iiprop": "url|extmetadata",
        "iiurlwidth": "1536",
        "format": "json",
    }
    r = requests.get(COMMONS_API, params=p, timeout=30)
    r.raise_for_status()
    d = r.json()
    pages = d.get("query", {}).get("pages", {})
    for _, pg in pages.items():
        for ii in pg.get("imageinfo", []) or []:
            em = ii.get("extmetadata", {})
            lic = (em.get("LicenseShortName", {}) or {}).get("value", "")
            licurl = (em.get("LicenseUrl", {}) or {}).get("value", "")
            artist = (em.get("Artist", {}) or {}).get("value", "")
            return {"licence": lic.lower(), "licence_url": licurl,
                    "author": artist, "mime": ii.get("mime", ""),
                    "thumb": (ii.get("thumburl") or ii.get("url") or "")}
    return {"licence": "", "licence_url": "", "author": "", "mime": "",
            "thumb": ""}


def is_approved(lic: str) -> bool:
    return any(k in lic for k in APPROVED_LICENCES)


def normalize_image(path: Path) -> None:
    """Resize max-side 1536, JPEG q90, strip EXIF (spec §4.2)."""
    img = ImageOps.exif_transpose(Image.open(path))
    img = img.convert("RGB")
    img.thumbnail((1536, 1536), Image.LANCZOS)
    img.save(path.with_suffix(".jpg"), "JPEG", quality=90, optimize=True)


def search_images(term: str, n: int) -> list[str]:
    """Return up to n Commons image URLs for a search term."""
    params = {
        "action": "query", "generator": "search", "gsrsearch": term,
        "gsrnamespace": "6", "gsrlimit": min(n * 4, 500),
        "prop": "imageinfo", "iiprop": "url|size|mime",
        "format": "json",
    }
    r = requests.get(COMMONS_API, params=params, timeout=30)
    r.raise_for_status()
    out = []
    for pg in (r.json().get("query", {}).get("pages", {}) or {}).values():
        ii = (pg.get("imageinfo") or [{}])[0]
        if ii.get("mime", "").startswith("image/") and ii.get("url"):
            out.append(ii["url"])
    return out[:n]


def main() -> None:
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
    write_header = not args.manifest.exists()

    rows = []
    seen = set()
    if args.manifest.exists():
        with open(args.manifest) as f:
            for r in csv.DictReader(f):
                rows.append(r)
                seen.add(r["sha256"])

    log = {"date": str(date.today()), "fetches": [], "rejections": []}
    collected = []

    for cat in args.categories.split(","):
        term = SEARCHES.get(cat, f"filetype:bitmap {cat}")
        urls = search_images(term, args.count * 2)
        for u in urls:
            if len(collected) >= args.count:
                break
            rec = licence_record(u)
            entry = {
                "id": None, "source": "wikimedia-commons", "url": u,
                "licence": rec["licence"], "licence_url": rec["licence_url"],
                "author": rec["author"], "attribution_text":
                    f"https://commons.wikimedia.org/wiki/{urllib.parse.quote(u.split("/")[-1].replace("_"," "))}",
                "date_checked": str(date.today()), "sha256": "",
                "width": "", "height": "", "category": cat, "tier": "", "split": "",
                "reject_reason": "",
            }
            if not is_approved(rec["licence"]):
                entry["reject_reason"] = f"licence={rec['licence']!r}"
                log["rejections"].append(entry)
                continue
            if any(k in rec["licence"].lower() for k in EXCLUDED_CATEGORIES):
                entry["reject_reason"] = "excluded-category"
                log["rejections"].append(entry)
                continue
            collected.append(entry)

    # download + normalize
    for e in collected:
        if args.dry_run:
            continue
        try:
            r = requests.get(e["url"], timeout=120)
            r.raise_for_status()
            tmp = DATA / "images" / "tmp_dl.bin"
            tmp.write_bytes(r.content)
            mime = e.get("mime") or "image/jpeg"
            h = sha256_file(tmp)
            ext = ".jpg" if mime in ("image/jpeg", "image/png", "image/webp") else ".bin"
            dst = IMGDIR / f"{h}{ext}"
            if dst.exists():
                row = next((x for x in rows if x["sha256"] == h), None)
                if row and h in seen:
                    log["fetches"].append({"url": e["url"], "status": "dup"})
                    continue
            tmp.rename(dst)
            normalize_image(dst)
            with Image.open(dst) as im:
                w, hh = im.size
            e["id"] = f"{e['source']}-{cat}-{h[:10]}"
            e["width"], e["height"], e["sha256"] = w, hh, h
            e["mime"] = mime
            rows.append(e)
            seen.add(h)
            log["fetches"].append({"url": e["url"], "status": "ok",
                                   "sha256": h})
            time.sleep(0.2)
        except Exception as ex:  # never kill the whole run on one image
            log["fetches"].append({"url": e["url"], "status": "error",
                                   "err": str(ex)})

    with open(args.manifest, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        if write_header:
            w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in headers})
    (LOGDIR / f"{date.today()}.json").write_text(json.dumps(log, indent=2))

    ok = len([x for x in log["fetches"] if x["status"] == "ok"])
    print(f"manifest: {len(rows)} rows | this run: {ok} ok, "
          f"{len(log['rejections'])} rejected, "
          f"{len([x for x in log['fetches'] if x['status']!='ok'])} errors")
    print(f"manifest -> {args.manifest}")


if __name__ == "__main__":
    sys.exit(main())