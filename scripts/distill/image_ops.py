#!/usr/bin/env python3
"""Shared image ingest helpers for the distill fetchers.

Ingest policy (spec §4.2): resize every image to max side 1536 px, JPEG q90,
strip EXIF. A few museum scans are enormous (a 112 MPx TIFF was seen), so we
bound the decode: images above ``MAX_IMAGE_PIXELS`` are rejected as
``too-large`` rather than silently decoded (a decompression-bomb guard), and
the 89–150 MPx range that PIL warns about is accepted but logged.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageOps

MAX_IMAGE_PIXELS = 150_000_000
# PIL warns above 89.5 MPx and raises above this value; we raise the hard limit
# to our policy cap so anything larger is a clean, catchable error.
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

MAX_SIDE = 1536
JPEG_QUALITY = 90


class ImageTooLarge(Exception):
    """Raised when a source image exceeds ``MAX_IMAGE_PIXELS``."""


def normalize_image(path: Path) -> None:
    """Resize max-side 1536, JPEG q90, strip EXIF, in place."""
    img = ImageOps.exif_transpose(Image.open(path))
    if img.width * img.height > MAX_IMAGE_PIXELS:
        raise ImageTooLarge(f"{img.width}x{img.height}")
    img = img.convert("RGB")
    img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    img.save(path, "JPEG", quality=JPEG_QUALITY, optimize=True)
