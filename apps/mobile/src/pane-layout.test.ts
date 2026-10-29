import { expect, it } from "vite-plus/test";
import { paneLayout, usableViewport } from "./pane-layout.ts";

it("uses one full viewport on a compact phone and two panes when both minimum widths fit", () => {
  const compact = paneLayout({ width: 382, height: 508 }, []);
  expect(compact.collapsed).toBe(true);
  expect(compact.primary).toEqual({ x: 0, y: 0, width: 382, height: 508 });
  expect(compact.secondary).toEqual(compact.primary);
  const wide = paneLayout({ width: 867, height: 587 }, []);
  expect(wide.collapsed).toBe(false);
  expect(wide.primary.width).toBeGreaterThanOrEqual(280);
  expect(wide.secondary.width).toBeGreaterThanOrEqual(320);
  expect(wide.primary.width + wide.secondary.width).toBe(867);
});
it("keeps both panes outside the native fold, in either orientation", () => {
  expect(
    paneLayout({ width: 867, height: 587 }, [
      { kind: "division", frame: { x: 430, y: 0, width: 24, height: 587 }, occludesContent: false },
    ]),
  ).toEqual({
    collapsed: false,
    primary: { x: 0, y: 0, width: 430, height: 587 },
    secondary: { x: 454, y: 0, width: 413, height: 587 },
  });
  expect(
    paneLayout({ width: 669, height: 951 }, [
      { kind: "division", frame: { x: 0, y: 458, width: 669, height: 36 }, occludesContent: false },
    ]),
  ).toEqual({
    collapsed: false,
    primary: { x: 0, y: 0, width: 669, height: 458 },
    secondary: { x: 0, y: 494, width: 669, height: 457 },
  });
});
it("resizes a flat split within both pane minimums and restores the preference after rotation", () => {
  const wide = { width: 1200, height: 700 };
  expect(paneLayout(wide, [], true, 650).primary.width).toBe(650);
  expect(paneLayout(wide, [], true, 10).primary.width).toBe(280);
  expect(paneLayout(wide, [], true, 2000).secondary.width).toBe(320);
  expect(paneLayout({ width: 700, height: 1200 }, [], true, 650).primary.width).toBe(380);
  expect(paneLayout(wide, [], true, 650).primary.width).toBe(650);
  expect(paneLayout({ width: 390, height: 844 }, [], true, 650).collapsed).toBe(true);
  expect(paneLayout(wide, [], true, 280, 324).primary.width).toBe(324);
  expect(paneLayout({ width: 620, height: 700 }, [], true, 280, 324).collapsed).toBe(true);
});
it("keeps a physical hinge fixed even when a saved sidebar width requests crossing it", () => {
  const bounds = { width: 951, height: 669 };
  const regions = [
    {
      kind: "division" as const,
      frame: { x: 450, y: 0, width: 24, height: 669 },
      occludesContent: false,
    },
  ];
  const layout = paneLayout(bounds, regions, true, 700);
  expect(layout.primary.width).toBe(450);
  expect(layout.secondary.x).toBe(474);
  expect(layout).not.toHaveProperty("resizable");
});
it("leaves the full viewport to a nested navigator when its sidebar is inactive", () => {
  const bounds = { width: 867, height: 587 };
  const layout = paneLayout(
    bounds,
    [{ kind: "division", frame: { x: 430, y: 0, width: 24, height: 587 }, occludesContent: false }],
    false,
  );
  expect(layout).toEqual({
    collapsed: true,
    primary: { x: 0, y: 0, ...bounds },
    secondary: { x: 0, y: 0, ...bounds },
  });
});
it("collapses onto the usable side of a constrained fold and ignores stale display geometry", () => {
  const layout = paneLayout({ width: 867, height: 587 }, [
    { kind: "division", frame: { x: 40, y: 0, width: 24, height: 587 }, occludesContent: false },
  ]);
  expect(layout).toEqual({
    collapsed: true,
    primary: { x: 64, y: 0, width: 803, height: 587 },
    secondary: { x: 64, y: 0, width: 803, height: 587 },
  });
  expect(
    paneLayout({ width: 382, height: 508 }, [
      { kind: "division", frame: { x: 430, y: 0, width: 24, height: 587 }, occludesContent: false },
    ]),
  ).toEqual(paneLayout({ width: 382, height: 508 }, []));
});

it("keeps ordinary forms and pickers on a usable facet without constraining flat displays", () => {
  const bounds = { width: 867, height: 587 };
  expect(usableViewport(bounds, [])).toEqual({ x: 0, y: 0, ...bounds });
  expect(
    usableViewport(bounds, [
      { kind: "division", frame: { x: 430, y: 0, width: 24, height: 587 }, occludesContent: false },
    ]),
  ).toEqual({ x: 454, y: 0, width: 413, height: 587 });
});

it("prefers the right facet for reading and editing unless it cannot fit the content", () => {
  const bounds = { width: 951, height: 669 };
  expect(
    usableViewport(bounds, [
      { kind: "division", frame: { x: 490, y: 0, width: 24, height: 669 }, occludesContent: false },
    ]),
  ).toEqual({ x: 514, y: 0, width: 437, height: 669 });
  expect(
    usableViewport(bounds, [
      { kind: "division", frame: { x: 820, y: 0, width: 24, height: 669 }, occludesContent: false },
    ]),
  ).toEqual({ x: 0, y: 0, width: 820, height: 669 });
});

it("fits compact metadata by measured width rather than a fixed tag count", async () => {
  const { inlineItemCount } = await import("./pane-layout.ts");
  expect(inlineItemCount([25, 35, 30, 40, 45], 210, 20)).toBe(5);
  expect(inlineItemCount([25, 35, 30, 40, 45], 150, 20)).toBe(3);
  expect(inlineItemCount([260, 35], 150, 20)).toBe(1);
  expect(inlineItemCount([25], 0, 20)).toBe(0);
});
