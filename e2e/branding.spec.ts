import { test, expect } from "@playwright/test";
import { brandMark } from "../packages/contracts/src/theme.ts";

test("approved branding and metadata are served by the self-hosted application", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.headers()["cache-control"]).toBe("no-store");
  await expect(page.locator(".brand-mark path")).toHaveAttribute("d", brandMark.path);
  const origin = new URL(page.url()).origin;
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    `${origin}/brand/social.png`,
  );
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute(
    "content",
    `${origin}/brand/social.png`,
  );
  const links = await page
    .locator(
      'link[rel="icon"], link[rel="alternate icon"], link[rel="apple-touch-icon"], link[rel="manifest"]',
    )
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("href") ?? ""));
  expect(links).toHaveLength(4);
  for (const url of [
    ...links,
    "/brand/social.png",
    "/brand/mark-blue.svg",
    "/brand/mark-white.svg",
    "/fonts/ibm-plex-sans-latin.woff2",
  ]) {
    const asset = await page.request.get(url);
    expect(asset.status(), url).toBe(200);
    expect(asset.headers()["content-type"], url).not.toContain("text/html");
    expect((await asset.body()).byteLength, url).toBeGreaterThan(0);
  }
  const manifest = await (await page.request.get("/site.webmanifest")).json();
  expect(manifest.name).toBe("Kanvil");
  expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === "maskable")).toBe(
    true,
  );
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).status()).toBe(200);
  const nested = await page.request.get("/projects/branding-check");
  expect(nested.headers()["cache-control"]).toBe("no-store");
  expect(await nested.text()).toContain(`${origin}/brand/social.png`);
});
