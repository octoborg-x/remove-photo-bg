# Ground-truth masks

The descriptive metrics in `EVALUATION.md` measure the *shape* of a cut-out, not
whether it is *correct*. The only way to get an accuracy number (IoU, Dice,
boundary-F, MAE) is to compare against a mask a human drew. This directory holds
those reference masks.

## What goes here

One mask per eval image id, named exactly like the image:

```
eval/ground-truth/ordinary-product-01.png
eval/ground-truth/hair-fur-03.png
```

`accuracy-benchmark.py` looks for `<id>.png` (preferred) or `<id>.npy`:

- **PNG** — an 8-bit mask. It reads the **alpha channel** if the file has one;
  a fully-opaque PNG is read as **luminance** instead (white = foreground,
  black = background). Soft values (a grey ramp) are allowed and expected on
  hair and fur.
- **NPY** — a float array, either `0..1` or `0..255`.

A mask may be any size; it is nearest-neighbour resized to the output's size
before scoring, so it can be authored at the source image's resolution.

## How to author one

1. Run the harness once and open the output PNG for the image
   (`eval-results/<run>/outputs/<id>.png`).
2. Trace the true subject with any mask/segmentation tool (GIMP, Photoshop,
   Krita, or a SAM/rembg pass you then correct by hand) and export a black/white
   mask — white where the subject is, black where the background is.
3. Save it here as `<id>.png` and re-run:

   ```sh
   npm run eval:benchmark -- eval-results/wasm
   ```

   The `Accuracy (n=…)` line and the `iou`/`dice`/`boundary_f`/`mae` columns fill
   in for exactly the images that have a mask.

## How many masks

- **All 64** gives a headline accuracy number for the whole set. This is the
  goal for a release gate.
- **A representative subset** (start with the 8 `error-` images in `images-test/`
  plus 2 per remaining category, ~24) is enough to catch a regression and to
  validate the gate values in `eval/thresholds.json`.
- **A few** (even 3) still turn the benchmark from "descriptive" into "scored";
  the report says `n=` so a reader always knows how much of the set is scored.

## Caveats

- These masks are **human judgement**, not absolute truth. Label the same image
  twice (or with two tools) and the agreement between them is the ceiling any
  model can reach — report that ceiling next to the model's score.
- Keep the license of any tool used to author a mask compatible with the
  project's copyleft-free audit (`LICENSE_AUDIT.md`); a mask traced by hand over
  a CC0/PD/CC-BY image inherits that image's license.
- A mask is data, not code: commit it, and pin its SHA-256 in
  `eval/ground-truth/manifest.json` (optional, for drift detection).
