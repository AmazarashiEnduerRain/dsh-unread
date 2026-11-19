// Generates assets/market-icon.png (180x180 RGBA) for the dshmarket storefront tile.
// Pure node — no dependencies (PNG written by hand, deflate via node:zlib).
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SIZE = 180;

// ---- pixel font (5x7, bold-ish at large scale) ----
const FONT_5X7 = {
  "1": ["00100", "01100", "10100", "00100", "00100", "00100", "11111"],
  "9": ["01110", "10001", "10001", "01111", "00001", "10001", "01110"],
};

// ---- canvas ----
const px = Buffer.alloc(SIZE * SIZE * 4);

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || a <= 0) return;
  const i = (y * SIZE + x) * 4;
  const sa = a / 255;
  const da = px[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
  px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
  px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
  px[i + 3] = Math.round(oa * 255);
}

function fillRect(x0, y0, w, h, r, g, b, a) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) blend(x, y, r, g, b, a);
}

function fillCircle(cx, cy, rad, r, g, b, a) {
  for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
    for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= rad) blend(x, y, r, g, b, a);
    }
  }
}

// background: dark neutral
fillRect(0, 0, SIZE, SIZE, 23, 25, 28, 255);

// badge: black circle
const C = SIZE / 2;
fillCircle(C, C, 66, 10, 10, 10, 255);

// digit "1" at scale 12 (glyph 60x84), centered
const ch = "1";
const rows = FONT_5X7[ch];
const scale = 12;
const gw = 5 * scale;
const gh = 7 * scale;
const gx0 = Math.round((SIZE - gw) / 2);
const gy0 = Math.round((SIZE - gh) / 2);
for (let gy = 0; gy < 7; gy++) {
  for (let gx = 0; gx < 5; gx++) {
    if (rows[gy][gx] === "1") fillRect(gx0 + gx * scale, gy0 + gy * scale, scale, scale, 255, 255, 255, 255);
  }
}

// ---- PNG writer ----
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
// 10-12: compression/filter/interlace = 0

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "market-icon.png");
writeFileSync(out, png);
console.log("wrote", out, png.length, "bytes");
