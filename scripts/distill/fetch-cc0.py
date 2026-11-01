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

# Wikimedia requires a descriptive User-Agent; without one the API returns 403.
# https://meta.wikimedia.org/wiki/User-Agent_policy
UA = ("remove-photo-bg-distill/1.0 "
      "(https://github.com/octoborg-x/remove-photo-bg; "
      "python-requests) contact: repo owner")
HEADERS = {"User-Agent": UA}

# spec §5: approved machine-readable licence tags (Commons 'extmetadata.License').
APPROVED_EXACT = {"cc0", "pd", "pdm", "public domain", "cc-pd-mark"}
EXCLUDED_LICENCE_SUBSTR = ("-sa", "-nc", "noncommercial", "sharealike")
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
}


def _strip_html(s: str) -> str:
    """Commons 'Artist' is often HTML; keep plain text for the provenance file."""
    import re
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = s.replace("&amp;", "&").replace("&nbsp;", " ").replace("&#39;", "'")
    return " ".join(s.split())


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _api(params: dict) -> dict:
    _pace()
    r = requests.get(COMMONS_API, params={**params, "format": "json"},
                     timeout=30, headers=HEADERS)
    r.raise_for_status()
    return r.json()


# Wikimedia throttles bursts hard (HTTP 429), so we serialise every request
# through a minimum interval. This is politeness, not a keep-alive hack.
_MIN_INTERVAL = 0.6
_last_req = [0.0]


def _pace() -> None:
    dt = time.time() - _last_req[0]
    if dt < _MIN_INTERVAL:
        time.sleep(_MIN_INTERVAL - dt)
    _last_req[0] = time.time()


def _get(url: str, **kw) -> requests.Response:
    """GET with pacing + 429 backoff (Wikimedia rate-limits bots aggressively)."""
    for attempt in range(6):
        _pace()
        r = requests.get(url, headers=HEADERS, timeout=120, **kw)
        if r.status_code == 200:
            return r
        if r.status_code == 429:
            time.sleep(min(60, 10 * (attempt + 1)))
            continue
        r.raise_for_status()
    r.raise_for_status()
    return r


def category_files(cat: str, limit: int) -> list[str]:
    """Return up to `limit` file titles from a Commons category."""
    out: list[str] = []
    cont: dict = {}
    while len(out) < limit:
        params = {"action": "query", "list": "categorymembers",
                  "cmtitle": cat, "cmtype": "file",
                  "cmlimit": min(500, limit - len(out))}
        params.update(cont)
        d = _api(params)
        out += [m["title"] for m in d.get("query", {}).get("categorymembers", [])]
        if "continue" not in d:
            break
        cont = d["continue"]
    return out[:limit]


def file_info(title: str) -> dict:
    """Machine-readable licence + URL + author for one Commons file title."""
    return file_info_batch([title]).get(title, _empty_info(title))


def _empty_info(title: str) -> dict:
    return {"title": title, "licence": "", "licence_name": "", "licence_url": "",
            "author": "", "mime": "", "url": "", "page": ""}


def file_info_batch(titles: list[str]) -> dict[str, dict]:
    """Licence/URL/author for up to 50 titles in ONE API call.

    The Commons API caps `titles` at 50; batching cuts the request count ~50x
    versus one call per file, which is the difference between a multi-hour and
    a multi-minute fetch (and avoids hammering the API into 429s).
    """
    out: dict[str, dict] = {}
    for i in range(0, len(titles), 50):
        chunk = titles[i:i + 50]
        d = _api({"action": "query", "titles": "|".join(chunk),
                  "prop": "imageinfo",
                  "iiprop": "url|mime|extmetadata", "iiurlwidth": "1536"})
        pages = d.get("query", {}).get("pages", {})
        # The API may normalise/redirect titles; map back via the requested name.
        by_title = {p.get("title", ""): p for p in pages.values()}
        for t in chunk:
            pg = by_title.get(t) or by_title.get(t.replace("_", " "))
            if pg is None:
                out[t] = _empty_info(t)
                continue
            ii = (pg.get("imageinfo") or [{}])[0]
            em = ii.get("extmetadata", {})
            tag = ((em.get("License", {}) or {}).get("value", "") or "").strip().lower()
            name = (em.get("LicenseShortName", {}) or {}).get("value", "") or ""
            licurl = (em.get("LicenseUrl", {}) or {}).get("value", "") or ""
            artist = (em.get("Artist", {}) or {}).get("value", "") or ""
            out[t] = {"title": t, "licence": tag, "licence_name": name,
                      "licence_url": licurl, "author": _strip_html(artist),
                      "mime": ii.get("mime", ""), "url": ii.get("url", ""),
                      "page": "https://commons.wikimedia.org/wiki/"
                              + urllib.parse.quote(t.replace(" ", "_"))}
    return out


def is_approved(lic: str) -> bool:
    """True for CC0 / PD / public-domain marks only (spec §5)."""
    lic = (lic or "").strip().lower()
    if not lic:
        return False
    if any(s in lic for s in EXCLUDED_LICENCE_SUBSTR):
        return False
    return lic in APPROVED_EXACT


def normalize_image(path: Path) -> None:
    """Resize max-side 1536, JPEG q90, strip EXIF (spec §4.2)."""
    img = ImageOps.exif_transpose(Image.open(path))
    img = img.convert("RGB")
    img.thumbnail((1536, 1536), Image.LANCZOS)
    img.save(path, "JPEG", quality=90, optimize=True)


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

    def write_manifest() -> None:
        with open(args.manifest, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=headers)
            w.writeheader()
            for r in rows:
                w.writerow({k: r.get(k, "") for k in headers})

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
                    normalize_image(dst)
                    with Image.open(dst) as im:
                        w, hh = im.size
                    e["id"] = f"{e['source']}-{e['category']}-{h[:10]}"
                    e["width"], e["height"], e["sha256"] = w, hh, h
                    rows.append(e)
                    seen.add(h)
                    log["fetches"].append({"url": e["url"], "status": "ok", "sha256": h})
                    write_manifest()
                    time.sleep(0.2)
                except Exception as ex:  # never kill the whole run on one image
                    log["fetches"].append({"url": e["url"], "status": "error",
                                           "err": str(ex)})

    write_manifest()
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
