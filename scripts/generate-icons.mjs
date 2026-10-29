/**
 * Generates PNG app icons (192/512 + maskable) with no image dependency:
 * raw RGBA raster → zlib deflate → PNG chunks. The mark is an original
 * eighth-note shape on a dark gradient — matching public/icons/icon.svg.
 */
import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import path from "node:path";

function crc32(buffer) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Blend source over destination (both [r,g,b,a] 0-255). */
function blend(dst, src) {
  const alpha = src[3] / 255;
  return [
    Math.round(src[0] * alpha + dst[0] * (1 - alpha)),
    Math.round(src[1] * alpha + dst[1] * (1 - alpha)),
    Math.round(src[2] * alpha + dst[2] * (1 - alpha)),
    Math.round(Math.max(dst[3] / 255, alpha) * 255),
  ];
}

const ACCENT = [141, 168, 255, 255];

function render(size, { maskable }) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      // Dark diagonal gradient background (full bleed, incl. maskable safe area)
      const t = (x + y) / (2 * size);
      let pixel = [
        Math.round(27 + (9 - 27) * t),
        Math.round(36 + (11 - 36) * t),
        Math.round(64 + (18 - 64) * t),
        255,
      ];

      // Rounded-corner transparency for the "any" variant; full bleed for maskable.
      if (!maskable) {
        const radius = size * 112 / 512;
        const minX = Math.min(x, size - 1 - x);
        const minY = Math.min(y, size - 1 - y);
        if (minX < radius && minY < radius) {
          const dx = radius - minX;
          const dy = radius - minY;
          if (dx * dx + dy * dy > radius * radius) {
            pixel = [0, 0, 0, 0];
            rgba.set(pixel, index);
            continue;
          }
        }
      }

      // Eighth note: two note heads + stem + flag, in a 512-unit design space.
      const u = size / 512;
      const inStem = x >= 296 * u && x < 322 * u && y >= 96 * u && y <= 330 * u;
      const headA = (x - 248 * u) ** 2 + (y - 318 * u) ** 2 <= (52 * u) ** 2;
      const headB = (x - 350 * u) ** 2 + (y - 292 * u) ** 2 <= (52 * u) ** 2;
      // Beam: parallelogram from the stem slanting down-left
      let beam = false;
      if (x >= 200 * u && x <= 322 * u) {
        const topY = 118 * u + ((322 * u - x) / (122 * u)) * 40 * u;
        beam = y >= topY && y <= topY + 40 * u;
      }
      if (inStem || headA || headB || beam) {
        pixel = blend(pixel, ACCENT);
      }
      rgba.set(pixel, index);
    }
  }
  return encodePng(size, size, rgba);
}

const outDir = path.resolve("public/icons");
await writeFile(path.join(outDir, "icon-192.png"), render(192, { maskable: false }));
await writeFile(path.join(outDir, "icon-512.png"), render(512, { maskable: false }));
await writeFile(path.join(outDir, "icon-maskable-512.png"), render(512, { maskable: true }));
console.log("Icons generated in public/icons");
