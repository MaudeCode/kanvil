import { writeFile } from "node:fs/promises";
import type {
  TestInfo,
  Locator,
  Page,
  Request as BrowserRequest,
  Response as BrowserResponse,
} from "@playwright/test";
import { z } from "zod";
import { setLayout, signOut, holdRequests, openSearch } from "./controls.ts";
import { expect, test } from "./test.ts";
import { signIn } from "./auth.ts";

async function record(testInfo: TestInfo, name: string, value: unknown) {
  const path = testInfo.outputPath(name);
  await writeFile(path, JSON.stringify(value, null, 2));
  await testInfo.attach(name, { path, contentType: "application/json" });
}

// Continue scrolling to the live end while variable-height measurements settle.
async function scrollEnd(page: Page, ownerSelector: string, target: Locator) {
  await expect
    .poll(async () => {
      await page.locator(ownerSelector).evaluate((owner) => {
        owner.scrollTop = owner.scrollHeight;
      });
      if (!(await target.count())) return false;
      return target.evaluate((node) => {
        const owner = node.closest(".table-scroll, .ticket-board");
        if (!owner) return false;
        const rect = node.getBoundingClientRect(),
          view = owner.getBoundingClientRect();
        return rect.top >= view.top && rect.bottom <= view.bottom + 1;
      });
    })
    .toBe(true);
}

async function recordKeyboard(testInfo: TestInfo, name: string, page: Page, inputs: number) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await record(testInfo, name, {
    trusted: process.env.KANVIL_SCALE_BENCHMARK === "1",
    inputs,
    supported: await page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes("event")),
    durations: await page.evaluate(() =>
      performance.getEntriesByName("scale-key").map((entry) => entry.duration),
    ),
  });
}

async function monitor(page: Page) {
  await page.addInitScript(() => {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        performance.measure("scale-long-task", {
          start: entry.startTime,
          duration: entry.duration,
        });
    }).observe({ type: "longtask", buffered: true });
    const eventObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (entry.name === "keydown")
          performance.measure("scale-key", { start: entry.startTime, duration: entry.duration });
    });
    const eventOptions = { type: "event", buffered: true, durationThreshold: 16 };
    eventObserver.observe(eventOptions);
  });
  const inFlight = new Set<BrowserRequest>();
  const lists = /\/api\/v1\/(?:projects\/[^/]+\/tickets|my-work)\?/;
  page.on("request", (request) => {
    if (lists.test(request.url())) inFlight.add(request);
  });
  const settled = (request: BrowserRequest) => {
    inFlight.delete(request);
  };
  page.on("requestfinished", settled);
  page.on("requestfailed", settled);
  const cdp =
    process.env.KANVIL_SCALE_BENCHMARK === "1"
      ? await page.context().newCDPSession(page)
      : undefined;
  if (cdp) await cdp.send("Performance.enable");
  return {
    reload: async () => {
      const refreshing = page.waitForRequest((request) => lists.test(request.url()));
      await page.reload();
      await refreshing;
      await expect(page.locator("footer")).toHaveText("10,000 tickets");
    },
    sample: async (scenario: string) => {
      // A realtime burst can queue a follow-up refetch after the visible row updates.
      while (inFlight.size) {
        await Promise.all(
          [...inFlight].map(async (request) => {
            const response = await request.response();
            await response?.finished();
          }),
        );
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        );
      }
      await expect
        .poll(
          () =>
            [...inFlight].map((request) => ({
              url: request.url(),
              failure: request.failure(),
              timing: request.timing(),
            })),
          { message: `${scenario}: every list request must finish before sampling` },
        )
        .toEqual([]);
      if (!cdp)
        return {
          scenario,
          mountedRows: await page.locator(".ticket-row").count(),
          elements: await page.locator("*").count(),
        };
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      const longTasks = await page.evaluate(() =>
        performance.getEntriesByName("scale-long-task").map((entry) => entry.duration),
      );
      await cdp.send("HeapProfiler.collectGarbage");
      const metrics = await cdp.send("Performance.getMetrics");
      return {
        scenario,
        metrics: metrics.metrics,
        elapsedMs: await page.evaluate(() => performance.now()),
        mountedRows: await page.locator(".ticket-row").count(),
        elements: await page.locator("*").count(),
        longTasks,
        requests: await page.evaluate(
          (pattern) =>
            performance
              .getEntriesByType("resource")
              .filter((entry) => new RegExp(pattern).test(entry.name))
              .map((entry) => ({
                name: entry.name,
                duration: entry.duration,
                bytes: entry.toJSON().encodedBodySize,
              })),
          lists.source,
        ),
      };
    },
  };
}

