const FONT_5X7 = {
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
};
const SIZE = 32;

function render32(text) {
  const px = new Float64Array(SIZE * SIZE * 4);
  const C = SIZE / 2 - 0.5;
  const R = 15.0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x - C, y - C);
      const cov = Math.max(0, Math.min(1, R + 0.5 - d));
      px[(y * SIZE + x) * 4 + 3] = cov;
    }
  }
  // draw "1" with 5x7 font at 2x scale
  const scale = 2;
  const glyphW = 5, glyphH = 7;
  const tw = glyphW * scale; // 10
  const th = glyphH * scale; // 14
  const ox = Math.round((SIZE - tw) / 2);
  const oy = Math.round((SIZE - th) / 2);
  console.log("ox", ox, "oy", oy);
  for (let gy = 0; gy < glyphH; gy++) {
    const row = FONT_5X7["1"][gy];
    for (let gx = 0; gx < glyphW; gx++) {
      if (row[gx] !== "1") continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = ox + gx * scale + dx;
          const y = oy + gy * scale + dy;
          const i = (y * SIZE + x) * 4;
          px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255;
        }
      }
    }
  }
  return px;
}

const px = render32("1");
let whites = 0;
for (let i = 0; i < SIZE * SIZE; i++) if (px[i * 4] === 255) whites++;
console.log("white pixels:", whites);
// print rows 8..22 columns 8..24
for (let y = 8; y < 23; y++) {
  let line = "";
  for (let x = 8; x < 24; x++) {
    const v = px[(y * SIZE + x) * 4];
    line += v === 255 ? "#" : v === 0 && px[(y * SIZE + x) * 4 + 3] > 0 ? "." : " ";
  }
  console.log(line);
}
