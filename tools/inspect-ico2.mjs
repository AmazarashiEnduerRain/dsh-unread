import { readFileSync } from "node:fs";

// Parse dsh-unread-99p.ico: ICONDIR + 2 ICONDIRENTRY + 16px DIB + 32px DIB.
const buf = readFileSync("C:/Users/20619/Documents/deepseek-harness/default-workspace/dsh-unread-bundle/assets/dsh-unread-99p.ico");
const count = buf.readUInt16LE(4);
console.log("entries:", count);
const size = buf.readUInt8(6);
const off = buf.readUInt32LE(18);
console.log("size:", size, "offset:", off);
// DIB at off: BITMAPINFOHEADER (40), then bottom-up BGRA XOR bitmap size*size*4
let white = 0, opaque = 0;
for (let y = 0; y < 16; y++) {
  let line = "";
  for (let x = 0; x < 16; x++) {
    const p = off + 40 + ((16 - 1 - y) * 16 + x) * 4; // flip to top-down
    const b = buf[p], g = buf[p + 1], r = buf[p + 2], a = buf[p + 3];
    if (a === 0) { line += "  "; continue; }
    opaque++;
    if (r > 200 && g > 200 && b > 200) { white++; line += "##"; }
    else line += "..";
  }
  console.log(line);
}
console.log("white:", white, "opaque:", opaque);

