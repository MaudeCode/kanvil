import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { palettes } from "../packages/contracts/src/theme.ts";

const color = palettes.dark;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${color.background}"/><path d="M252 224h120v244l248-244h164L504 498l294 302H630L372 532v268H252z" fill="${color.accent}"/></svg>`;
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
