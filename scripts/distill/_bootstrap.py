"""Shared sys.path fix-up for CLI scripts in this directory.

Running `python3 scripts/distill/train.py` puts this directory first on
sys.path, so `import select` (used internally by onnxruntime/PIL/numpy)
resolves to our spec-mandated `select.py` and breaks them. We drop this
directory from sys.path and put the repo ROOT back on it (needed for the
package-style `scripts.distill.*` imports). The `select` stdlib module is
then always found.

Must be imported before onnxruntime/PIL/numpy. Safe no-op when run as a
module (`python3 -m scripts.distill.train`).
"""
from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
# remove this directory (realpath-compare; survives symlinks)
sys.path = [p for p in sys.path
            if os.path.realpath(p) != os.path.realpath(_HERE)]
_ROOT = os.path.dirname(os.path.dirname(_HERE))  # repo root
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)