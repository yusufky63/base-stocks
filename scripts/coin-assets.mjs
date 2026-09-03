// Copy the 3D coin renders into public/brand/coins and derive light 200px variants for tiles.
// Usage: node scripts/coin-assets.mjs "<dir with *-circular-coin (1).png files>"
import { PNG } from "pngjs";
import fs from "node:fs";
import path from "node:path";

const srcDir = process.argv[2];
if (!srcDir) {
  console.error("usage: node scripts/coin-assets.mjs <source dir>");
  process.exit(1);
}
const outDir = path.resolve("public/brand/coins");
fs.mkdirSync(outDir, { recursive: true });

/** ticker -> source file stem (the renders are named by company). */
const COINS = {
  aapl: "apple-logo-on-black-circular-coin",
  googl: "google-logo-on-white-circular-coin",
  meta: "meta-logo-on-blue-circular-coin",
  msft: "microsoft-logo-on-black-circular-coin",
  nvda: "nvidia-logo-on-black-circular-coin",
  tsla: "tesla-logo-on-red-circular-coin",
};

/** Area-averaging downscale with premultiplied alpha (no dark fringes on the transparent edge). */
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
        out.data[o] = out.data[o + 1] = out.data[o + 2] = out.data[o + 3] = 0;
      }
    }
  }
  return out;
}

for (const [ticker, stem] of Object.entries(COINS)) {
  const candidates = [`${stem} (1).png`, `${stem}.png`];
  const file = candidates.map((f) => path.join(srcDir, f)).find((f) => fs.existsSync(f));
  if (!file) {
    console.warn("missing", ticker, candidates[0]);
    continue;
  }
  const png = PNG.sync.read(fs.readFileSync(file));
  fs.copyFileSync(file, path.join(outDir, `${ticker}.png`));
  fs.writeFileSync(path.join(outDir, `${ticker}-200.png`), PNG.sync.write(resize(png, 200)));
  console.log("wrote", ticker, `${png.width}x${png.height}`, "+ 200px");
}
