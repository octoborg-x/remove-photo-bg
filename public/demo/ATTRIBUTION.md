# Demo image credits

The before/after pairs in this directory are model outputs, not mock-ups:

- `-before.webp` is the original photo.
- `-after.webp` is the RGBA cut-out produced by the pinned QMix Cut-512 model
  (`model_512_int8_fp16.onnx`, SHA-256
  `10f1cf12d614b8b9db8a8dc9183c8525cbf6e020bb230e9b15daaf127012bc26`), then
  downscaled and re-encoded to WebP. The `phone` pair is cropped around the
  subject in both files.

| Pair | Original photo | Licence |
|---|---|---|
| `product-scent-bottle` | `test-images/product-scent-bottle.jpg` (Wikimedia Commons) | Public domain |
| `animal-buddy-dog` | `test-images/animal-buddy-dog.jpg` (Wikimedia Commons) | Public domain |
| `glass-wine` | `test-images/glass-wine.jpg` (Wikimedia Commons) | Public domain |
| `shoes` | `eval/images/accessory-03.jpg` — *Mens' ballroom shoes, Eurodance CZ.jpg* — https://commons.wikimedia.org/wiki/File:Mens%27_ballroom_shoes,_Eurodance_CZ.jpg | Public domain |
| `sneakers` | Rawpixel — *White sneaker pink LED lights* — https://www.rawpixel.com/image/11524416/white-sneaker-with-pink-led-lights | CC0 1.0 |
| `phone` | Rawpixel — *Free hello screen iPhone wood* — https://www.rawpixel.com/image/5926451/photo-image-background-iphone-phone | CC0 1.0 |
| `watch` | `eval/images/accessory-05.jpg` — *Generic analog watch.jpg* — https://commons.wikimedia.org/wiki/File:Generic_analog_watch.jpg | CC0 1.0 |
| `tshirt` | `eval/images/clothing-02.jpg` — *Just a shirt.jpg* — https://commons.wikimedia.org/wiki/File:Just_a_shirt.jpg | CC BY 2.0 |
| `jogging` | Wikimedia Commons — *Guy jogging by sign (Unsplash).jpg* — https://commons.wikimedia.org/wiki/File:Guy_jogging_by_sign_(Unsplash).jpg | CC0 1.0 |

The original three pairs are rebuilt by `scripts/build-demo-assets.mjs`; the
other six were produced from the sources above with the same pinned model.
