/**
 * gen-icons.mjs — generate the dsh-unread taskbar-overlay .ico assets.
 *
 * Render at 32x32 (2x supersampling of the 16x16 overlay size), then box-
 * downsample to 16x16 for smooth anti-aliasing. The ICO carries both sizes
 * so high-DPI taskbars use the 32px image.
 *
 * Design: solid black circle, white count digits (Codex style).
 *  - counts 1-99:    3x5 pixel digits at 4x scale — 6x10 output px with bold
 *                    2px strokes (as large and heavy as a 16px icon allows)
 *  - counts 100+:    "99+" in a 2x5 compact font (4x10 px per glyph)
 *
 * Output: assets/dsh-unread-{0,1..99,99p}.ico
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

// ---------------------------------------------------------------- pixel fonts

// 3x5 digits (row strings, '1' = on) — drawn at 4x supersample scale, so each
// font pixel becomes a 2x2 output block at 16px: bold 2px strokes.
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

// 2x5 compact glyphs for "99+" (three glyphs fit: 3*4px + 2*1px gaps = 14px).
const FONT_2X5 = {
  "9": ["11", "11", "11", "01", "01"],
  "+": ["01", "01", "11", "01", "01"],
};

// ---------------------------------------------------------------- rendering

const SIZE = 32;          // supersampled canvas
const R = 15.0;           // circle radius (32px canvas => 16px logical)
const C = SIZE / 2 - 0.5; // circle center (15.5, 15.5)

function glyphBlocks(text) {
  // 1-99: 3x5 digits at 4x scale (6x10 output px, 2px strokes).
  // "99+": three 2x5 glyphs (4x10 output px each) so all three fit.
  const blocks = [];
  const compact = text.length > 2;
  for (const ch of text) {
    if (compact) blocks.push({ font: FONT_2X5, ch: ch === "+" ? "+" : "9" });
    else blocks.push({ font: FONT_3X5, ch });
  }
  return blocks;
}

const GAP = 2; // canvas px between glyphs = 1 output px at 16px

function measureText(text, scale = 4) {
  const blocks = glyphBlocks(text);
  let w = 0;
  for (const b of blocks) {
    const glyphW = b.font === FONT_2X5 ? 2 : 3;
    w += glyphW * scale;
  }
  if (blocks.length > 1) w += (blocks.length - 1) * GAP;
  return w;
}

function textHeight(text) {
  return 5 * 4; // every font is 5 rows at 4x scale
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
      px[i + 3] = cov * 255; // alpha 0..255
      // black: r=g=b=0
    }
  }

  const blocks = glyphBlocks(text);
  const scale = 4;
  const th = textHeight(text);
  const tw = measureText(text, scale);
  // Align to the 2x downsample grid: each 2x2 canvas block must land inside
  // one 16px cell, otherwise strokes split across cells and the digits
  // downsample to gray mush. scale=4 divides evenly, so even offsets align.
  let ox = Math.round((SIZE - tw) / 2);
  if (ox % 2) ox += 1;
  let oy = Math.round((SIZE - th) / 2);
  if (oy % 2) oy += 1;

  for (const b of blocks) {
    const glyphW = b.font === FONT_2X5 ? 2 : 3;
    const glyphH = 5;
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
    ox += glyphW * scale + GAP; // advance with 1-output-px gap
  }
  return px;
}

/** Box-downsample RGBA 32x32 -> 16x16 (alpha-weighted average). */
function downsample(px32) {
  const out = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = ((y * 2 + dy) * SIZE + (x * 2 + dx)) * 4;
          const alpha = px32[i + 3];
          r += px32[i] * alpha;
          g += px32[i + 1] * alpha;
          b += px32[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * 16 + x) * 4;
      if (a > 0) {
        out[o] = Math.round(b / a);       // B
        out[o + 1] = Math.round(g / a);   // G
        out[o + 2] = Math.round(r / a);   // R
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
        buf[di] = Math.round(px32[si + 2]);     // B
        buf[di + 1] = Math.round(px32[si + 1]); // G
        buf[di + 2] = Math.round(px32[si]);     // R
        buf[di + 3] = Math.round(a);
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

// ASCII preview at 16px for eyeballing (alpha-aware: ## white, ▓▓ opaque black, .. AA/transparent-ish)
function preview(text) {
  const px = downsample(render32(text));
  const lines = [];
  for (let y = 0; y < 16; y++) {
    let line = "";
    for (let x = 0; x < 16; x++) {
      const a = px[(y * 16 + x) * 4 + 3];
      const r = px[(y * 16 + x) * 4];
      line += a === 0 ? "  " : r > 200 ? "##" : a > 200 ? "▓▓" : "..";
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
