# Agent guide — remove-photo-bg

Guidance for AI agents working in this repository. `MVP_OPENHANDS.md` holds the product
spec and `PHASE*_REPORT.md` the history.

## Browser harnesses & the GPU path

The browser harnesses (`scripts/run-smoke.mjs`, `scripts/eval/run-eval.mjs`, and the
others) launch Chromium CPU-only by default: `headless: 'shell'` (the old
chrome-headless-shell, which has **no WebGPU**) plus `--disable-gpu`/`--disable-webgpu`.
That default is correct for the sandbox and CI. The shared launch profile lives in
`scripts/lib/gpu-browser.mjs` (`browserArgs`, `headlessMode`, `gpuRequested`,
`assertHardwareGpu`); set `RUN_GPU=1` on a host with a real GPU to switch to the new
headless mode plus the Vulkan/WebGPU flags headless Chrome needs, and to make the
harness refuse to run on a software adapter (SwiftShader/llvmpipe). **WebGPU uses the
browser's local GPU, so a tunnel from a GPU-less machine cannot test it** — run on the
GPU host. `scripts/colab-webgpu.sh` scripts the whole Colab T4 run (drivers, flags,
build, eval). See README "WebGPU on a real GPU".

## Analytics & quality reporting

Privacy-first product analytics live in `src/features/analytics/` (consent-gated,
best-effort, no image data) and a separate Cloudflare Worker in
`cloudflare/analytics-worker/` (Workers Analytics Engine + D1). Analytics is **off
by default**: with `VITE_ANALYTICS_ENDPOINT` unset there is no banner, no events,
and the CSP stays `connect-src 'self'`. See `docs/analytics-architecture.md`,
`docs/analytics-events.md`, `docs/analytics-deployment.md`, and
`docs/quality-reporting.md`. The `no-upload-path` test still forbids image-bearing
uploads everywhere except the text-only analytics module, which is separately
asserted to contain no image code.

## Seeing an attached image (there is no vision model)

The default LLM profile here is **not vision-capable**, and every `inspect_image_with_vision`
profile fails (Gemini 401/NotFound). When the user attaches an image, do not tell them to
switch models — read the pixels locally with the recipe below. It is verified in this sandbox.

### 1. Extract the attachment bytes

Attachments are not files on disk; they are base64 inside the conversation event log at
`/workspace/conversations/<conversation-id>/events/event-*.json`. The payload is at
`llm_message.content[1].image_urls[0]` and looks like `data:image/png;base64,iVBOR…`.

```python
import json, base64, glob, os
conv = sorted(glob.glob('/workspace/conversations/*/'), key=os.path.getmtime)[-1]
for f in sorted(glob.glob(conv + 'events/*.json')):
    d = json.load(open(f))
    for c in (d.get('llm_message') or {}).get('content', []):
        if isinstance(c, dict) and c.get('image_urls'):
            head, b64 = c['image_urls'][0].split(',', 1)
            ext = 'png' if 'png' in head else 'jpg'
            open('/tmp/img/attached.' + ext, 'wb').write(base64.b64decode(b64))
```

(`grep -l image_urls events/*.json` finds the event files that carry an image.)

### 2. Install the tools once per sandbox

```bash
pip install pillow numpy
sudo apt-get update -qq && sudo apt-get install -y -qq tesseract-ocr
```

Chromium is already at `/usr/bin/chromium`; `sudo` works here.

### 3. Read it

Alpha statistics — the fastest useful signal for a background-removal *result*:

```python
from PIL import Image
import numpy as np
a = np.array(Image.open('/tmp/img/attached.png').convert('RGBA')).astype(int)
al = a[:, :, 3]
print('size', a.shape, 'frac a==0', round(float((al == 0).mean()), 4),
      'frac a==255', round(float((al == 255).mean()), 4))
ys, xs = np.where(al > 0)
print('opaque bbox x', xs.min(), xs.max(), 'y', ys.min(), ys.max())
```

Interpretation: high `frac a==0` → the background was removed. A near-fully-opaque
**rectangle** spanning the full width → the mask kept the background ("looks the same as the
original"). For a wide banner that is the mask-flood symptom (see PRs #75/#76).

ASCII-art layout (composite on white first so transparency reads as white):

```python
a = np.array(Image.open('/tmp/img/attached.png').convert('RGBA')).astype(float)
rgb, al = a[:, :, :3], a[:, :, 3]; w = al / 255.0
white = (rgb * w[..., None] + 255 * (1 - w[..., None])).astype('uint8')
Image.fromarray(white).save('/tmp/img/on_white.png')          # for OCR
chars = ' .:-=+*#%@'
g = np.array(Image.fromarray(al.astype('uint8')).resize((54, 108)))
for y in range(g.shape[0]):
    print('%4d|' % (y * 22) + ''.join(chars[min(9, int(g[y, x] / 25.6))] for x in range(g.shape[1])))
```

OCR the text — crop the region, upscale 3–5×, binarise, then tesseract; try several `--psm`:

```python
import subprocess
from PIL import Image, ImageOps
c = Image.open('/tmp/img/on_white.png').convert('L').crop((0, 1180, 1080, 1350))
c = ImageOps.autocontrast(c).resize((c.width * 4, c.height * 4), Image.LANCZOS)
c.save('/tmp/img/ocr.png')
for psm in (4, 6, 11):
    print(psm, subprocess.run(['tesseract', '/tmp/img/ocr.png', 'stdout', '--psm', str(psm)],
                              capture_output=True, text=True).stdout)
```

`--psm 11` (sparse) and `--psm 4` (column) find text `--psm 6` misses. For low-contrast
(grey-on-grey) text, `ImageOps.autocontrast` or a manual threshold helps; probe the crop's
luminance range (`np.array(crop).min(), .mean(), .max()`) to pick the threshold.

Optional real browser render (e.g. an HTML page, or a same-size comparison):

```bash
/usr/bin/chromium --headless --no-sandbox --disable-gpu \
  --screenshot=/tmp/img/shot.png --window-size=1080,2400 file:///tmp/img/on_white.png
```

For DOM work, use `puppeteer-core` — and run throwaway scripts **from the repo root**, or
`node /tmp/x.mjs` cannot resolve the module:

```js
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/chromium', headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu'] });
const p = await b.newPage();
await p.goto('file:///tmp/img/on_white.png');
await p.screenshot({ path: '/tmp/img/shot.png' });
await b.close();
```

Chromium writes `dbus`/`bus.cc` noise to stderr — harmless; the screenshot still lands.

Report the facts (dimensions, alpha fractions, bbox, OCR text) before interpreting them.