// CI exercises every real DOM transition in one browser call; the opt-in timing run uses trusted keys.
async function walkTickets(page: Page, keys: string[], preview = false) {
  const selector = preview ? '[data-slot="sheet-content"]' : ".ticket-row[data-active=true]";
  if (process.env.KANVIL_SCALE_BENCHMARK === "1") {
    for (const key of keys) {
      await page.keyboard.press("j");
      await expect(page.locator(selector)).toContainText(key);
    }
    return keys.length;
  }
  await page.evaluate(
    async ({ keys: steps, selector: scope }) => {
      for (const key of steps) {
        await new Promise<void>((resolve, reject) => {
          const observer = new MutationObserver(check);
          const timeout = setTimeout(() => {
            observer.disconnect();
            reject(new Error(`Expected ${key} in ${scope}`));
          }, 5000);
          function check() {
            if (!document.querySelector(scope)?.textContent?.includes(key)) return;
            clearTimeout(timeout);
            observer.disconnect();
            requestAnimationFrame(() => resolve());
          }
          observer.observe(document.body, {
            childList: true,
            attributes: true,
            subtree: true,
            characterData: true,
          });
          const target = document.activeElement ?? document.body;
          target.dispatchEvent(
            new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }),
          );
          target.dispatchEvent(
            new KeyboardEvent("keyup", { key: "j", bubbles: true, cancelable: true }),
          );
          check();
        });
      }
    },
    { keys, selector },
  );
  return keys.length;
}

