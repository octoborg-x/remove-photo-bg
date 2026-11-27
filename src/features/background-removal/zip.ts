// Minimal ZIP writer for browser downloads. Bulk cut-outs are already encoded
// (PNG/JPG/WebP), so every entry is stored uncompressed — no dependency on a
// compression library, and the archive opens in every standard unzip tool.

export interface ZipEntry {
  /** Path inside the archive. A slash creates a folder. */
  name: string;
  data: Uint8Array;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_RECORD_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
// Bit 11 tells the reader the file name is UTF-8.
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

/** Decode a `data:` URL (base64 or percent-encoded) into raw bytes. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma === -1) {
    throw new Error('Not a data URL');
  }
  const meta = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  if (/;base64(?:;|$)/i.test(meta)) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(decodeURIComponent(payload));
}

/**
 * Build a ZIP archive in memory. Entries are stored (not deflated), which is
 * what the encoded image formats want anyway.
 */
export function createZipBytes(entries: readonly ZipEntry[], now = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const stamp = dosDateTime(now);

  const prepared = entries.map((entry) => {
    const name = encoder.encode(entry.name);
    return { name, data: entry.data, crc: crc32(entry.data) };
  });

  const localSize = prepared.reduce((sum, entry) => sum + 30 + entry.name.length + entry.data.length, 0);
  const centralSize = prepared.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  const bytes = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(bytes.buffer);

  let offset = 0;
  const localOffsets: number[] = [];
  for (const entry of prepared) {
    localOffsets.push(offset);
    writeUint32(view, offset, LOCAL_HEADER_SIGNATURE);
    writeUint16(view, offset + 4, VERSION_NEEDED);
    writeUint16(view, offset + 6, UTF8_FLAG);
    writeUint16(view, offset + 8, STORE_METHOD);
    writeUint16(view, offset + 10, stamp.time);
    writeUint16(view, offset + 12, stamp.date);
    writeUint32(view, offset + 14, entry.crc);
    writeUint32(view, offset + 18, entry.data.length);
    writeUint32(view, offset + 22, entry.data.length);
    writeUint16(view, offset + 26, entry.name.length);
    writeUint16(view, offset + 28, 0);
    offset += 30;
    bytes.set(entry.name, offset);
    offset += entry.name.length;
    bytes.set(entry.data, offset);
    offset += entry.data.length;
  }

  const centralStart = offset;
  prepared.forEach((entry, index) => {
    writeUint32(view, offset, CENTRAL_HEADER_SIGNATURE);
    writeUint16(view, offset + 4, VERSION_NEEDED);
    writeUint16(view, offset + 6, VERSION_NEEDED);
    writeUint16(view, offset + 8, UTF8_FLAG);
    writeUint16(view, offset + 10, STORE_METHOD);
    writeUint16(view, offset + 12, stamp.time);
    writeUint16(view, offset + 14, stamp.date);
    writeUint32(view, offset + 16, entry.crc);
    writeUint32(view, offset + 20, entry.data.length);
    writeUint32(view, offset + 24, entry.data.length);
    writeUint16(view, offset + 28, entry.name.length);
    writeUint16(view, offset + 30, 0);
    writeUint16(view, offset + 32, 0);
    writeUint16(view, offset + 34, 0);
    writeUint16(view, offset + 36, 0);
    writeUint32(view, offset + 38, 0);
    writeUint32(view, offset + 42, localOffsets[index]);
    offset += 46;
    bytes.set(entry.name, offset);
    offset += entry.name.length;
  });

  writeUint32(view, offset, END_RECORD_SIGNATURE);
  writeUint16(view, offset + 4, 0);
  writeUint16(view, offset + 6, 0);
  writeUint16(view, offset + 8, prepared.length);
  writeUint16(view, offset + 10, prepared.length);
  writeUint32(view, offset + 12, offset - centralStart);
  writeUint32(view, offset + 16, centralStart);
  writeUint16(view, offset + 20, 0);

  return bytes;
}

export function createZipBlob(entries: readonly ZipEntry[], now = new Date()): Blob {
  const bytes = createZipBytes(entries, now);
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'application/zip' });
}
