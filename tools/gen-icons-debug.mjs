/**
 * gen-icons.mjs — generate the dsh-unread taskbar-overlay .ico assets.
 *
 * Render at 32x32 (2x supersampling of the 16x16 overlay size), then box-
 * downsample to 16x16 for smooth anti-aliasing. The ICO carries both sizes
 * so high-DPI taskbars use the 32px image.
 *
 * Design: solid black circle, white count digits (Codex style).
 *  - counts 1-99:    5x7 pixel digits (7px tall at 16px — max legible size)
 *  - counts 100+:    "99+" in the 3x5 pixel font
 *
 * Output: assets/dsh-unread-{0,1..99,99p}.ico
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

// ---------------------------------------------------------------- pixel fonts

// 5x7 digits (row strings, '1' = on)
const FONT_5X7 = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
};

// 3x5 digits
const FONT_3X5 = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
};

// ---------------------------------------------------------------- rendering

const SIZE = 32;          // supersampled canvas
const R = 15.0;           // circle radius (32px canvas => 16px logical)
const C = SIZE / 2 - 0.5; // circle center (15.5, 15.5)

function glyphBlocks(text) {
  // glyphs drawn at 2x pixel-font scale on the 32px canvas
  const blocks = [];
  for (const ch of text) {
    const font = FONT_5X7[ch] ? FONT_5X7 : FONT_3X5;
    blocks.push({ font, ch });
  }
  return blocks;
}

function measureText(text, scale = 2) {
  const blocks = glyphBlocks(text);
  let w = 0;
  for (const b of blocks) {
    const glyphW = b.font === FONT_5X7 ? 5 : 3;
    w += glyphW * scale;
  }
  if (blocks.length > 1) w += (blocks.length - 1) * scale; // 1 glyph gap at 2x = 2px
  return w;
}

function textHeight(text) {
  const blocks = glyphBlocks(text);
  const h = blocks.length && blocks[0].font === FONT_5X7 ? 7 : 5;
  return h * 2; // 2x scale
}

/** Render the 32x32 RGBA canvas for `text` (e.g. "1", "42", "99+"). */
function render32(text) {
  const px = new Float64Array(SIZE * SIZE * 4);
  // circle fill with 1px anti-aliased rim, black
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x - C, y - C);
      const cov = Math.max(0, Math.min(1, R + 0.5 - d));
      const i = (y * SIZE + x) * 4;
      px[i + 3] = cov; // alpha
      // premultiplied black: r=g=b=0
    }
  }

  const blocks = glyphBlocks(text);
  const scale = 2;
  const th = textHeight(text);
  const tw = measureText(text, scale);
  let ox = Math.round((SIZE - tw) / 2);
  const oy = Math.round((SIZE - th) / 2);

  for (const b of blocks) {
    const glyphW = b.font === FONT_5X7 ? 5 : 3;
    const glyphH = b.font === FONT_5X7 ? 7 : 5;
    for (let gy = 0; gy < glyphH; gy++) {
      const row = b.font[b.ch][gy];
      for (let gx = 0; gx < glyphW; gx++) {
        if (row[gx] !== "1") continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = ox + gx * scale + dx;
            const y = oy + gy * scale + dy;
            if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
            const i = (y * SIZE + x) * 4;
            px[i] = 255;       // r (premultiplied white)
            px[i + 1] = 255;   // g
            px[i + 2] = 255;   // b
            px[i + 3] = 255;   // a
          }
        }
      }
    }
    ox += glyphW * scale + scale; // advance with 1-glyph gap (2px)
  }
  return px;
}

/** Box-downsample RGBA 32x32 -> 16x16 (un-premultiply for storage). */
function downsample(px32) {
  const out = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = ((y * 2 + dy) * SIZE + (x * 2 + dx)) * 4;
          a += px32[i + 3];
          r += px32[i];
          g += px32[i + 1];
          b += px32[i + 2];
        }
      }
      const o = (y * 16 + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);       // B (un-premultiplied)
        out[o + 1] = Math.round(g / a);   // G
        out[o + 2] = Math.round(b / a);   // R
        out[o + 3] = Math.round(a / 4);   // A
      }
    }
  }
  return out;
}

