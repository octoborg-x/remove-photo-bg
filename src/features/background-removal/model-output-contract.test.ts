// Pins the model's output contract — the output is ALREADY a probability map
// (sigmoid baked into the graph, range [0,1]) — and that it is handled by ONE
// code path shared by every provider, so a provider-specific duplicate can never
// drift out of sync and reintroduce a second sigmoid (which silently squashes the
// mask into ≈[0.5,0.73] and composites a washed-out "ghost" image).
//
// Source-level, so it runs in CI without the (gitignored) model binary.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..');
const WORKER = readFileSync(resolve(ROOT, 'public/inference-worker.js'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(resolve(ROOT, 'public/models-manifest.json'), 'utf8'));
const MODEL_CARD = readFileSync(resolve(ROOT, 'MODEL_CARD.md'), 'utf8');

describe('model output contract is probability-only and shared across providers', () => {
  it('every served model declares outputIsProbability: true', () => {
    expect(MANIFEST.models.length).toBeGreaterThan(0);
    for (const model of MANIFEST.models) {
      expect(model.outputIsProbability).toBe(true);
    }
  });

  it('the model card documents the sigmoid-baked contract', () => {
    expect(MODEL_CARD).toMatch(/sigmoid is \*\*baked into the graph\*\*/i);
    expect(MODEL_CARD).toMatch(/do not apply sigmoid again/i);
    expect(MODEL_CARD).toMatch(/probabilities in `?\[0,1\]`?/i);
  });

  it('applies sigmoid in exactly one place, and only when the model is NOT a probability map', () => {
    // The only sigmoid-equivalent in the shipped worker.
    const sigmoids = WORKER.match(/1 \/ \(1 \+ Math\.exp\([^)]*\)\)/g) ?? [];
    expect(sigmoids.length).toBe(1);
    // …and it is guarded by the probability flag, never applied unconditionally.
    expect(WORKER).toMatch(/if \(outputIsProbability\) \{\s*mask\.set\(out\);\s*\} else \{/);
  });

  it('has a single inference function shared by every provider (no per-provider mask branch)', () => {
    const defs = WORKER.match(/function runInference\s*\(/g) ?? [];
    expect(defs.length).toBe(1);
    // Both the direct run and the WebGPU→WASM fallback call the same function, so
    // the mask normalisation cannot differ between providers.
    const calls = WORKER.match(/await runInference\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not create a second ONNX session or a second mask normaliser anywhere shipped', () => {
    // Only the one worker creates a session (see single-inference-worker.test.ts);
    // here we also pin that no provider-specific sigmoid was added.
    const providerSigmoid = /if\s*\(\s*(?:lastProvider|provider|ep)\s*===\s*['"]webgpu['"][^)]*\)\s*\{[^}]*Math\.exp/s;
    expect(providerSigmoid.test(WORKER)).toBe(false);
  });
});
