// Generates public/icons/icon-192.png and icon-512.png (pink tile with a white heart)
// using only Node built-ins, so the repo needs no image tooling.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function heart(x, y) {
  // Classic heart curve: (x²+y²-1)³ - x²y³ <= 0, y pointing up.
  const a = x * x + y * y - 1;
  return a * a * a - x * x * y * y * y <= 0;
}

function render(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = size * 0.2;
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0; // filter byte
    for (let px = 0; px < size; px++) {
      const o = py * (size * 4 + 1) + 1 + px * 4;
      // Rounded-square mask.
      const cx = Math.max(radius - px, px - (size - 1 - radius), 0);
      const cy = Math.max(radius - py, py - (size - 1 - radius), 0);
      const inside = cx * cx + cy * cy <= radius * radius;
      if (!inside) {
        raw[o + 3] = 0;
        continue;
      }
      const t = py / size;
      let r = Math.round(232 + 20 * t), g = Math.round(86 + 90 * t), b = Math.round(45 + 115 * t);
      // Supersampled heart.
      let hits = 0;
      for (let sy = 0; sy < 3; sy++)
        for (let sx = 0; sx < 3; sx++) {
          const hx = ((px + (sx + 0.5) / 3) / size - 0.5) * 3.2;
          const hy = (0.5 - (py + (sy + 0.5) / 3) / size) * 3.2 + 0.15;
          if (heart(hx, hy)) hits++;
        }
      const k = hits / 9;
      r = Math.round(r + (255 - r) * k);
      g = Math.round(g + (255 - g) * k);
      b = Math.round(b + (255 - b) * k);
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, render(size));
  console.log("wrote", file);
}
