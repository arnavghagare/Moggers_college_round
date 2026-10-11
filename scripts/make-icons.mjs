// Draws the extension icons (a cursor ring on a dark rounded square) and
// writes them as PNG files, using only Node built-ins.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [10, 17, 32];
const ACCENT = [94, 234, 212];
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Coverage (0..1) of each shape at a point in unit coordinates, with soft edges for anti-aliasing. */
function shade(u, v, px) {
  const aa = 1.2 * px;
  // Rounded square background.
  const r = 0.22;
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  const bg = clamp01((r - Math.hypot(dx, dy)) / aa + 0.5);
  // Ring and centre dot.
  const d = Math.hypot(u - 0.5, v - 0.5);
  const ring = clamp01((0.055 - Math.abs(d - 0.27)) / aa + 0.5);
  const dot = clamp01((0.085 - d) / aa + 0.5);
  return { bg, mark: Math.max(ring, dot) };
}

function render(size) {
  const data = Buffer.alloc(size * size * 4);
  const px = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const { bg, mark } = shade((x + 0.5) * px, (y + 0.5) * px, px);
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) data[i + c] = Math.round(BG[c] + (ACCENT[c] - BG[c]) * mark);
      data[i + 3] = Math.round(255 * bg);
    }
  }
  return png(size, data);
}

await mkdir(out, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(join(out, `icon${size}.png`), render(size));
}
console.log('icons written to public/icons');
