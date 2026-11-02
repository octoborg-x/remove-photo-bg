#!/usr/bin/env python3
"""Fetch CC0 product-like objects from the Cleveland Museum of Art Open Access.

The Cleveland Open Access API exposes ~41,800 CC0 artworks with images
(``cc0=1&has_image=1``), and supports ``type=`` filtering — far higher yield
than Commons for product-like objects (Ceramic, Metalwork, Jewelry, Silver,
Glass, Furniture, Sculpture, Lacquer). This is a foreground-heavy source for
the distillation seed.

Licence gate (spec §5): every record's ``share_license_status`` must equal
``CC0`` (the query already filters ``cc0=1``; re-checked per row). The image
downloaded is ``images.print.url`` (≈3400 px JPEG) with ``images.web.url`` as a
fallback; both live on ``openaccess-cdn.clevelandart.org`` and are CC0.

Usage:
    python3 scripts/distill/fetch-cleveland.py --types Ceramic,Metalwork --per-type 200

Outputs (shared with fetch-cc0.py / fetch-met.py):
    data/images/<sha256>.jpg, data/manifest.csv, data/fetcher-logs/<date>.json
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

from _bootstrap import *  # noqa: F401, E402  (sys.path fix; MUST precede 3rd-party)
import requests  # noqa: E402
from PIL import Image  # noqa: E402
from scripts.distill.image_ops import normalize_image  # noqa: E402
from scripts.distill.manifest_io import ManifestWriter, merge_write  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
IMGDIR = DATA / "images"
LOGDIR = DATA / "fetcher-logs"
MANIFEST = DATA / "manifest.csv"
API = "https://openaccess-api.clevelandart.org/api/artworks/"

UA = ("remove-photo-bg-distill/1.0 "
      "(https://github.com/octoborg-x/remove-photo-bg; "
      "python-requests) contact: repo owner")
HEADERS = {"User-Agent": UA}

# Product-like CC0 types with meaningful totals (verified 2026-11-01).
DEFAULT_TYPES = ["Ceramic", "Metalwork", "Jewelry", "Silver", "Glass",
                 "Furniture and woodwork", "Lacquer", "Sculpture",
                 "Arms and Armor", "Textile", "Coins", "Miscellaneous",
                 "Jade", "Enamel", "Ivory", "Musical Instrument"]

HEADERS_CSV = ["id", "source", "url", "licence", "licence_url", "author",
               "attribution_text", "date_checked", "sha256", "width", "height",
               "category", "tier", "split", "reject_reason"]

# Cleveland `type` -> our category bucket.
TYPE_CATEGORY = {
    "Ceramic": "product", "Metalwork": "product", "Silver": "product",
    "Glass": "glass", "Jewelry": "jewelry",
    "Furniture and woodwork": "object", "Lacquer": "object",
    "Sculpture": "object",
}

_MIN_INTERVAL = 0.3
_last_req = [0.0]
_pace_lock = threading.Lock()


def _get(url: str, **kw) -> requests.Response:
    """GET with pacing + backoff (shared egress IPs can be throttled)."""
    for attempt in range(6):
        with _pace_lock:
            dt = time.time() - _last_req[0]
            if dt < _MIN_INTERVAL:
                time.sleep(_MIN_INTERVAL - dt)
            _last_req[0] = time.time()
        r = requests.get(url, headers=HEADERS, timeout=120, **kw)
        if r.status_code == 200:
            return r
        if r.status_code in (403, 429, 500, 502, 503):
            time.sleep(min(60, 5 * (attempt + 1)))
            continue
        r.raise_for_status()
    r.raise_for_status()
    return r


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def list_artworks(atype: str, want: int) -> list[dict]:
    """CC0 artworks of a type, paginated (API caps limit at 1000)."""
    out: list[dict] = []
    skip = 0
    while len(out) < want:
        q = urllib.parse.urlencode({"cc0": 1, "has_image": 1, "type": atype,
                                    "limit": 1000, "skip": skip})
        r = _get(API + "?" + q)
        data = r.json().get("data") or []
        if not data:
            break
        out += data
        skip += 1000
    return out[:want]


def image_url(rec: dict) -> str:
    imgs = rec.get("images") or {}
    for key in ("print", "web", "full"):
        u = (imgs.get(key) or {}).get("url")
        if u and u.lower().endswith((".jpg", ".jpeg", ".png")):
            return u
    return ""


def author_of(rec: dict) -> str:
    creators = rec.get("creators") or []
    return (creators[0].get("description") or "").strip() if creators else ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--types", default=",".join(DEFAULT_TYPES))
    ap.add_argument("--per-type", type=int, default=400)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--manifest", type=Path, default=MANIFEST)
    args = ap.parse_args()

    IMGDIR.mkdir(parents=True, exist_ok=True)
    LOGDIR.mkdir(parents=True, exist_ok=True)

    rows: list[dict] = []
    seen: set[str] = set()
    known_urls: set[str] = set()
    if args.manifest.exists():
        with open(args.manifest) as f:
            for r in csv.DictReader(f):
                if r.get("sha256"):
                    rows.append(r)
                    seen.add(r["sha256"])
                    if r.get("url"):
                        known_urls.add(r["url"])

    log = {"date": str(date.today()), "source": "cleveland-maa",
           "fetches": [], "rejections": []}
    lock = threading.Lock()
    writer = ManifestWriter(args.manifest, HEADERS_CSV, rows)

    def handle(atype: str, rec: dict) -> None:
        if (rec.get("share_license_status") or "").upper() != "CC0":
            with lock:
                log["rejections"].append({"id": rec.get("id"), "type": atype,
                                          "reject_reason": "not-cc0"})
            return
        url = image_url(rec)
        if not url:
            with lock:
                log["rejections"].append({"id": rec.get("id"), "type": atype,
                                          "reject_reason": "no-image"})
            return
        # Skip images already in the manifest so a resume/top-up only downloads
        # the new ones instead of re-fetching the whole collection.
        if url in known_urls:
            return
        if args.dry_run:
            return
        try:
            r = _get(url)
            tmp = IMGDIR / f"tmp_{threading.get_ident()}.bin"
            tmp.write_bytes(r.content)
            h = sha256_file(tmp)
            with lock:
                if h in seen:
                    tmp.unlink(missing_ok=True)
                    log["fetches"].append({"url": url, "status": "dup"})
                    return
                seen.add(h)
            dst = IMGDIR / f"{h}.jpg"
            tmp.rename(dst)
            try:
                normalize_image(dst)
            except Exception:
                dst.unlink(missing_ok=True)
                with lock:
                    log["rejections"].append({"id": rec.get("id"), "type": atype,
                                              "reject_reason": "too-large"})
                return
            with Image.open(dst) as im:
                w, hh = im.size
            acc = rec.get("accession_number") or rec.get("id")
            row = {
                "id": f"cleveland-{acc}", "source": "cleveland-maa",
                "url": url, "licence": "CC0 1.0",
                "licence_url":
                    "https://creativecommons.org/publicdomain/zero/1.0/",
                "author": author_of(rec),
                "attribution_text": rec.get("url") or
                    f"https://clevelandart.org/art/{acc}",
                "date_checked": str(date.today()), "sha256": h,
                "width": w, "height": hh,
                "category": TYPE_CATEGORY.get(atype, "object"),
                "tier": "", "split": "", "reject_reason": "",
            }
            with lock:
                rows.append(row)
                log["fetches"].append({"url": url, "status": "ok", "sha256": h,
                                       "type": atype})
                writer.mark()
                writer.maybe_flush()
        except Exception as ex:
            with lock:
                log["fetches"].append({"url": url, "status": "error",
                                       "err": str(ex)})

    for atype in args.types.split(","):
        recs = list_artworks(atype, args.per_type)
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            list(pool.map(lambda rec: handle(atype, rec), recs))

    writer.flush()
    (LOGDIR / f"cleveland-{date.today()}.json").write_text(json.dumps(log, indent=2))

    ok = len([x for x in log["fetches"] if x["status"] == "ok"])
    dups = len([x for x in log["fetches"] if x["status"] == "dup"])
    errs = len([x for x in log["fetches"] if x["status"] == "error"])
    print(f"manifest: {len(rows)} rows | this run: {ok} ok, {dups} dup, "
          f"{errs} error, {len(log['rejections'])} rejected")
    print(f"manifest -> {args.manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
