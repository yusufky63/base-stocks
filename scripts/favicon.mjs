// Build src/app/favicon.ico (16/32/48/64 px, PNG-in-ICO) from the transparent brand mark.
// Usage: node scripts/favicon.mjs
import { PNG } from "pngjs";
import fs from "node:fs";
import path from "node:path";

const src = PNG.sync.read(fs.readFileSync(path.resolve("public/brand/logo-mark-transparent-1024.png")));

/** Area-averaging downscale with premultiplied alpha (same approach as brand-assets.mjs). */
function resize(png, size) {
  const out = new PNG({ width: size, height: size });
  const fx = png.width / size, fy = png.height / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.min(png.width, Math.ceil((x + 1) * fx));
      const y0 = Math.floor(y * fy), y1 = Math.min(png.height, Math.ceil((y + 1) * fy));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * png.width + xx) * 4;
          const al = png.data[i + 3] / 255;
          r += png.data[i] * al; g += png.data[i + 1] * al; b += png.data[i + 2] * al; a += al; n++;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) { out.data[o] = Math.round(r / a); out.data[o + 1] = Math.round(g / a); out.data[o + 2] = Math.round(b / a); }
      out.data[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

const sizes = [16, 32, 48, 64];
const blobs = sizes.map((s) => PNG.sync.write(resize(src, s)));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
const entries = Buffer.alloc(16 * sizes.length);
let offset = 6 + entries.length;
sizes.forEach((s, i) => {
  const e = i * 16;
  entries.writeUInt8(s === 256 ? 0 : s, e); entries.writeUInt8(s === 256 ? 0 : s, e + 1);
  entries.writeUInt8(0, e + 2); entries.writeUInt8(0, e + 3);
  entries.writeUInt16LE(1, e + 4); entries.writeUInt16LE(32, e + 6);
  entries.writeUInt32LE(blobs[i].length, e + 8); entries.writeUInt32LE(offset, e + 12);
  offset += blobs[i].length;
});
fs.writeFileSync(path.resolve("src/app/favicon.ico"), Buffer.concat([header, entries, ...blobs]));
fs.writeFileSync(path.resolve("public/brand/favicon-32.png"), blobs[1]);
console.log("favicon.ico written:", sizes.join("/"), "px;", offset, "bytes");
