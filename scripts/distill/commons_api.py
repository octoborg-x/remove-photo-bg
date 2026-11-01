#!/usr/bin/env python3
"""Shared Wikimedia Commons API helpers + the spec §5 licence gate.

Extracted from fetch-cc0.py so the evaluation fetcher can reuse the exact same
licence filtering (spec §5): only per-file machine-readable CC0/PD/PDM marks
are approved; anything containing -sa/-nc/sharealike/noncommercial is dropped.
"""

from __future__ import annotations

import re
import time
import urllib.parse

import requests

COMMONS_API = "https://commons.wikimedia.org/w/api.php"

# Wikimedia requires a descriptive User-Agent; without one the API returns 403.
UA = ("remove-photo-bg-distill/1.0 "
      "(https://github.com/octoborg-x/remove-photo-bg; "
      "python-requests) contact: repo owner")
HEADERS = {"User-Agent": UA}

APPROVED_EXACT = {"cc0", "pd", "pdm", "public domain", "cc-pd-mark"}
EXCLUDED_LICENCE_SUBSTR = ("-sa", "-nc", "noncommercial", "sharealike")

# Wikimedia throttles bursts hard (HTTP 429); serialise through a min interval.
_MIN_INTERVAL = 0.6
_last_req = [0.0]


def _pace() -> None:
    dt = time.time() - _last_req[0]
    if dt < _MIN_INTERVAL:
        time.sleep(_MIN_INTERVAL - dt)
    _last_req[0] = time.time()


def _get(url: str, **kw) -> requests.Response:
    """GET with pacing + 429 backoff."""
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


def _api(params: dict) -> dict:
    _pace()
    r = requests.get(COMMONS_API, params={**params, "format": "json"},
                     timeout=30, headers=HEADERS)
    r.raise_for_status()
    return r.json()


def strip_html(s: str) -> str:
    """Commons 'Artist' is often HTML; keep plain text for provenance."""
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = s.replace("&amp;", "&").replace("&nbsp;", " ").replace("&#39;", "'")
    return " ".join(s.split())


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


def _empty_info(title: str) -> dict:
    return {"title": title, "licence": "", "licence_name": "", "licence_url": "",
            "author": "", "mime": "", "url": "", "page": ""}


def file_info_batch(titles: list[str]) -> dict[str, dict]:
    """Licence/URL/author for up to 50 titles per API call."""
    out: dict[str, dict] = {}
    for i in range(0, len(titles), 50):
        chunk = titles[i:i + 50]
        d = _api({"action": "query", "titles": "|".join(chunk),
                  "prop": "imageinfo",
                  "iiprop": "url|mime|extmetadata", "iiurlwidth": "1536"})
        pages = d.get("query", {}).get("pages", {})
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
                      "licence_url": licurl, "author": strip_html(artist),
                      "mime": ii.get("mime", ""), "url": ii.get("url", ""),
                      "page": "https://commons.wikimedia.org/wiki/"
                              + urllib.parse.quote(t.replace(" ", "_"))}
    return out


def file_info(title: str) -> dict:
    return file_info_batch([title]).get(title, _empty_info(title))


def is_approved(lic: str) -> bool:
    """True for CC0 / PD / public-domain marks only (spec §5)."""
    lic = (lic or "").strip().lower()
    if not lic:
        return False
    if any(s in lic for s in EXCLUDED_LICENCE_SUBSTR):
        return False
    return lic in APPROVED_EXACT
