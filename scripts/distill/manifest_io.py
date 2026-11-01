#!/usr/bin/env python3
"""Crash-safe, concurrency-safe manifest writing shared by the fetchers.

Each fetcher accumulates rows in memory and rewrites ``data/manifest.csv``.
Two hazards motivated this module:

1. **Lost rows on restart / concurrent writers.** A plain "write my rows"
   drops any row another process (or an earlier run) already persisted. We
   union the on-disk rows with the in-memory rows, keyed by ``sha256``, so a
   restart or a second writer can never shrink the manifest.
2. **Torn writes.** Writes go to a temp file and are ``os.replace``d under an
   ``flock`` on ``<manifest>.lock``, so a reader never sees a partial file and
   two writers serialise their read-union-write.

Rows are de-duplicated by ``sha256``; the last row for a given hash wins.
"""

from __future__ import annotations

import csv
import fcntl
import os
import time
from pathlib import Path


def merge_write(path: Path, headers: list[str], rows: list[dict],
                key: str = "sha256") -> int:
    """Atomically merge ``rows`` into the CSV at ``path``; return total rows."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    merged: dict[str, dict] = {}

    with open(str(path) + ".lock", "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            if path.exists():
                with open(path) as f:
                    for r in csv.DictReader(f):
                        if r.get(key):
                            merged[r[key]] = r
            for r in rows:
                if r.get(key):
                    merged[r[key]] = r
            tmp = path.with_suffix(path.suffix + ".tmp")
            with open(tmp, "w", newline="") as f:
                w = csv.DictWriter(f, fieldnames=headers)
                w.writeheader()
                for r in merged.values():
                    w.writerow({h: r.get(h, "") for h in headers})
            os.replace(tmp, path)
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)
    return len(merged)


class ManifestWriter:
    """Throttled, crash-safe writer over :func:`merge_write`.

    Calling ``merge_write`` after every row is O(n^2) at 10k scale, so we
    coalesce: ``maybe_flush`` persists at most once per ``interval`` seconds
    (or once ``min_rows`` new rows accumulated), while ``flush`` forces a
    write. ``rows`` is the fetcher's live list (held by reference); callers
    must call ``flush`` at exit.
    """

    def __init__(self, path: Path, headers: list[str], rows: list[dict],
                 interval: float = 3.0, min_rows: int = 25) -> None:
        self.path = Path(path)
        self.headers = headers
        self.rows = rows
        self.interval = interval
        self.min_rows = min_rows
        self._last = time.time()
        self._pending = 0

    def mark(self, n: int = 1) -> None:
        self._pending += n

    def maybe_flush(self) -> None:
        if self._pending >= self.min_rows or time.time() - self._last >= self.interval:
            self.flush()

    def flush(self) -> None:
        merge_write(self.path, self.headers, self.rows)
        self._last = time.time()
        self._pending = 0
