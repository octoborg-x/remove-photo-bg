// The app must have exactly ONE inference implementation, and it must be the
// one the deployed page actually loads. Historically two worker files existed:
// the live classic worker `public/inference-worker.js` and an unreferenced
// TypeScript "reference" worker under `src/`. Editing the dead copy changed
// nothing at runtime, so a maintainer could "fix" inference and ship no change.
//
// These tests pin the architecture so that drift cannot come back silently:
//   1. the classic worker exists and the page loads it, un-bundled;
//   2. it is the only shipped file that creates an ORT session;
//   3. it is a classic worker (importScripts) by design, not by accident.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..');
const LIVE_WORKER = join(ROOT, 'public', 'inference-worker.js');
const MAIN = join(ROOT, 'src', 'main.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Every shipped source file (excludes tests and build output). */
function shippedSources(): string[] {
  const src = walk(join(ROOT, 'src')).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );
  const pub = walk(join(ROOT, 'public')).filter(
    (f) => f.endsWith('.js') && !f.includes(`${join('public', 'wasm')}`),
  );
  return [...src, ...pub, join(ROOT, 'index.html')];
}

describe('single authoritative inference worker', () => {
  it('ships the classic worker and loads it un-bundled from /public', () => {
    expect(statSync(LIVE_WORKER).isFile()).toBe(true);
    const main = readFileSync(MAIN, 'utf8');
    // The exact specifier the page must use. If this path changes, the guard
    // below (which finds the session creator) is the one to update too.
    expect(main).toMatch(/new Worker\(\s*'\/inference-worker\.js'/);
    expect(main).toMatch(/type:\s*'classic'/);
  });

  it('is the only shipped file that creates an ONNX Runtime session', () => {
    const creators = shippedSources().filter((f) =>
      /InferenceSession\.create/.test(readFileSync(f, 'utf8')),
    );
    expect(creators.map((f) => f.replace(`${ROOT}/`, ''))).toEqual([
      'public/inference-worker.js',
    ]);
  });

  it('loads the ORT runtime in the classic worker via importScripts', () => {
    const worker = readFileSync(LIVE_WORKER, 'utf8');
    // importScripts is what keeps the /wasm/ loaders and the threaded .wasm a
    // plain same-origin static fetch instead of something Vite must transform.
    expect(worker).toMatch(/importScripts\(/);
    expect(worker).toMatch(/\/wasm\/ort\./);
  });

  it('has no second worker source under src/', () => {
    const stray = walk(join(ROOT, 'src')).filter((f) =>
      /\.worker\.ts$/.test(f),
    );
    expect(stray).toEqual([]);
  });
});
