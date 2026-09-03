// Derive the brand assets from public/brand/logo-mark-1024.png (blue mark on white):
// transparent versions for the header and share card, downscaled sizes, and the manifest icon/splash.
// Usage: node scripts/brand-assets.mjs
import { PNG } from "pngjs";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve("public/brand");
const src = PNG.sync.read(fs.readFileSync(path.join(dir, "logo-mark-1024.png")));

function toRGBA(png) {
  return png;
}

/** White (and near-white) pixels become transparent; soft edges keep partial alpha. */
function knockoutWhite(png) {
  const out = new PNG({ width: png.width, height: png.height });
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    const whiteness = Math.min(r, g, b) / 255; // 1 = pure white
    const alpha = whiteness > 0.92 ? 0 : whiteness > 0.75 ? Math.round((1 - (whiteness - 0.75) / 0.17) * 255) : 255;
    out.data[i] = r;
    out.data[i + 1] = g;
    out.data[i + 2] = b;
    out.data[i + 3] = Math.min(alpha, png.data[i + 3]);
  }
  return out;
}

/** Area-averaging downscale (works for non-integer factors); premultiplied alpha to avoid dark fringes. */
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
          r += png.data[i] * al;
          g += png.data[i + 1] * al;
          b += png.data[i + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
        out.data[o + 3] = Math.round((a / n) * 255);
      } else {
        out.data[o] = out.data[o + 1] = out.data[o + 2] = 0;
        out.data[o + 3] = 0;
      }
    }
  }
  return out;
}

/** Flatten onto a solid background (manifest icon and splash must be opaque). */
function flatten(png, [br, bg, bb]) {
  const out = new PNG({ width: png.width, height: png.height });
  for (let i = 0; i < png.data.length; i += 4) {
    const a = png.data[i + 3] / 255;
    out.data[i] = Math.round(png.data[i] * a + br * (1 - a));
    out.data[i + 1] = Math.round(png.data[i + 1] * a + bg * (1 - a));
    out.data[i + 2] = Math.round(png.data[i + 2] * a + bb * (1 - a));
    out.data[i + 3] = 255;
  }
  return out;
}

const write = (name, png) => {
  fs.writeFileSync(path.join(dir, name), PNG.sync.write(png));
  console.log("wrote", name, `${png.width}x${png.height}`);
};

const transparent = knockoutWhite(toRGBA(src));
write("logo-mark-transparent-1024.png", transparent);
write("logo-mark-transparent-256.png", resize(transparent, 256));
write("logo-mark-transparent-128.png", resize(transparent, 128));
write("logo-mark-transparent-64.png", resize(transparent, 64));
write("icon-1024.png", flatten(transparent, [255, 255, 255]));
write("splash-200.png", flatten(resize(transparent, 200), [255, 255, 255]));