test("loads all 10,000 tickets while bounding mounted rows", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  const workspace = await (
    await page.request.post("/api/v1/workspaces", {
      data: { name: "Scale list", slug: "scale-list" },
    })
  ).json();
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "SCALE", name: "Scale fixture", workspaceId: workspace.id },
    })
  ).json();
  await page.request.post(`/api/v1/projects/${project.id}/custom-fields`, {
    data: { name: "Scale field", type: "checkbox" },
  });
  const seeded = await page.request.post("/_fixtures/ticket-scale", {
    data: { projectId: project.id },
  });
  expect(seeded.ok()).toBe(true);
  const fixtureIds = z.object({ ids: z.array(z.string()) }).parse(await seeded.json()).ids;
  expect(fixtureIds).toHaveLength(10_000);
  const loadedIds = new Set<string>();
  const reads: Promise<void>[] = [];
  const capture = (response: BrowserResponse) => {
    if (!response.url().includes(`/projects/${project.id}/tickets?`) || !response.ok()) return;
    reads.push(
      response.json().then((value) => {
        const body = z.object({ items: z.array(z.object({ id: z.string() })) }).parse(value);
        for (const row of body.items) loadedIds.add(row.id);
      }),
    );
  };
  page.on("response", capture);
  const crashed = page.waitForEvent("crash").then(() => "crashed");
  const performanceRun = await monitor(page);
  const samples = [];
  const browser = page.context().browser();
  if (process.env.KANVIL_SCALE_BENCHMARK === "1" && browser)
    await browser.startTracing(page, {
      path: testInfo.outputPath("performance-trace.json"),
      categories: ["devtools.timeline", "v8.execute", "disabled-by-default-v8.cpu_profiler"],
    });
  await page.goto(`/projects/${project.id}`);
  const loaded = page
    .locator("footer")
    .filter({ hasText: "10,000 tickets" })
    .waitFor({ timeout: 120_000 })
    .then(
      () => "loaded",
      () => "unavailable",
    );
  const outcome = await Promise.race([crashed, loaded]);
  expect(outcome, "loading all 10,000 tickets must complete without crashing the browser").toBe(
    "loaded",
  );
  page.off("response", capture);
  await Promise.all(reads);
  expect([...loadedIds].toSorted()).toEqual(fixtureIds.toSorted());
  // Completeness and rendering cost are separate assertions.
  const mounted = await page.locator(".ticket-row").count();
  expect(
    mounted,
    "mounted records must stay bounded with all 10,000 tickets loaded",
  ).toBeLessThanOrEqual(120);
  expect(await page.locator("*").count()).toBeLessThanOrEqual(6000);
  await expect(page.getByRole("table", { name: "Tickets", exact: true })).toHaveAttribute(
    "aria-rowcount",
    "10007",
  );
  for (let i = 0; i < (process.env.KANVIL_SCALE_BENCHMARK === "1" ? 5 : 1); i++) {
    if (i) await performanceRun.reload();
    samples.push(await performanceRun.sample(i ? "warm reload" : "initial load"));
  }
  if (process.env.KANVIL_SCALE_BENCHMARK === "1" && browser) await browser.stopTracing();
  await record(testInfo, "initial-performance-samples.json", samples);
  const viewportCovered = () =>
    page.locator(".table-scroll").evaluate((owner) => {
      const bounds = owner.getBoundingClientRect();
      const rows = [...owner.querySelectorAll(".ticket-row")]
        .map((row) => row.getBoundingClientRect())
        .filter((rect) => rect.bottom > bounds.top + 72 && rect.top < bounds.bottom);
      return (
        rows.length > 0 &&
        Math.min(...rows.map((row) => row.top)) <= bounds.top + 72 &&
        Math.max(...rows.map((row) => row.bottom)) >= bounds.bottom - 1
      );
    });
  await page.getByRole("rowgroup", { name: "To do tickets", exact: true }).evaluate((group) => {
    const owner = group.closest<HTMLElement>(".table-scroll");
    if (!owner) throw new Error("Missing list scroll owner");
    owner.style.overflowAnchor = "none";
    owner.scrollTop += group.getBoundingClientRect().top - owner.getBoundingClientRect().top + 1000;
  });
  await expect.poll(viewportCovered).toBe(true);
  // Model a preceding section growing as wrapped rows are measured, without a parent React render.
  await page
    .locator(".ticket-table [data-slot=table-container]")
    .nth(1)
    .evaluate((section) => {
      section.style.paddingBottom = "600px";
    });
  await expect
    .poll(viewportCovered, { message: "preceding section growth must leave no viewport gap" })
    .toBe(true);
  await page
    .locator(".ticket-table [data-slot=table-container]")
    .nth(1)
    .evaluate((section) => {
      section.style.paddingBottom = "";
    });
  await page.locator(".table-scroll").evaluate((owner) => {
    owner.style.overflowAnchor = "";
    owner.scrollTop = 0;
  });
  await page.getByRole("checkbox", { name: "Select all displayed tickets", exact: true }).check();
  await expect(page.getByRole("region", { name: "Selected tickets", exact: true })).toContainText(
    "10,000 selected",
  );
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select Done tickets", exact: true }).check();
  await expect(page.getByRole("region", { name: "Selected tickets", exact: true })).toContainText(
    "7,000",
  );
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await scrollEnd(page, ".table-scroll", page.locator(".ticket-row").last());
  await expect(page.locator(".ticket-row").last()).toContainText("SCALE-10000");
  await expect(page.locator(".ticket-row").last()).toBeInViewport();
  expect(await page.locator(".ticket-row").count()).toBeLessThanOrEqual(120);
  expect(await page.locator("*").count()).toBeLessThanOrEqual(6000);
  await page.locator(".table-scroll").evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.evaluate(() => performance.clearMeasures("scale-key"));
  const listInputs = await walkTickets(
    page,
    Array.from({ length: 300 }, (_, index) => `SCALE-${8001 + index}`),
  );
  await recordKeyboard(testInfo, "list-keyboard-timing.json", page, listInputs);
  await page.evaluate(() => performance.clearMeasures("scale-key"));
  const active = page.locator(".ticket-row[data-active=true]");
  await expect(active).toContainText("SCALE-8300");
  await expect(active).toBeInViewport();
  await active.getByRole("combobox", { name: "Difficulty", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest(".ticket-row")?.textContent))
    .toContain("SCALE-8301");
  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest(".ticket-row")?.textContent))
    .toContain("SCALE-8300");
  await page.keyboard.press("s");
  await expect(page.getByRole("option", { name: /In progress/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await active.locator(".ticket-title").focus();
  await page.keyboard.press(" ");
  const preview = page.locator('[data-slot="sheet-content"]');
  await expect(preview).toContainText("SCALE-8300");
  await preview.focus();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            performance.clearMeasures("scale-key");
            resolve();
          }),
        ),
      ),
  );
  const previewInputs = await walkTickets(
    page,
    Array.from(
      { length: 300 },
      (_, index) => `SCALE-${index < 200 ? 8301 + index : 7001 + index - 200}`,
    ),
    true,
  );
  await recordKeyboard(testInfo, "keyboard-timing.json", page, previewInputs);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".ticket-row[data-active=true] .ticket-title")).toBeFocused();
  await page.locator(".table-scroll").evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.screenshot({
    path: testInfo.outputPath("after-desktop-light.png"),
    animations: "disabled",
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: testInfo.outputPath("after-desktop-dark.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("after-mobile-dark.png"),
    animations: "disabled",
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({
    path: testInfo.outputPath("after-mobile-light.png"),
    animations: "disabled",
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await setLayout(page, "Board");
  await expect(page.locator("footer")).toHaveText("10,000 tickets");
  await expect(page.locator(".ticket-board .ticket-row").first()).toBeVisible();
  expect(await page.locator(".ticket-row").count()).toBeLessThanOrEqual(120);
  expect(await page.locator("*").count()).toBeLessThanOrEqual(6000);
  await scrollEnd(
    page,
    ".ticket-board",
    page.locator(".ticket-board .ticket-row").filter({ hasText: "SCALE-7000" }),
  );
  await expect(
    page.locator(".ticket-board .ticket-row").filter({ hasText: "SCALE-7000" }),
  ).toBeAttached();
  expect(await page.locator(".ticket-row").count()).toBeLessThanOrEqual(120);
  if (process.env.KANVIL_SCALE_BENCHMARK === "1") {
    const boardSamples = [];
    for (let i = 0; i < 5; i++) {
      await performanceRun.reload();
      boardSamples.push(await performanceRun.sample("board"));
    }
    await record(testInfo, "board-performance-samples.json", boardSamples);
  }
  await setLayout(page, "List");
  await record(testInfo, "performance-samples.json", samples);
  // Wait for the coalesced asynchronous snapshot, rather than sleeping before offline reload.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const request = indexedDB.open("kanvil-private-cache", 1);
            request.addEventListener("success", () => {
              const db = request.result;
              const read = db.transaction("clients").objectStore("clients").getAll();
              read.addEventListener("success", () => {
                db.close();
                resolve(
                  read.result
                    .flatMap((value) => value.clientState.queries)
                    .filter((query) => query.queryKey[2] === "list_tickets")
                    .reduce((n, query) => n + (query.state.data?.items?.length ?? 0), 0),
                );
              });
              read.addEventListener("error", () => reject(read.error));
            });
            request.addEventListener("error", () => reject(request.error));
          }),
      ),
    )
    .toBeGreaterThanOrEqual(10_000);
  // Bootstrap the authenticated identity while online, then restore the list snapshot offline.
  // A cold document itself needs the server; this app does not install a service worker.
  await page.route("**/assets/**", async (route) =>
    route.fulfill({ response: await route.fetch() }),
  );
  await page.route("**/api/auth/get-session", async (route) => {
    const response = await route.fetch();
    await page.context().setOffline(true);
    await route.fulfill({ response });
  });
  await page.reload();
  await expect(page.locator("footer")).toHaveText("10,000 tickets");
  await expect(page.locator(".ticket-row").first()).toBeVisible();
  await page.context().setOffline(false);
  await page.unroute("**/api/auth/get-session");
  await page.unroute("**/assets/**");
  await signOut(page);
});

