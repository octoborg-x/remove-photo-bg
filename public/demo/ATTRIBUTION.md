# Demo image credits

The before/after pairs in this directory are model outputs, not mock-ups:

- `-before.webp` is the original photo, downscaled to at most 720 px wide.
- `-after.webp` is the RGBA cut-out produced by the pinned Background Model 512 model
  (`model_512_int8_fp16.onnx`, SHA-256
  `10f1cf12d614b8b9db8a8dc9183c8525cbf6e020bb230e9b15daaf127012bc26`), then
  downscaled and re-encoded to WebP.

All eight photos were supplied by the project owner for this landing page and
are stored as `test-images/<name>.jpg` at their original resolution. No
third-party source URL applies.

| Pair | Source file |
|---|---|
| `perfume-bottle` | `test-images/perfume-bottle.jpg` |
| `golden-retriever` | `test-images/golden-retriever.jpg` |
| `crystal-vase` | `test-images/crystal-vase.jpg` |
| `road-bicycle` | `test-images/road-bicycle.jpg` |
| `flower-bouquet` | `test-images/flower-bouquet.jpg` |
| `wristwatch` | `test-images/wristwatch.jpg` |
| `denim-jacket` | `test-images/denim-jacket.jpg` |
| `coffee-machine` | `test-images/coffee-machine.jpg` |

The pairs are rebuilt by `scripts/build-demo-assets.mjs` from those sources and
the model's full-resolution cut-outs.
