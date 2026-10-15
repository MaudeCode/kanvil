import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { brandPath, palettes } from "../packages/contracts/src/theme.ts";

const color = palettes.light;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="${color.accent}"/><path d="${brandPath}" fill="${color.surface}"/></svg>`;
await Promise.all([
  mkdir(new URL("../apps/web/public/", import.meta.url), { recursive: true }),
  mkdir(new URL("../apps/mobile/assets/", import.meta.url), { recursive: true }),
]);
await writeFile(new URL("../apps/web/public/icon.svg", import.meta.url), `${svg}\n`);
await sharp(Buffer.from(svg))
  .resize(1024, 1024)
  .removeAlpha()
  .png()
  .toFile(fileURLToPath(new URL("../apps/mobile/assets/icon.png", import.meta.url)));
