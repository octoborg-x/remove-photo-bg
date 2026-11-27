// Source-level guard for the adaptive downscale wiring.
//
// The decision itself is unit-tested in adaptive-downscale.test.ts. What this
// file pins is the ORDER inside `loadImageFromFile`: the size decision and the
// single reduced draw must happen before `getImageData`, or a full-resolution
// buffer is allocated and the memory goal is silently lost. It also pins the
// console line, so a reduction can never happen without telling the user.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..');
const MAIN = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
const MODULE = readFileSync(join(ROOT, 'src', 'features/background-removal/adaptive-downscale.ts'), 'utf8');

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf('\nasync function ', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

describe('adaptive downscale is wired before the pixels are read', () => {
  it('imports and calls recommendSourceScale from loadImageFromFile', () => {
    expect(MAIN).toMatch(/from '\.\/features\/background-removal\/adaptive-downscale'/);
    const body = functionBody(MAIN, 'loadImageFromFile');
    expect(body).toContain('sourceScaleDecision(img.naturalWidth, img.naturalHeight)');
  });

  it('decides the size before getImageData, so no full-resolution buffer is read', () => {
    const body = functionBody(MAIN, 'loadImageFromFile');
    const scaleAt = body.indexOf('sourceScaleDecision(');
    const getImageDataAt = body.indexOf('ctx.getImageData(');
    expect(scaleAt).toBeGreaterThan(-1);
    expect(getImageDataAt).toBeGreaterThan(-1);
    expect(scaleAt).toBeLessThan(getImageDataAt);
  });

  it('draws the canvas at the decided size, not the decoded natural size', () => {
    const body = functionBody(MAIN, 'loadImageFromFile');
    expect(body).toMatch(/canvas\.width = sourceScale\.width/);
    expect(body).toMatch(/canvas\.height = sourceScale\.height/);
    expect(body).toMatch(/ctx\.drawImage\(img, 0, 0, canvas\.width, canvas\.height\)/);
    expect(body).not.toMatch(/canvas\.width = img\.naturalWidth/);
  });

  it('logs the reduction through the shared decision reason', () => {
    const body = functionBody(MAIN, 'loadImageFromFile');
    expect(body).toMatch(/if \(sourceScale\.downscaled\) log\(sourceScale\.reason\)/);
    expect(MODULE).toContain('Reduced from ${width}×${height} to ${targetWidth}×${targetHeight}');
  });

  it('exposes ?maxSourceSide= and shares the device probe', () => {
    expect(MAIN).toMatch(/urlParams\.get\('maxSourceSide'\)/);
    expect(MAIN).toMatch(/deviceClass: readDeviceMobile\(\) \? 'mobile' : 'desktop'/);
  });

  it('applies the same decision to the bulk upload path', () => {
    const body = functionBody(MAIN, 'addBulkFiles');
    expect(body.indexOf('sourceScaleDecision(')).toBeGreaterThan(-1);
    expect(body).toMatch(/width: sourceScale\.width/);
  });
});
