#!/usr/bin/env python3
"""Graph census for an ONNX model: where the bytes go, and what is dead.

Answers the questions the optimisation brief asks before any conversion:
  1. How much of the file is initializer data vs. graph structure?
  2. What is the dtype breakdown of those initializers?
  3. Which initializers are never consumed by a live node (dead weight)?
  4. Are there duplicate initializers (same bytes, two names)?
  5. Which ops are present, and which appear more than once?

Nothing is modified; the script only reads and reports.

Usage:
    python3 -m scripts.distill.onnx-census --model public/models/model_512_int0_fp32.onnx
"""

from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper

# Storage width per element type, in bytes, for the types this graph can hold.
DTYPE_BYTES = {
    onnx.TensorProto.FLOAT: 4,
    onnx.TensorProto.FLOAT16: 2,
    onnx.TensorProto.DOUBLE: 8,
    onnx.TensorProto.INT8: 1,
    onnx.TensorProto.UINT8: 1,
    onnx.TensorProto.INT16: 2,
    onnx.TensorProto.INT32: 4,
    onnx.TensorProto.INT64: 8,
    onnx.TensorProto.BOOL: 1,
}
DTYPE_NAME = {v: k for k, v in onnx.TensorProto.DataType.items()}


def bytes_of(init) -> int:
    per = DTYPE_BYTES.get(init.data_type)
    if per is not None:
        n = int(np.prod(init.dims)) if init.dims else 1
        return per * n
    return len(init.raw_data)


def census(model_path: Path) -> dict:
    m = onnx.load(str(model_path), load_external_data=False)
    g = m.graph

    file_bytes = model_path.stat().st_size

    by_dtype: Counter = Counter()
    total_init = 0
    for init in g.initializer:
        b = bytes_of(init)
        by_dtype[DTYPE_NAME.get(init.data_type, str(init.data_type))] += b
        total_init += b

    # Node inputs minus initializers are activations; node outputs are produced.
    produced = {o for node in g.node for o in node.output}
    consumed = {i for node in g.node for i in node.input if i}
    init_names = {init.name for init in g.initializer}

    dead_inits = [init.name for init in g.initializer if init.name not in consumed]

    # Reachability from the graph outputs, walking node output -> consumer edges.
    live_tensors = set(g.output and [o.name for o in g.output])
    live_nodes = set()
    changed = True
    while changed:
        changed = False
        for i, node in enumerate(g.node):
            if i in live_nodes:
                continue
            if any(o in live_tensors for o in node.output):
                live_nodes.add(i)
                for inp in node.input:
                    if inp and inp not in live_tensors:
                        live_tensors.add(inp)
                        changed = True
    dead_nodes = [n for i, n in enumerate(g.node) if i not in live_nodes]

    # Duplicate initializers: identical bytes under two names.
    seen: dict[bytes, list[str]] = {}
    for init in g.initializer:
        raw = init.raw_data or init.float_data and np.asarray(init.float_data).tobytes()
        if raw:
            seen.setdefault(bytes(raw), []).append(init.name)
    dupes = {k: v for k, v in seen.items() if len(v) > 1}
    dupe_bytes = sum((len(k) * (len(v) - 1)) for k, v in dupes.items())

    ops = Counter(node.op_type for node in g.node)

    return {
        "file_bytes": file_bytes,
        "initializer_bytes": total_init,
        "structural_bytes": file_bytes - total_init,
        "by_dtype": dict(by_dtype),
        "n_initializers": len(g.initializer),
        "dead_initializers": dead_inits,
        "dead_initializer_bytes": sum(
            bytes_of(i) for i in g.initializer if i.name in set(dead_inits)),
        "dead_nodes": len(dead_nodes),
        "dead_node_ops": Counter(n.op_type for n in dead_nodes),
        "n_nodes": len(g.node),
        "n_duplicate_groups": len(dupes),
        "duplicate_bytes": dupe_bytes,
        "ops": ops,
        "n_value_info": len(g.value_info),
        "produced_unused": sorted(produced - consumed),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, type=Path)
    args = ap.parse_args()

    c = census(args.model)
    f = c["file_bytes"]
    print(f"file            {f:>14,} B  ({f / 1e6:.2f} MB)")
    print(f"initializers    {c['initializer_bytes']:>14,} B  "
          f"({c['initializer_bytes'] / f * 100:.2f}% of file)  n={c['n_initializers']}")
    print(f"structure/other {c['structural_bytes']:>14,} B  "
          f"({c['structural_bytes'] / f * 100:.2f}%)")
    print("\ninitializer bytes by dtype:")
    for dt, b in sorted(c["by_dtype"].items(), key=lambda kv: -kv[1]):
        print(f"  {dt:8} {b:>14,} B  ({b / f * 100:5.2f}% of file)")
    print(f"\nnodes           {c['n_nodes']:,}   value_info {c['n_value_info']:,}")
    print(f"dead initializers {len(c['dead_initializers'])} "
          f"({c['dead_initializer_bytes']:,} B)")
    if c["dead_initializers"]:
        print(f"  e.g. {c['dead_initializers'][:5]}")
    print(f"dead nodes        {c['dead_nodes']}")
    if c["dead_node_ops"]:
        print(f"  ops: {dict(c['dead_node_ops'])}")
    print(f"duplicate init groups {c['n_duplicate_groups']} "
          f"({c['duplicate_bytes']:,} B reclaimable)")
    print(f"produced-but-unused tensors {len(c['produced_unused'])}")
    print(f"\ntop ops: {c['ops'].most_common(15)}")


if __name__ == "__main__":
    raise SystemExit(main())