/** BGRA bottom-up bitmap from a top-down RGBA 32x32 canvas (un-premultiplied). */
function bgra32(px32, size) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = (y * size + x) * 4;
      const di = ((size - 1 - y) * size + x) * 4; // bottom-up flip
      const a = px32[si + 3];
      if (a > 0) {
        const r = Math.round(px32[si] / a);
        const g = Math.round(px32[si + 1] / a);
        const b = Math.round(px32[si + 2] / a);
        buf[di] = b; buf[di + 1] = g; buf[di + 2] = r; buf[di + 3] = Math.round(a);
      }
    }
  }
  return buf;
}

function bgraFromRGBA16(rgba) {
  const buf = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const si = (y * 16 + x) * 4;
      const di = ((16 - 1 - y) * 16 + x) * 4;
      buf[di] = rgba[si]; buf[di + 1] = rgba[si + 1]; buf[di + 2] = rgba[si + 2]; buf[di + 3] = rgba[si + 3];
    }
  }
  return buf;
}

function pngUnused() { return null; }

function icoEntry(size, bitmap, offset) {
  const header = Buffer.alloc(16);
  header.writeUInt8(size, 0);           // width (0 means 256; our sizes are < 256)
  header.writeUInt8(size, 1);           // height
  header.writeUInt8(0, 2);              // palette count
  header.writeUInt8(0, 3);              // reserved
  header.writeUInt16LE(1, 4);           // planes
  header.writeUInt16LE(32, 6);          // bit count
  header.writeUInt32LE(bitmap.length, 8);
  header.writeUInt32LE(offset, 12);
  return header;
}

function makeIco(sizes) {
  const count = sizes.length;
  const dir = Buffer.alloc(6 + 16 * count);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);              // type: icon
  dir.writeUInt16LE(count, 4);
  let offset = 6 + 16 * count;
  const parts = [];
  for (const { size, bitmap } of sizes) {
    icoEntry(size, bitmap, offset).copy(dir, 6 + 16 * parts.length);
    parts.push(bitmap);
    offset += bitmap.length;
  }
  return Buffer.concat([dir, ...parts]);
}

function dib(size, pixelBuf) {
  const andStride = Math.ceil(size / 32) * 4;
  const andSize = andStride * size;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);          // BITMAPINFOHEADER size
  header.writeInt32LE(size, 4);         // width
  header.writeInt32LE(size * 2, 8);     // height (XOR + AND)
  header.writeUInt16LE(1, 12);          // planes
  header.writeUInt16LE(32, 14);         // bpp
  header.writeUInt32LE(0, 16);          // BI_RGB
  header.writeUInt32LE(pixelBuf.length + andSize, 20);
  return Buffer.concat([header, pixelBuf, Buffer.alloc(andSize)]);
}

// ---------------------------------------------------------------- main

function targetText(count) {
  if (count <= 0) return "";
  if (count <= 99) return String(count);
  return "99+";
}

const targets = [];
targets.push({ file: "dsh-unread-0.ico", text: "" });
for (let n = 1; n <= 99; n++) targets.push({ file: `dsh-unread-${n}.ico`, text: String(n) });
targets.push({ file: "dsh-unread-99p.ico", text: "99+" });

mkdirSync(OUT_DIR, { recursive: true });
let made = 0;
for (const { file, text } of targets) {
  const px32 = render32(text);
  const bmp16 = bgraFromRGBA16(downsample(px32));
  const bmp32 = bgra32(px32, 32);
  const ico = makeIco([
    { size: 16, bitmap: dib(16, bmp16) },
    { size: 32, bitmap: dib(32, bmp32) },
  ]);
  writeFileSync(join(OUT_DIR, file), ico);
  made++;
}

// ASCII preview at 16px for eyeballing
function preview(text) {
  const px = downsample(render32(text));
  const lines = [];
  for (let y = 0; y < 16; y++) {
    let line = "";
    for (let x = 0; x < 16; x++) {
      const a = px[(y * 16 + x) * 4 + 3];
      const r = px[(y * 16 + x) * 4];
      line += a === 0 ? "  " : r > 200 ? "##" : "..";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

console.log(`generated ${made} icons -> ${OUT_DIR}`);
for (const t of ["1", "7", "42", "99+"]) {
  console.log(`\n--- ${t} ---`);
  console.log(preview(t));
}
