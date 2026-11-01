# Distillation Provenance and Licence Gate

> Phase 1 working document (spec `optimize_model_plan/audit.md` §5). Records, for
> every dataset, image source, pretrained backbone, library and code snippet:
> source URL, version/revision, licence name, licence-file URL, date checked,
> whether redistribution of derived weights is allowed, and any open question.
>
> **This is not legal advice.** Nothing here declares anything "legally cleared".
> Facts are marked **verified** (checked against the authoritative source at the
> date shown) or **unverified**. The question of whether CC-BY training data
> affects distributed weights is **open** and reported, not resolved (spec §5).

## 1. Teacher (production model)

| field | value |
|---|---|
| Artifact | `model_512.onnx`, 193,514,682 bytes |
| SHA-256 | `eaafaa10f19c63b77e2bae77bf4b2f59054c208ea08b8c6648f95ef36a3b6b87` |
| Download URL (anonymous, works) | `https://huggingface.co/spaces/Octoborg/remove-photo-bg/resolve/main/models/model_512.onnx` |
| Note | The **repo** path `huggingface.co/Octoborg/remove-photo-bg/resolve/main/model_512.onnx` returns **401**; the file lives in the **Space**, not a model repo (verified 2026-11-01) |
| Upstream | `ZhengPeng7/BiRefNet_lite`, licence **MIT** (HF `cardData.license = "mit"`, tag `license:mit`, verified 2026-11-01) |
| Optional 1024 teacher | `onnx-community/BiRefNet_lite-ONNX`, revision `de15b22ba131738a16dff04aab8bdf8dc32e3ac1`, sha256 `d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402` (per spec §1) — **MIT** (verified 2026-11-01) |

Redistribution of derived weights: MIT permits it, provided the licence and
copyright notice are preserved (see `THIRD_PARTY_LEGAL_NOTICES.md` for the
verbatim MIT text and the fuller audit).

## 2. Excluded models (spec §5)

| model | licence (HF API, 2026-11-01) | decision |
|---|---|---|
| `briaai/RMBG-1.4` | `other` (not a standard SPDX id) | **excluded** (spec §5) |

## 3. Image sources

### 3.1 Wikimedia Commons (`scripts/distill/fetch-cc0.py`)

| field | value |
|---|---|
| Source | Wikimedia Commons API `https://commons.wikimedia.org/w/api.php` |
| Licence field used | per-file `imageinfo.extmetadata.License` (machine-readable) — **never** the site's general claim (spec §5) |
| Kept tags | `{cc0, pd, pdm, public domain, cc-pd-mark}` |
| Dropped substrings | `-sa`, `-nc`, `noncommercial`, `sharealike` |
| Licence page | https://commons.wikimedia.org/wiki/Commons:Licensing (checked 2026-11-01, HTTP 200) |
| Redistribution of derived weights | CC0/PD allow it; attribution text preserved in the manifest for CC-BY rows (none kept yet) |

### 3.2 The Met Open Access (`scripts/distill/fetch-met.py`)

| field | value |
|---|---|
| Source | The Met Collection API `https://collectionapi.metmuseum.org/public/collection` |
| Gate | `isPublicDomain == true` **and** a non-empty `primaryImage` |
| Licence recorded | `CC0 1.0`, `https://creativecommons.org/publicdomain/zero/1.0/` (checked 2026-11-01, HTTP 200) |
| API note | `/public/collection/v1/search` **retired 2026-10-01** (HTTP 410); search is now `/public/collection/v1.1/search`; object details stay on `/v1/objects/{id}` |
| Redistribution of derived weights | CC0 allows it |

### 3.3 Licence reference pages checked (2026-11-01)

| page | result |
|---|---|
| `https://creativecommons.org/publicdomain/zero/1.0/` | HTTP 200 |
| `https://commons.wikimedia.org/wiki/Commons:Licensing` | HTTP 200 |
| `https://www.metmuseum.org/about-the-met/policies-and-documents/open-access` | HTTP 429 at check time (rate-limited); **not re-verified this session** |

## 4. Pinned libraries (spec §5)

Versions pinned in `scripts/distill/requirements-distill.txt`. Licence verified
against the authoritative source (PyPI metadata and/or the upstream repository)
on **2026-11-01**:

| package | version | licence | source of licence fact |
|---|---|---|---|
| onnxruntime | 1.31.1 | MIT | PyPI `license = "MIT License"` |
| onnx | >=1.16.0 | Apache-2.0 | `onnx/onnx` GitHub `license.spdx_id` |
| onnxoptimizer | >=0.3.13 | Apache-2.0 | `onnx/optimizer` GitHub `license.spdx_id` |
| onnxsim | >=0.4.33 | Apache-2.0 | `daquexian/onnx-simplifier` GitHub `license.spdx_id` |
| numpy | 1.26.4 | BSD-3-Clause | `numpy/numpy` LICENSE text ("Redistribution and use in source and binary forms …") |
| pillow | >=10.0 | HPND (PIL licence) | `python-pillow/Pillow` LICENSE text ("The Python Imaging Library (PIL) is Copyright © 1997-2011 by Secret Labs AB …") |
| requests | >=2.31 | Apache-2.0 | PyPI `license = "Apache-2.0"` |
| timm | >=1.0.3 | Apache-2.0 | PyPI `license = "Apache-2.0"` |
| albumentations | >=1.4.0 | MIT | PyPI `license = "MIT License"` |
| pymatting | >=1.1.11 | MIT | PyPI `license = "MIT"` |

**Open item (spec §5):** `pymatting` is used in Phase 2 for foreground-colour
estimation. Its MIT licence and pinned version are recorded here; the exact
version used must be re-confirmed when `composite.py` lands.

## 5. Open questions (reported, not resolved — spec §5)

1. Whether CC-BY training data affects the licence of the **distributed
   student weights** is an open legal question. No CC-BY rows have been kept
   yet; only CC0/PD. If CC-BY rows are later added, attribution must be
   preserved in this file.
2. The Met open-access policy page could not be re-verified this session
   (HTTP 429). The per-object `isPublicDomain` flag is the operative gate and
   is recorded per row.
3. `data/own/` (user's own product photos) is not yet supplied; those images
   have no third-party licence question but are not committed.

_Measured counts per source/tier/split/category are delivered in
`DISTILL_PLAN.md` §delivery once Phase 1 fetching completes._
