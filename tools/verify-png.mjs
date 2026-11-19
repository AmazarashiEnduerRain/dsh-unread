// Structural + visual (ASCII) verification of assets/market-icon.png
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "market-icon.png");
const buf = readFileSync(file);

if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error("bad signature");
let off = 8;
let ihdr = null;
const idat = [];
while (off < buf.length) {
  const len = buf.readUInt32BE(off);
  const type = buf.toString("ascii", off + 4, off + 8);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === "IHDR") {
    ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9] };
  } else if (type === "IDAT") idat.push(data);
  off += 12 + len;
}
console.log("IHDR:", JSON.stringify(ihdr));
const raw = inflateSync(Buffer.concat(idat));
const stride = ihdr.w * 4 + 1;
if (raw.length !== stride * ihdr.h) throw new Error(`raw length ${raw.length} != expected ${stride * ihdr.h}`);
// unfilter (filter 0 only)
const rgba = Buffer.alloc(ihdr.w * ihdr.h * 4);
for (let y = 0; y < ihdr.h; y++) {
  const f = raw[y * stride];
  if (f !== 0) throw new Error(`unexpected filter ${f} at row ${y}`);
  raw.copy(rgba, y * ihdr.w * 4, y * stride + 1, (y + 1) * stride);
}
// ASCII preview: downsample to 36x36, map: transparent=' ', dark bg='.', circle black='#', white='@'
const cell = ihdr.w / 36;
const out = [];
for (let cy = 0; cy < 36; cy++) {
  let line = "";
  for (let cx = 0; cx < 36; cx++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = Math.floor(cy * cell); y < (cy + 1) * cell; y++) {
      for (let x = Math.floor(cx * cell); x < (cx + 1) * cell; x++) {
        const i = (y * ihdr.w + x) * 4;
        if (rgba[i + 3] > 128) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++; }
      }
    }
    if (!n) line += " ";
    else {
      r /= n; g /= n; b /= n;
      line += r > 200 ? "@" : r < 60 && g < 60 ? "#" : r < 80 ? "." : "-";
    }
  }
  out.push(line);
}
console.log(out.join("\n"));
console.log("OK", file, buf.length, "bytes");