for (const mode of ["planning", "work"] as const) {
  test(`loads all 10,000 matches in ${mode} with bounded DOM`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const performanceRun = await monitor(page);
    await signIn(page);
    const key = mode === "planning" ? "PLANSC" : "WORKSC";
    const workspace = await (
      await page.request.post("/api/v1/workspaces", {
        data: { name: `Scale ${mode}`, slug: `scale-${mode}` },
      })
    ).json();
    const project = await (
      await page.request.post("/api/v1/projects", {
        data: { key, name: key, workspaceId: workspace.id },
      })
    ).json();
    const seed = await page.request.post("/_fixtures/ticket-scale", {
      data: { projectId: project.id, mode },
    });
    expect(seed.ok()).toBe(true);
    const url = mode === "planning" ? `/projects/${project.id}/planning` : "/my-work";
    if (mode === "work") {
      await page.goto(`/projects/${project.id}`);
      await expect(page.locator("footer")).toHaveText("10,000 tickets", { timeout: 60_000 });
      await page.getByRole("link", { name: "My work", exact: true }).click();
    } else await page.goto(url);
    await expect(page.locator("footer")).toHaveText("10,000 tickets", { timeout: 60_000 });
    expect(await page.locator(".ticket-row").count()).toBeLessThanOrEqual(120);
    await scrollEnd(page, ".table-scroll", page.locator(".ticket-row").last());
    await expect(page.locator(".ticket-row").last()).toContainText(`${key}-10000`);
    expect(await page.locator(".ticket-row").count()).toBeLessThanOrEqual(120);
    if (process.env.KANVIL_SCALE_BENCHMARK === "1") {
      const samples = [];
      for (let i = 0; i < 5; i++) {
        await performanceRun.reload();
        samples.push(await performanceRun.sample(mode));
      }
      await record(testInfo, `${mode}-performance-samples.json`, samples);
    }
  });
}

