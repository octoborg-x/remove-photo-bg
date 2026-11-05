#!/usr/bin/env python3
"""Build the fixed, versioned evaluation set for background removal quality.

The repository's own test images (a dog, a wine glass, a bottle) prove the
pipeline works but cannot establish *segmentation quality*. This script
assembles a small, fixed set of representative product/marketplace images with
deliberately difficult categories, and pins each one (URL + licence + size) into
`eval/manifest.json` so future model or runtime changes can be compared against
the same inputs.

Design constraints:

* **Licence-verified.** Only Wikimedia Commons files whose machine-readable
  licence is public-domain or a permissive CC licence are accepted; the licence
  string and its URL are stored in the manifest. No ambiguous licences.
* **Reproducible.** The manifest stores a stable thumbnail URL, the source page,
  and the pixel size, so the exact bytes can be re-fetched. Images themselves are
  NOT committed (they are large and licence-attributed); run this script with
  `--download` to populate `data/eval/images/` before a run.
* **Small but representative.** ~8 images per category across the categories the
  product actually serves (and the ones that are hard).

Usage:
    python3 scripts/eval/build-eval-set.py            # write eval/manifest.json
    python3 scripts/eval/build-eval-set.py --download # also fetch the images
    python3 scripts/eval/build-eval-set.py --download --only glass-transparent
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # Pillow is only needed to read image dimensions/decoding
    Image = None  # type: ignore[assignment]

ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "eval" / "manifest.json"
IMAGE_DIR = ROOT / "eval" / "images"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = "remove-bg-photo-eval/1.0 (background-removal quality evaluation)"

# Commons machine-readable licence tags that are safe to redistribute and to use
# as evaluation fixtures. Anything else (GFDL, "fair use", unknown) is rejected.
#
# Only no-conditions (CC0, public domain) and attribution-only (CC BY) licences
# are allowed. CC BY-SA is deliberately excluded: it is a copyleft licence, and
# bundling ShareAlike images into the repository would impose ShareAlike on the
# redistributed set — the project's dependency audit is otherwise copyleft-free
# (see LICENSE_AUDIT.md).
#
# The API returns the *human* short name ("CC BY 4.0", "CC0", "Public domain"),
# not a slug, so these are normalised before comparison — matching on the raw
# string silently rejected every CC-BY image and left the set dominated by
# public-domain archive scans.
APPROVED_LICENSES = {
    "cc0",
    "cc-zero",
    "pd",
    "pdm",
    "public domain",
    "no restrictions",
    "cc-by-4.0",
    "cc-by-3.0",
    "cc-by-2.5",
    "cc-by-2.0",
}


def normalize_license(raw: str) -> str:
    """Reduce a Commons licence short-name to a comparable slug.

    "CC BY-SA 4.0" -> "cc-by-sa-4.0"; "CC0" -> "cc0"; "Public domain" ->
    "public domain"; "CC BY 2.0" -> "cc-by-2.0".
    """
    text = raw.strip().lower()
    text = re.sub(r"\s+", " ", text)
    text = text.replace(" ", "-") if text.startswith("cc") else text
    return text

# One or more Commons search queries per category. Several queries per category
# widen the pool so the licence/size filters still leave enough images.
CATEGORIES: dict[str, dict] = {
    "ordinary-product": {
        # Each query names the *subject* that must appear in the file title
        # (`must`). Wikimedia full-text search happily returns unrelated files
        # for "…white background", so relevance is enforced by title, not by
        # trusting the ranking.
        "queries": [
            {"q": "filetype:bitmap bottle on white background", "must": ["bottle"]},
            {"q": "filetype:bitmap ceramic vase white background", "must": ["vase"]},
            {"q": "filetype:bitmap tin can product white background", "must": ["can"]},
            {"q": "filetype:bitmap box product packaging white background", "must": ["box"]},
            {"q": "filetype:bitmap jar product white background", "must": ["jar"]},
            {"q": "filetype:bitmap shoe box product", "must": ["box"]},
            {"q": "filetype:bitmap mug cup product white background", "must": ["mug", "cup"]},
            {"q": "filetype:bitmap water bottle product", "must": ["bottle"]},
            {"q": "filetype:bitmap cosmetics product white background", "must": ["cosmetic", "cream", "lotion"]},
        ],
        # "Vase" also matches archaeological records ("burials in vases"); the
        # set is meant to be product photography, not field photographs.
        "reject": ["burial", "tomb", "excavation", "archaeolog", "mummy", "opener"],
        "want": 8,
        "min_side": 600,
    },
    "clothing": {
        "queries": [
            {"q": "filetype:bitmap shirt white background", "must": ["shirt"]},
            {"q": "filetype:bitmap dress white background", "must": ["dress"]},
            {"q": "filetype:bitmap jacket white background", "must": ["jacket"]},
            {"q": "filetype:bitmap trousers white background", "must": ["trousers", "pants"]},
        ],
        # A "shirt" on a person in a car, or a "dress uniform" portrait, is not
        # the garment-focused shot this category is for.
        "reject": ["car", "tarp", "vehicle", "portrait", "uniform", "cutting", "sewing"],
        "want": 8,
        "min_side": 600,
    },
    "hair-fur": {
        "queries": [
            {"q": "filetype:bitmap cat fur white background", "must": ["cat"]},
            {"q": "filetype:bitmap dog white background", "must": ["dog"]},
            {"q": "filetype:bitmap rabbit white background", "must": ["rabbit"]},
            {"q": "filetype:bitmap horse white background", "must": ["horse"]},
        ],
        # A subject word can appear on an object *about* the animal (a Roman
        # bowl "with rabbit representation", a rabbit ambigram). Those are not
        # fur-edge tests, so reject the tell-tale words outright.
        "reject": [
            "ambigram", "fragment", "representation", "sculpture", "statue",
            "engraving", "drawing", "painting", "taxiderm", "bowl", "coin",
            "yacht", "ship", "boat", "volkswagen", "pickup",
        ],
        "want": 8,
        "min_side": 600,
    },
    "glass-transparent": {
        "queries": [
            {"q": "filetype:bitmap drinking glass white background", "must": ["glass"]},
            {"q": "filetype:bitmap glass bottle transparent", "must": ["bottle"]},
            {"q": "filetype:bitmap wine glass white background", "must": ["wine", "glass"]},
            {"q": "filetype:bitmap perfume bottle white background", "must": ["perfume"]},
        ],
        "want": 8,
        "min_side": 600,
    },
    "accessory": {
        "queries": [
            {"q": "filetype:bitmap shoe white background", "must": ["shoe"]},
            {"q": "filetype:bitmap wristwatch white background", "must": ["watch"]},
            {"q": "filetype:bitmap handbag white background", "must": ["bag", "handbag"]},
            {"q": "filetype:bitmap belt white background", "must": ["belt"]},
        ],
        "want": 8,
        "min_side": 600,
    },
    "complex-bg": {
        # A fair separation test is a *clear subject* against a cluttered
        # background, not a landscape or an empty car park with no subject at all
        # (where an empty mask is arguably correct). Each query names its subject.
        "queries": [
            {"q": "filetype:bitmap woman standing outdoors", "must": ["woman"]},
            {"q": "filetype:bitmap man standing outdoors", "must": ["man"]},
            {"q": "filetype:bitmap dog running grass", "must": ["dog"]},
            {"q": "filetype:bitmap cat sitting garden", "must": ["cat"]},
            {"q": "filetype:bitmap statue park monument", "must": ["statue", "monument"]},
            {"q": "filetype:bitmap flower garden closeup", "must": ["flower"]},
        ],
        # "Car park" / "dog park" titles are places, not subjects; paintings and
        # drawings are not photographs; nude frames are not appropriate fixtures.
        "reject": [
            "car park", "parking", "garage", "dog park",
            "nude", "naked",
            "painting", "drawing", "sketch", "engraving", "lithograph",
            "poster", "cartoon", "illustration",
        ],
        "want": 8,
        "min_side": 600,
    },
    "large": {
        "queries": [
            {"q": "filetype:bitmap flower white background", "must": ["flower"]},
            {"q": "filetype:bitmap plant white background", "must": ["plant"]},
            {"q": "filetype:bitmap fruit white background", "must": ["fruit"]},
            {"q": "filetype:bitmap vegetable white background", "must": ["vegetable"]},
            {"q": "filetype:bitmap flower bouquet", "must": ["bouquet", "flower"]},
            {"q": "filetype:bitmap potted plant white background", "must": ["plant", "pot"]},
            {"q": "filetype:bitmap fruit isolated white background", "must": ["fruit"]},
            {"q": "filetype:bitmap vegetable isolated white background", "must": ["vegetable"]},
            {"q": "filetype:bitmap leaf white background", "must": ["leaf"]},
            {"q": "filetype:bitmap mushroom white background", "must": ["mushroom"]},
            {"q": "filetype:bitmap cactus white background", "must": ["cactus"]},
            {"q": "filetype:bitmap tree white background", "must": ["tree"]},
        ],
        "want": 8,
        "min_side": 1500,
        # The app rejects images whose longest side exceeds 4096 px, so "large"
        # means "big but supported", not "over the product's own limit".
        "max_side": 4096,
        # Wikimedia may serve a 2x thumbnail, so request 1920 to keep the served
        # file (up to 3840 px) inside the app's 4096 px limit.
        "thumb_width": 1920,
    },
    "thin-structure": {
        "queries": [
            {"q": "filetype:bitmap eyeglasses white background", "must": ["glasses"]},
            {"q": "filetype:bitmap fork cutlery", "must": ["fork", "cutlery"]},
            {"q": "filetype:bitmap scissors", "must": ["scissor"]},
            {"q": "filetype:bitmap necklace", "must": ["necklace"]},
            {"q": "filetype:bitmap key white background", "must": ["key"]},
            {"q": "filetype:bitmap chain metal links", "must": ["chain"]},
            {"q": "filetype:bitmap bracelet jewellery", "must": ["bracelet"]},
            {"q": "filetype:bitmap pen ballpoint", "must": ["pen"]},
        ],
        "want": 8,
        "min_side": 600,
    },
}

# At most this many images from any one search query, so a single query cannot
# fill a whole category and crowd out the other subjects in it.
MAX_PER_QUERY = 4

# Rejected for every category: the set is meant to be photographs of real
# subjects, not artworks or diagrams (whose edges are not the product's job).
GLOBAL_REJECT = [
    "painting", "drawing", "sketch", "engraving", "lithograph", "etching",
    "woodcut", "watercolour", "watercolor", "fresco", "mosaic", "manuscript",
    "illustration", "cartoon", "diagram", "logo", "coat of arms", "map of",
]

# At most this many images per *series*. Wikimedia collections contain dozens of
# near-identical frames (one object photographed from many angles, a
# photographer's burst); letting one series fill a category would make the set
# look broad while testing a single subject.
MAX_PER_SERIES = 2


def api_get(params: dict, attempts: int = 6) -> dict:
    """GET the Commons API, backing off on the 429s it returns under load."""
    url = COMMONS_API + "?" + urllib.parse.urlencode(params)
    for attempt in range(attempts):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as exc:
            if exc.code != 429 or attempt == attempts - 1:
                raise
            time.sleep(5 * (attempt + 1))  # 5, 10, 15, 20, 25 s
    raise RuntimeError("unreachable")


def search(query: str, limit: int = 50, thumb_width: int = 1280) -> list[dict]:
    # A *standard* thumbnail width matters: Wikimedia throttles the on-demand
    # generation of non-standard sizes, so requesting an arbitrary width (e.g.
    # 1600) returns HTTP 429 under any real volume. 1280 and 2560 are standard.
    data = api_get(
        {
            "action": "query",
            "format": "json",
            "generator": "search",
            "gsrsearch": query,
            "gsrnamespace": "6",
            "gsrlimit": str(limit),
            "prop": "imageinfo|categories",
            "cllimit": "max",
            "iiprop": "url|size|mime|extmetadata",
            "iiurlwidth": str(thumb_width),
        }
    )
    rows = []
    for page in (data.get("query", {}).get("pages", {}) or {}).values():
        info = (page.get("imageinfo") or [{}])[0]
        meta = info.get("extmetadata", {})
        license_name = (meta.get("LicenseShortName", {}).get("value") or "").strip()
        rows.append(
            {
                "title": page.get("title"),
                "license": license_name,
                "license_url": (meta.get("LicenseUrl", {}).get("value") or "").strip(),
                "page": info.get("descriptionurl"),
                "download": (info.get("thumburl") or "").split("?")[0],
                "width": info.get("thumbwidth") or info.get("width"),
                "height": info.get("thumbheight") or info.get("height"),
                "original_width": info.get("width"),
                "original_height": info.get("height"),
                "mime": info.get("mime"),
                "categories": [c.get("title", "") for c in (page.get("categories") or [])],
            }
        )
    return rows


# Wikimedia category names that mark a file as an artwork or diagram rather than a
# photograph. Category membership is a far more reliable signal than the title
# (an artwork's title is often just "Artist - Subject", with no tell-tale word).
ART_CATEGORIES = (
    "paintings", "drawings", "engravings", "prints", "illustrations",
    "lithographs", "woodcuts", "etchings", "artworks",
    "manuscripts", "maps", "diagrams", "coats of arms", "logos",
)


def is_artwork(row: dict) -> bool:
    for cat in row.get("categories", []):
        low = cat.lower()
        if any(word in low for word in ART_CATEGORIES):
            return True
    return False


def acceptable(row: dict, min_side: int, max_side: int | None = None) -> bool:
    if normalize_license(row["license"]) not in APPROVED_LICENSES:
        return False
    if not row["download"] or not row["width"] or not row["height"]:
        return False
    # Only raster formats the browser can decode.
    if row["mime"] not in ("image/jpeg", "image/png", "image/webp"):
        return False
    if min(row["width"], row["height"]) < min_side:
        return False
    if max_side and max(row["width"], row["height"]) > max_side:
        return False
    # Prefer a generated thumbnail over the original file. Wikimedia throttles
    # bursts of originals (upload.wikimedia.org) hard, and its own guidance is to
    # use thumbnails at the standard widths; thumb.wikimedia.org is served
    # reliably. Requesting a standard width also guarantees the URL is a thumb
    # unless the original is smaller than that width.
    if "thumb.wikimedia.org" not in row["download"]:
        return False
    return True


def series_key(title: str) -> str:
    """Collapse a title to a coarse key so near-duplicate frames group together.

    Commons series share a long prefix and differ only by a trailing
    discriminator ("… 4288743", "… (cropped)", "… photo 2 of 16"). After
    dropping parenthetical groups and any trailing numbered/qualifier tail, the
    first few words are enough to identify the series: "Six wine glasses in …"
    and "Six wine glasses with …" collapse to the same key.
    """
    name = title.replace("File:", "").rsplit(".", 1)[0]
    name = re.sub(r"[(\[][^)\]]*[)\]]", " ", name)  # drop parenthetical groups
    name = re.sub(r"\b(photo|image|img|frame|plate|scan|copy|no)\b.*$", " ", name, flags=re.I)
    name = re.sub(r"\d+.*$", " ", name)  # drop trailing numbers and the tail
    words = re.findall(r"[A-Za-z]+", name.lower())
    return " ".join(words[:3])


def title_matches(title: str, must: list[str], reject: list[str] | None = None) -> bool:
    """True if a required subject word appears in the title and no reject word does.

    Matching on the title (not the search ranking) keeps irrelevant hits out:
    Commons full-text search ranks on the whole index, so "…white background"
    alone returns portraits and landscapes that merely mention it. Parenthetical
    text is stripped first so a credit like "(… Bad Dog Rock)" cannot satisfy a
    "dog" requirement. `reject` drops known off-target matches such as an object
    that merely depicts the subject.
    """
    if not must:
        return True
    core = re.sub(r"[(\[][^)\]]*[)\]]", " ", title).lower()
    if reject and any(word in core for word in reject):
        return False
    return any(word in core for word in must)


def build(only: str | None, base: dict | None = None) -> dict:
    categories = []
    seen_titles: set[str] = set()
    existing_by_cat = {}
    if base:
        for c in base.get("categories", []):
            existing_by_cat[c["category"]] = c
    for cat, cfg in CATEGORIES.items():
        if only and cat != only:
            # Keep the previous category verbatim when rebuilding one category.
            if cat in existing_by_cat:
                categories.append(existing_by_cat[cat])
                for img in existing_by_cat[cat]["images"]:
                    seen_titles.add(img["title"])
            continue
        picked: list[dict] = []
        series_count: dict[str, int] = {}
        thumb_width = cfg.get("thumb_width", 1280)
        for spec in cfg["queries"]:
            query = spec["q"] if isinstance(spec, dict) else spec
            must = spec.get("must", []) if isinstance(spec, dict) else []
            if len(picked) >= cfg["want"]:
                break
            try:
                rows = search(query, thumb_width=thumb_width)
            except Exception as exc:  # network hiccup: keep going, other queries may work
                print(f"  ! query failed ({query}): {exc}", file=sys.stderr)
                continue
            from_query = 0
            for row in rows:
                if len(picked) >= cfg["want"] or from_query >= MAX_PER_QUERY:
                    break
                if row["title"] in seen_titles:
                    continue
                if not title_matches(row["title"], must, GLOBAL_REJECT + (cfg.get("reject") or [])):
                    continue
                if is_artwork(row):
                    continue
                if not acceptable(row, cfg["min_side"], cfg.get("max_side")):
                    continue
                key = series_key(row["title"])
                if series_count.get(key, 0) >= MAX_PER_SERIES:
                    continue
                seen_titles.add(row["title"])
                series_count[key] = series_count.get(key, 0) + 1
                from_query += 1
                picked.append(row)
            time.sleep(1.0)
        # If this category already had images and the fresh search came up short
        # (rate limiting), keep the ones we had rather than regressing.
        if base and len(picked) < cfg["want"] and cat in existing_by_cat:
            for old in existing_by_cat[cat]["images"]:
                if len(picked) >= cfg["want"]:
                    break
                if old["title"] not in {p["title"] for p in picked}:
                    picked.append(old)
        for i, row in enumerate(picked, start=1):
            row["id"] = f"{cat}-{i:02d}"
            row["category"] = cat
        categories.append({"category": cat, "want": cfg["want"], "images": picked})
        print(f"  {cat}: {len(picked)}/{cfg['want']}")
    total = sum(len(c["images"]) for c in categories)
    return {"version": 1, "generated_by": "scripts/eval/build-eval-set.py", "total": total, "categories": categories}


def download(manifest: dict, only: str | None) -> None:
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    for cat in manifest["categories"]:
        if only and cat["category"] != only:
            continue
        for img in cat["images"]:
            suffix = Path(urllib.parse.urlparse(img["download"]).path).suffix or ".jpg"
            dest = IMAGE_DIR / f"{img['id']}{suffix}"
            if dest.exists():
                data = dest.read_bytes()
                img["sha256"] = hashlib.sha256(data).hexdigest()
                img["bytes"] = len(data)
                try:
                    with Image.open(dest) as im:
                        img["width"], img["height"] = im.size
                except Exception as exc:
                    print(f"  ! {img['id']}: cannot read file ({exc})", file=sys.stderr)
                print(f"  = {dest.name} ({img['width']}x{img['height']})")
                continue
            try:
                data = fetch_bytes(img["download"])
            except Exception as exc:  # one bad image must not abort the whole set
                print(f"  ! {img['id']}: download failed ({exc})", file=sys.stderr)
                continue
            dest.write_bytes(data)
            img["sha256"] = hashlib.sha256(data).hexdigest()
            img["bytes"] = len(data)
            # Wikimedia may serve a larger thumbnail than requested (its
            # responsive "2x" variant), so trust the file, not the API metadata.
            try:
                with Image.open(dest) as im:
                    img["width"], img["height"] = im.size
            except Exception as exc:
                print(f"  ! {img['id']}: cannot read downloaded file ({exc})", file=sys.stderr)
            print(f"  + {dest.name} ({len(data)} bytes, {img['width']}x{img['height']})")
            time.sleep(2.0)  # be a good citizen; Wikimedia throttles bursts of originals


def fetch_bytes(url: str, attempts: int = 5) -> bytes:
    for attempt in range(attempts):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as exc:
            if exc.code != 429 or attempt == attempts - 1:
                raise
            time.sleep(3 * (attempt + 1))  # 3, 6, 9, 12 s
    raise RuntimeError("unreachable")


def verify(manifest: dict) -> int:
    """Check the committed images against the manifest (no network).

    Used in CI so the pinned set cannot silently drift: every image must exist,
    decode, match its recorded dimensions and SHA-256, and stay within the app's
    own limits (largest side <= 4096 px, per image-validation.ts).
    """
    problems: list[str] = []
    for cat in manifest["categories"]:
        for img in cat["images"]:
            found = None
            for ext in (".jpg", ".JPG", ".jpeg", ".png", ".webp"):
                p = IMAGE_DIR / f"{img['id']}{ext}"
                if p.exists():
                    found = p
                    break
            if not found:
                problems.append(f"{img['id']}: file missing")
                continue
            data = found.read_bytes()
            if img.get("sha256") and hashlib.sha256(data).hexdigest() != img["sha256"]:
                problems.append(f"{img['id']}: sha256 mismatch")
            if img.get("bytes") and len(data) != img["bytes"]:
                problems.append(f"{img['id']}: size mismatch ({len(data)} != {img['bytes']})")
            if normalize_license(img.get("license", "")) not in APPROVED_LICENSES:
                problems.append(f"{img['id']}: unapproved licence {img.get('license')!r}")
            if Image is None:
                continue
            try:
                with Image.open(found) as im:
                    w, h = im.size
            except Exception as exc:
                problems.append(f"{img['id']}: cannot decode ({exc})")
                continue
            if (w, h) != (img["width"], img["height"]):
                problems.append(f"{img['id']}: dims {w}x{h} != {img['width']}x{img['height']}")
            if max(w, h) > 4096:
                problems.append(f"{img['id']}: {w}x{h} exceeds the app's 4096 px limit")
    if problems:
        print(f"Evaluation set has {len(problems)} problem(s):", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    print(f"Evaluation set OK: {manifest['total']} images, manifest matches the committed files.")
    return 0


def write_attribution(manifest: dict) -> None:
    """Write eval/ATTRIBUTION.md from the manifest.

    The set mixes CC0/public-domain images (no conditions) with CC BY / CC BY-SA
    images, which *do* require attribution. Keeping the credit list generated
    from the same manifest that pins the bytes means the two cannot drift.
    """
    lines = [
        "# Evaluation set — image credits",
        "",
        "Generated by `scripts/eval/build-eval-set.py` from `eval/manifest.json`.",
        "Each image is redistributed under its own licence: CC0 or public domain",
        "(no conditions) or CC BY (attribution only). The licence and source page",
        "are listed below and in the manifest. Do not edit this file by hand.",
        "",
    ]
    for cat in manifest["categories"]:
        lines.append(f"## {cat['category']}")
        lines.append("")
        for img in cat["images"]:
            title = img["title"].replace("File:", "")
            lines.append(f"- **{img['id']}** — *{title}* — {img['license']}")
            if img.get("page"):
                lines.append(f"  - Source: {img['page']}")
            if img.get("license_url"):
                lines.append(f"  - Licence: {img['license_url']}")
        lines.append("")
    (ROOT / "eval" / "ATTRIBUTION.md").write_text("\n".join(lines))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true", help="fetch the images into eval/images/")
    parser.add_argument("--verify", action="store_true", help="check eval/images/ against the manifest (offline)")
    parser.add_argument("--only", help="restrict to one category")
    parser.add_argument("--rebuild", action="store_true", help="re-search Commons even if a manifest exists")
    parser.add_argument("--merge", action="store_true", help="keep existing sha256/bytes when rebuilding")
    args = parser.parse_args()

    if args.verify:
        if not MANIFEST_PATH.exists():
            print(f"No manifest at {MANIFEST_PATH}", file=sys.stderr)
            return 1
        return verify(json.loads(MANIFEST_PATH.read_text()))

    # `--download` on its own must not re-run the searches (that would hit the
    # API again for no reason and risk throttling); it just fetches the pinned
    # URLs from the existing manifest.
    if args.download and MANIFEST_PATH.exists() and not args.rebuild and not args.only:
        manifest = json.loads(MANIFEST_PATH.read_text())
        print(f"Downloading {manifest['total']} pinned images…")
        download(manifest, None)
        MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        return 0

    existing = {}
    base = None
    # `--only` rebuilds one category in place, so it must start from the current
    # manifest or it would silently drop the other seven.
    if (args.merge or args.only) and MANIFEST_PATH.exists():
        base = json.loads(MANIFEST_PATH.read_text())
        for cat in base["categories"]:
            for img in cat["images"]:
                existing[img["id"]] = img

    print("Building evaluation set from Wikimedia Commons…")
    manifest = build(args.only, base)
    for cat in manifest["categories"]:
        for img in cat["images"]:
            if img["id"] in existing:
                img.setdefault("sha256", existing[img["id"]].get("sha256"))
                img.setdefault("bytes", existing[img["id"]].get("bytes"))

    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    write_attribution(manifest)
    print(f"Wrote {MANIFEST_PATH} ({manifest['total']} images)")

    if args.download:
        download(manifest, args.only)
        MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        write_attribution(manifest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
