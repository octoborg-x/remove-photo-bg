#!/usr/bin/env python3
"""Fetch CC0 foreground objects from The Met Open Access (spec §5).

The Met Open Access collection is a strong *foreground* source for the
distillation seed: real objects (bottles, vases, jewellery, glass, shoes,
metalwork, watches) photographed on plain backgrounds, released CC0
(``isPublicDomain == true``). This is a foreground-only fetcher — the
backgrounds come from Poly Haven / procedural sources in a later step.

API notes (verified 2026-11-01):
  - ``/public/collection/v1/search`` was RETIRED on 2026-10-01 (HTTP 410).
    Search now uses ``/public/collection/v1.1/search`` (paginated via
    offset/limit); object details are still on ``/public/collection/v1``.
  - Only objects with ``isPublicDomain == true`` AND a ``primaryImage`` are
    kept; everything else is rejected and logged.

Usage:
    python3 scripts/distill/fetch-met.py --queries bottle,vase,jewelry --per-query 60

Outputs (shared with fetch-cc0.py):
    data/images/<sha256>.jpg, data/manifest.csv, data/fetcher-logs/<date>.json
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

from _bootstrap import *  # noqa: F401, E402  (sys.path fix; MUST precede 3rd-party)
import requests  # noqa: E402
from PIL import Image, ImageOps  # noqa: E402
from scripts.distill.manifest_io import merge_write  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
IMGDIR = DATA / "images"
LOGDIR = DATA / "fetcher-logs"
MANIFEST = DATA / "manifest.csv"
API = "https://collectionapi.metmuseum.org/public/collection"
SEARCH = f"{API}/v1.1/search"
OBJECT = f"{API}/v1/objects"

UA = ("remove-photo-bg-distill/1.0 "
      "(https://github.com/octoborg-x/remove-photo-bg; "
      "python-requests) contact: repo owner")
HEADERS = {"User-Agent": UA}

# Default queries: product-like, foreground-heavy object classes (spec §6-Phase1.1).
DEFAULT_QUERIES = [
    "bottle", "vase", "jewelry", "necklace", "earring", "bracelet", "ring",
    "shoe", "boot", "hat", "belt", "bowl", "cup", "plate", "pitcher", "teapot",
    "watch", "coin", "glass", "cameo", "sculpture", "figure", "box", "lamp",
]

HEADERS_CSV = ["id", "source", "url", "licence", "licence_url", "author",
               "attribution_text", "date_checked", "sha256", "width", "height",
               "category", "tier", "split", "reject_reason"]


def _get(url: str, **kw) -> requests.Response:
    """GET with pacing + backoff.

    The Met API is served from Colab's *shared* egress IP, so it frequently
    returns 403 (throttled) as well as 429/5xx. We retry those with growing
    delays and a small minimum interval between calls.
    """
    for attempt in range(6):
        _pace()
        r = requests.get(url, headers=HEADERS, timeout=60, **kw)
        if r.status_code == 200:
            return r
        if r.status_code in (403, 429, 500, 502, 503):
            time.sleep(min(60, 5 * (attempt + 1)))
            continue
        r.raise_for_status()
    r.raise_for_status()
    return r


_MIN_INTERVAL = 0.4
_last_req = [0.0]
_pace_lock = threading.Lock()


def _pace() -> None:
    with _pace_lock:
        dt = time.time() - _last_req[0]
        if dt < _MIN_INTERVAL:
            time.sleep(_MIN_INTERVAL - dt)
        _last_req[0] = time.time()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def search_ids(query: str, want: int) -> list[int]:
    """Object IDs for a query, paginating the v1.1 search endpoint."""
    out: list[int] = []
    offset = 0
    while len(out) < want * 3:  # oversample; many objects are not PD
        r = _get(SEARCH, params={"q": query, "hasImages": "true",
                                 "offset": offset, "limit": 100})
        ids = (r.json().get("objectIDs") or [])
        if not ids:
            break
        out += ids
        offset += 100
    return out


def object_info(oid: int) -> dict:
    r = _get(f"{OBJECT}/{oid}")
    j = r.json()
    return {"public_domain": j.get("isPublicDomain"),
            "image": j.get("primaryImage") or "",
            "object_name": (j.get("objectName") or "").strip(),
            "title": (j.get("title") or "").strip(),
            "artist": (j.get("artistDisplayName") or "").strip(),
            "object_url": j.get("objectURL") or f"https://www.metmuseum.org/art/collection/search/{oid}"}


def _safe_object_info(oid: int, log: dict, query: str) -> dict | None:
    try:
        return object_info(oid)
    except Exception as ex:
        log["rejections"].append({"id": oid, "query": query,
                                  "reject_reason": f"api-error:{ex}"})
        return None


def normalize_image(path: Path) -> None:
    img = ImageOps.exif_transpose(Image.open(path))
    img = img.convert("RGB")
    img.thumbnail((1536, 1536), Image.LANCZOS)
    img.save(path, "JPEG", quality=90, optimize=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--queries", default=",".join(DEFAULT_QUERIES))
    ap.add_argument("--per-query", type=int, default=60)
    ap.add_argument("--category", default="object")
    ap.add_argument("--dry-run", action="store_true")
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

    log = {"date": str(date.today()), "source": "met-museum",
           "fetches": [], "rejections": []}
    collected: list[dict] = []

    for query in args.queries.split(","):
        got = 0
        ids = search_ids(query, args.per_query)
        # Object detail is one HTTP call each; a small thread pool cuts wall
        # time ~4x while the global pacer still bounds the request rate.
        with ThreadPoolExecutor(max_workers=4) as pool:
            infos = list(pool.map(lambda oid: (oid, _safe_object_info(oid, log, query)), ids))
        for oid, info in infos:
            if got >= args.per_query:
                break
            if info is None:
                continue
            if not info["public_domain"]:
                log["rejections"].append({"id": oid, "query": query,
                                          "reject_reason": "not-public-domain"})
                continue
            if not info["image"]:
                log["rejections"].append({"id": oid, "query": query,
                                          "reject_reason": "no-image"})
                continue
            collected.append({
                "id": None, "source": "met-museum", "url": info["image"],
                "licence": "CC0 1.0", "licence_url":
                    "https://creativecommons.org/publicdomain/zero/1.0/",
                "author": info["artist"], "attribution_text": info["object_url"],
                "date_checked": str(date.today()), "sha256": "",
                "width": "", "height": "", "category": args.category,
                "tier": "", "split": "", "reject_reason": "",
                "query": query, "object_name": info["object_name"],
            })
            got += 1

    def write_manifest() -> None:
        merge_write(args.manifest, HEADERS_CSV, rows)

    for e in collected:
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
            normalize_image(dst)
            with Image.open(dst) as im:
                w, hh = im.size
            e["id"] = f"met-{e['category']}-{h[:10]}"
            e["width"], e["height"], e["sha256"] = w, hh, h
            rows.append(e)
            seen.add(h)
            log["fetches"].append({"url": e["url"], "status": "ok",
                                   "sha256": h, "query": e["query"]})
            write_manifest()
            time.sleep(0.1)
        except Exception as ex:
            log["fetches"].append({"url": e["url"], "status": "error",
                                   "err": str(ex)})

    write_manifest()
    (LOGDIR / f"met-{date.today()}.json").write_text(json.dumps(log, indent=2))

    ok = len([x for x in log["fetches"] if x["status"] == "ok"])
    dups = len([x for x in log["fetches"] if x["status"] == "dup"])
    errs = len([x for x in log["fetches"] if x["status"] == "error"])
    print(f"manifest: {len(rows)} rows | this run: {ok} ok, {dups} dup, "
          f"{errs} error, {len(log['rejections'])} rejected")
    print(f"manifest -> {args.manifest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