test("reconciles 10,000 tickets through failed pages, middle moves and realtime bursts", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  const performanceRun = await monitor(page);
  const workspace = await (
    await page.request.post("/api/v1/workspaces", {
      data: { name: "Scale stress", slug: "scale-stress" },
    })
  ).json();
  const project = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "STRESS", name: "Stress fixture", workspaceId: workspace.id },
    })
  ).json();
  const seed = await page.request.post("/_fixtures/ticket-scale", {
    data: { projectId: project.id },
  });
  expect(seed.ok()).toBe(true);
  expect(z.object({ ids: z.array(z.string()) }).parse(await seed.json()).ids).toHaveLength(10_000);
  const path = `/api/v1/projects/${project.id}/tickets`;
  let failPage = true;
  await page.route(`**${path}?*`, async (route) => {
    if (failPage && new URL(route.request().url()).searchParams.get("offset") === "100")
      await route.fulfill({
        status: 503,
        json: { error: { code: "unavailable", message: "Synthetic page failure" } },
      });
    else await route.fallback();
  });
  await page.goto(`/projects/${project.id}?sort=manual&order=asc`);
  await expect(
    page.getByRole("button", { name: "Retry loading tickets", exact: true }),
  ).toBeVisible();
  failPage = false;
  await page.getByRole("button", { name: "Retry loading tickets", exact: true }).click();
  await expect(page.locator("footer")).toHaveText("10,000 tickets");
  await page.unroute(`**${path}?*`);
  await page.locator(".table-scroll").evaluate((node) => {
    node.scrollTop = node.scrollHeight / 2;
  });
  const visibleMiddle = () =>
    page.locator("tr.ticket-row").evaluateAll((rows) =>
      rows
        .filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.top > 250 && rect.bottom < 700;
        })
        .map((row) => ({
          id: row.getAttribute("data-id") ?? "",
          key: row.querySelector('[data-column="key"]')?.textContent?.trim() ?? "",
        })),
    );
  await expect.poll(async () => (await visibleMiddle()).length).toBeGreaterThanOrEqual(3);
  const middle = await visibleMiddle();
  const moving = middle[1]!,
    neighbor = middle[2]!;
  const row = (id: string) => page.locator(`.ticket-row[data-id="${id}"]`);
  await row(moving.id).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Preview", exact: true }).click();
  await expect(page.locator('[data-slot="sheet-content"]')).toContainText(moving.key);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Alt+ArrowDown");
  const number = Number(moving.key.split("-").at(-1));
  const order = async () =>
    z
      .object({ items: z.array(z.object({ id: z.string() })) })
      .parse(
        await (
          await page.request.get(
            `${path}?status=done&sort=manual&order=asc&offset=${number - 1}&limit=2`,
          )
        ).json(),
      )
      .items.map((item) => item.id);
  await expect.poll(order).toEqual([neighbor.id, moving.id]);
  await performanceRun.sample("before consecutive moves");
  const mountedList = await page.locator(".table-scroll").evaluateHandle((node) => node);
  const refreshStarted = page.waitForRequest(
    (request) => request.method() === "GET" && request.url().includes(`${path}?`),
  );
  const releaseMoveRefresh = await holdRequests(page, `**${path}?*`);
  await row(moving.id).dragTo(row(neighbor.id), { targetPosition: { x: 40, y: 4 } });
  await expect.poll(order).toEqual([moving.id, neighbor.id]);
  await refreshStarted;
  // A status step from the middle has to reveal the ticket in its new section.
  await page.keyboard.press("]");
  const read = async (id: string) =>
    (await (await page.request.get(`${path}/${id}`)).json()).ticket;
  await expect.poll(async () => (await read(moving.id)).status).toBe("cancelled");
  releaseMoveRefresh();
  await page.unroute(`**${path}?*`);
  await expect(row(moving.id)).toBeInViewport();
  await page.route(`**${path}/*/move`, (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: "version_conflict", message: "Synthetic move failure" } },
    }),
  );
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.getByText("Synthetic move failure", { exact: true })).toBeVisible();
  expect((await read(moving.id)).status).toBe("cancelled");
  await page.unroute(`**${path}/*/move`);
  const outside = await read("STRESS-1");
  expect(await row(outside.id).count()).toBe(0);
  expect(
    (
      await page.request.patch(`${path}/${outside.id}`, {
        data: {
          expectedVersion: outside.version,
          changes: { title: "Changed outside the render window" },
        },
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole("rowgroup", { name: "Done tickets", exact: true }).evaluate((node) => {
    const owner = node.closest(".table-scroll");
    if (!owner) throw new Error("Missing ticket scroll owner");
    owner.scrollTop += node.getBoundingClientRect().top - owner.getBoundingClientRect().top - 32;
  });
  await expect(row(outside.id)).toContainText("Changed outside the render window");
  expect(await mountedList.evaluate((node) => node.isConnected)).toBe(true);
  const bursts = [];
  for (let i = 0; i < (process.env.KANVIL_SCALE_BENCHMARK === "1" ? 5 : 1); i++) {
    await page.evaluate(() => {
      performance.clearMeasures("scale-long-task");
      performance.clearResourceTimings();
    });
    const tickets = z
      .object({ items: z.array(z.object({ id: z.string(), version: z.number() })) })
      .parse(
        await (await page.request.get(`${path}?status=done&sort=number&order=asc&limit=50`)).json(),
      ).items;
    const priority = i % 2 ? "low" : "high";
    const response = await page.request.post(`${path}/bulk`, {
      data: {
        tickets: tickets.map((ticket) => ({
          ticketId: ticket.id,
          expectedVersion: ticket.version,
        })),
        changes: { priority },
      },
    });
    expect(response.ok()).toBe(true);
    await expect(row(outside.id).locator(`[data-priority="${priority}"]`)).toBeVisible();
    bursts.push(await performanceRun.sample("50-event realtime burst"));
  }
  await record(testInfo, "realtime-performance-samples.json", bursts);
  await page.getByRole("button", { name: "Collapse Done tickets", exact: true }).click();
  await expect(page.getByRole("table", { name: "Tickets", exact: true })).toHaveAttribute(
    "aria-rowcount",
    "3008",
  );
  await page.getByRole("button", { name: "Expand Done tickets", exact: true }).click();
  await expect(page.getByRole("table", { name: "Tickets", exact: true })).toHaveAttribute(
    "aria-rowcount",
    "10007",
  );
  const other = await (
    await page.request.post("/api/v1/projects", {
      data: { key: "OTHERSC", name: "Other stress scope", workspaceId: workspace.id },
    })
  ).json();
  // Hold an obsolete filter's answer across a project switch, then verify the full collection returns.
  const held = page.waitForRequest(
    (request) =>
      request.url().includes(path) && new URL(request.url()).searchParams.get("q") === "held",
  );
  const release = await holdRequests(
    page,
    `**${path}?*`,
    (request) => new URL(request.url()).searchParams.get("q") === "held",
  );
  await (await openSearch(page, "Search tickets")).fill("held");
  await held;
  await page.getByRole("link", { name: "Other stress scope", exact: true }).click();
  release();
  await page.unroute(`**${path}?*`);
  await expect(page).toHaveURL(new RegExp(`/projects/${other.id}`));
  await expect(page.locator("footer")).toHaveText("0 tickets");
  await page.getByRole("link", { name: "Stress fixture", exact: true }).click();
  await expect(page.locator("footer")).toHaveText("10,000 tickets");
  expect(await page.locator(".ticket-row").count()).toBeLessThanOrEqual(120);
});
