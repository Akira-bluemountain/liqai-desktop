/**
 * Generates a simple 1024×1024 source PNG for Tauri icon generation.
 *
 * Uses only Node.js built-ins (no native image libraries) to produce a
 * deterministic placeholder that `tauri icon` can consume.
 *
 * SECURITY: Pure Node built-ins (zlib + crypto for CRC) — no external
 * image decoding, no attack surface.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { crc32 } from 'node:zlib';

const SIZE = 1024;
const BG = [0x0b, 0x0d, 0x12, 0xff]; // dark background
const FG = [0x5e, 0xea, 0xd4, 0xff]; // teal accent

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0, 0);
  return Buffer.concat([len, typeBytes, data, crc]);
}

function makePng(width, height, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const lineStart = y * (width * 4 + 1);
    scanlines[lineStart] = 0;
    for (let x = 0; x < width; x++) {
      const p = lineStart + 1 + x * 4;
      const [r, g, b, a] = pixels(x, y);
      scanlines[p] = r;
      scanlines[p + 1] = g;
      scanlines[p + 2] = b;
      scanlines[p + 3] = a;
    }
  }

  const idat = deflateSync(scanlines);

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function mix(a, b, t) {
  return a.map((av, i) => Math.round(av + (b[i] - av) * t));
}

const png = makePng(SIZE, SIZE, (x, y) => {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.sqrt(dx * dx + dy * dy);
  const radius = SIZE * 0.42;

  // Rounded square background with radial fade
  const corner = SIZE * 0.1;
  if (
    x < corner && y < corner && Math.hypot(x - corner, y - corner) > corner
  ) return [0, 0, 0, 0];
  if (
    x > SIZE - corner && y < corner && Math.hypot(x - (SIZE - corner), y - corner) > corner
  ) return [0, 0, 0, 0];
  if (
    x < corner && y > SIZE - corner && Math.hypot(x - corner, y - (SIZE - corner)) > corner
  ) return [0, 0, 0, 0];
  if (
    x > SIZE - corner && y > SIZE - corner && Math.hypot(x - (SIZE - corner), y - (SIZE - corner)) > corner
  ) return [0, 0, 0, 0];

  // Central teal ring
  const ringInner = radius * 0.75;
  const ringOuter = radius;
  if (r > ringInner && r < ringOuter) {
    return FG;
  }
  // Inner filled circle for contrast
  if (r < ringInner * 0.45) return mix(BG, FG, 0.7);

  return BG;
});

writeFileSync(
  new URL('../src-tauri/icons/source.png', import.meta.url),
  png,
);
console.log(`Wrote ${png.length} bytes to apps/desktop/src-tauri/icons/source.png`);
