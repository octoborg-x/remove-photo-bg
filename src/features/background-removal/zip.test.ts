import { describe, it, expect } from 'vitest';
import { crc32, createZipBytes, createZipBlob, dataUrlToBytes, type ZipEntry } from './zip';

const u16 = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer).getUint16(offset, true);
const u32 = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer).getUint32(offset, true);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('zip writer', () => {
  it('computes the standard CRC-32 check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('decodes base64 and percent-encoded data URLs', () => {
    expect(Array.from(dataUrlToBytes('data:text/plain;base64,aGk='))).toEqual([104, 105]);
    expect(Array.from(dataUrlToBytes('data:text/plain,hi%20there'))).toEqual(
      Array.from(new TextEncoder().encode('hi there')),
    );
    expect(() => dataUrlToBytes('https://example.com/a.png')).toThrow('Not a data URL');
  });

  it('writes local, central, and end records for stored entries', () => {
    const entries: ZipEntry[] = [
      { name: 'first.txt', data: new TextEncoder().encode('hello') },
      { name: 'folder/second.txt', data: new TextEncoder().encode('world') },
    ];
    const zip = createZipBytes(entries, new Date(2026, 10, 21, 14, 47, 30));
    const end = zip.length - 22;

    expect(u32(zip, 0)).toBe(0x04034b50);
    expect(u32(zip, end)).toBe(0x06054b50);
    expect(u16(zip, end + 8)).toBe(2);
    expect(u16(zip, end + 10)).toBe(2);

    const firstLocal = 0;
    expect(u16(zip, firstLocal + 8)).toBe(0);
    expect(u16(zip, firstLocal + 6)).toBe(0x0800);
    expect(u32(zip, firstLocal + 14)).toBe(crc32(entries[0].data));
    expect(u16(zip, firstLocal + 26)).toBe('first.txt'.length);
    expect(text(zip.slice(firstLocal + 30, firstLocal + 39))).toBe('first.txt');
    expect(text(zip.slice(firstLocal + 39, firstLocal + 44))).toBe('hello');

    const centralStart = u32(zip, end + 16);
    expect(u32(zip, centralStart)).toBe(0x02014b50);
    expect(u16(zip, centralStart + 28)).toBe('first.txt'.length);
    expect(u16(zip, centralStart + 42)).toBe(firstLocal);
    expect(u32(zip, end + 12)).toBe(end - centralStart);

    const secondCentral = centralStart + 46 + 'first.txt'.length;
    expect(u32(zip, secondCentral)).toBe(0x02014b50);
    expect(text(zip.slice(secondCentral + 46, secondCentral + 46 + 'folder/second.txt'.length))).toBe(
      'folder/second.txt',
    );
  });

  it('returns a Blob with the zip MIME type', () => {
    const blob = createZipBlob([{ name: 'a.txt', data: new Uint8Array([1, 2, 3]) }]);
    expect(blob.type).toBe('application/zip');
    expect(blob.size).toBeGreaterThan(22);
  });
});
