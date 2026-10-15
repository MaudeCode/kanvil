import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { brandMark, palettes } from "../packages/contracts/src/theme.ts";

const web = new URL("../apps/web/public/", import.meta.url);
const mobile = new URL("../apps/mobile/assets/", import.meta.url);
const color = palettes.light;
const path = `<path d="${brandMark.path}" fill="currentColor"/>`;
const { x, y, width, height } = brandMark.bounds;
const center = { x: x + (width - 1) / 2, y: y + (height - 1) / 2 };
const mark = (ink: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${brandMark.viewBox}" color="${ink}">${path}</svg>\n`;
function artwork(
  canvas: { width: number; height: number },
  markWidth: number,
  ink: string,
  background?: string,
) {
  const scale = markWidth / width;
  // Optical correction balances the heavy heel against the tapered horn.
  const tx = canvas.width / 2 - center.x * scale + markWidth * 0.0225;
  const ty = canvas.height / 2 - center.y * scale + markWidth * 0.015;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas.width} ${canvas.height}">${background ? `<rect width="100%" height="100%" fill="${background}"/>` : ""}<g color="${ink}" transform="translate(${tx.toFixed(4)} ${ty.toFixed(4)}) scale(${scale.toFixed(6)})">${path}</g></svg>\n`;
}
async function png(svg: string, destination: URL, size: number, opaque = false) {
  const image = sharp(Buffer.from(svg)).resize(size);
  await (opaque ? image.removeAlpha() : image).png().toFile(fileURLToPath(destination));
}
await Promise.all([
  mkdir(new URL("brand/", web), { recursive: true }),
  mkdir(mobile, { recursive: true }),
]);
const square = { width: 1024, height: 1024 };
const icon = artwork(square, 800, palettes.dark.foreground, color.accent);
const maskable = artwork(square, 600, palettes.dark.foreground, color.accent);
const favicon = artwork({ width: 32, height: 32 }, 28, palettes.dark.foreground, color.accent);
await Promise.all([
  writeFile(new URL("icon.svg", web), icon),
  writeFile(new URL("favicon.svg", web), favicon),
  writeFile(new URL("brand/mark.svg", web), mark("currentColor")),
  writeFile(new URL("brand/mark-blue.svg", web), mark(color.accent)),
  writeFile(new URL("brand/mark-white.svg", web), mark(palettes.dark.foreground)),
  png(icon, new URL("icon.png", mobile), 1024, true),
  png(icon, new URL("apple-touch-icon.png", web), 180, true),
  png(icon, new URL("brand/icon-192.png", web), 192, true),
  png(icon, new URL("brand/icon-512.png", web), 512, true),
  png(maskable, new URL("brand/maskable-512.png", web), 512, true),
  png(artwork(square, 600, "#ffffff"), new URL("adaptive-icon.png", mobile), 1024),
  png(artwork(square, 600, "#ffffff"), new URL("notification-icon.png", mobile), 96),
  png(artwork(square, 800, color.accent), new URL("splash-light.png", mobile), 1024),
  png(artwork(square, 800, palettes.dark.accent), new URL("splash-dark.png", mobile), 1024),
  png(
    artwork({ width: 1200, height: 630 }, 700, palettes.dark.foreground, color.accent),
    new URL("brand/social.png", web),
    1200,
    true,
  ),
  writeFile(
    new URL("site.webmanifest", web),
    JSON.stringify(
      {
        name: "Kanvil",
        short_name: "Kanvil",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: color.background,
        theme_color: color.accent,
        icons: [
          { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          {
            src: "/brand/maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      null,
      2,
    ) + "\n",
  ),
]);
// ICO supports PNG entries; keep the browser fallback derived from the same artwork.
const sizes = [16, 32, 48];
const entries = await Promise.all(
  sizes.map((size) => sharp(Buffer.from(favicon)).resize(size).png().toBuffer()),
);
const header = Buffer.alloc(6 + entries.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
for (const [index, entry] of entries.entries()) {
  const at = 6 + index * 16;
  header[at] = sizes[index] ?? 0;
  header[at + 1] = sizes[index] ?? 0;
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(entry.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += entry.length;
}
await writeFile(new URL("favicon.ico", web), Buffer.concat([header, ...entries]));
