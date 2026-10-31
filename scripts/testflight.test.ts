import { expect, test } from "vite-plus/test";
import { testflight } from "./testflight.ts";

const app = { data: [{ id: "kanvil", attributes: {} }] };
const build = (version: string) => ({
  id: `build-${version}`,
  attributes: { version, processingState: "VALID", expired: false },
});
const select = (data: unknown[]) => testflight("select", "1.2.3", "", async () => data.shift());

test("selects above every uploaded build, including later pages and dotted numbers", async () => {
  const urls: URL[] = [];
  const pages = [
    app,
    { data: [build("2.9")], links: { next: "/v1/builds?cursor=next" } },
    { data: [build("26")] },
  ];
  expect(
    await testflight("select", "1.2.3", "", async (url) => {
      urls.push(url);
      return pages.shift();
    }),
  ).toBe("27");
  expect(urls[0]!.searchParams.get("filter[bundleId]")).toBe("dev.kil.kanvil");
  expect(urls[1]!.searchParams.get("filter[preReleaseVersion.version]")).toBe("1.2.3");
  expect(urls[1]!.searchParams.get("filter[preReleaseVersion.platform]")).toBe("IOS");
});

test("starts a new version at one and refuses missing apps or invalid numbers", async () => {
  expect(await select([app, { data: [] }])).toBe("1");
  await expect(select([{ data: [] }])).rejects.toThrow("Expected one App Store Connect app");
  await expect(select([app, { data: [build("invalid")] }])).rejects.toThrow();
  await expect(select([app, { data: [build("9999")] }])).rejects.toThrow("exhausted");
});

test("never sends credentials to a pagination link on another origin", async () => {
  let calls = 0;
  await expect(
    testflight("select", "1.2.3", "", async () => {
      calls++;
      return { ...app, links: { next: "https://example.com/steal" } };
    }),
  ).rejects.toThrow("another origin");
  expect(calls).toBe(1);
});

test("requires the exact unexpired VALID build after Apple processing", async () => {
  for (const rows of [
    [],
    [build("8")],
    [build("7"), build("7")],
    [{ ...build("7"), attributes: { ...build("7").attributes, expired: true } }],
    [{ ...build("7"), attributes: { ...build("7").attributes, processingState: "INVALID" } }],
  ]) {
    const pages = [app, { data: rows }];
    await expect(testflight("verify", "1.2.3", "7", async () => pages.shift())).rejects.toThrow();
  }
  const pages = [app, { data: [build("7")] }];
  const result = await testflight("verify", "1.2.3", "7", async (url) => {
    if (url.pathname === "/v1/builds") expect(url.searchParams.get("filter[version]")).toBe("7");
    return pages.shift();
  });
  expect(JSON.parse(result)).toEqual({
    buildId: "build-7",
    version: "1.2.3",
    buildNumber: "7",
    processingState: "VALID",
  });
});
