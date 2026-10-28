import { expect, it } from "vite-plus/test";
import { createProjectContexts, createSearchBarHandle } from "./navigation.ts";
import { ticketFilter } from "@kanvil/contracts";

it("restores each project's browsing context without borrowing another project's selection", () => {
  const contexts = createProjectContexts();
  const filters = ticketFilter.parse({ status: "todo", priority: "high" });
  contexts.save("project-a", {
    filters,
    query: "release",
    selectedTicketId: "ticket-a",
    secondaryVisible: false,
    sidebarHidden: true,
    location: { projectId: "project-a", layout: "board", viewId: "view-a", collection: "planning" },
    anchor: new Date("2026-10-26T12:00:00Z"),
    scrollOffset: 480,
  });
  contexts.save("project-b", { query: "deployment", scrollOffset: 50 });
  contexts.save("project-a", { scrollOffset: 640 });
  expect(contexts.get("project-a")).toEqual({
    filters,
    query: "release",
    selectedTicketId: "ticket-a",
    secondaryVisible: false,
    sidebarHidden: true,
    location: { projectId: "project-a", layout: "board", viewId: "view-a", collection: "planning" },
    anchor: new Date("2026-10-26T12:00:00Z"),
    scrollOffset: 640,
  });
  expect(contexts.get("project-b")).toEqual({ query: "deployment", scrollOffset: 50 });
});

it("isolates accounts and refuses writes from mounted screens after sign-out", () => {
  const first = createProjectContexts(),
    second = createProjectContexts();
  first.save("project", { query: "private", selectedTicketId: "private-ticket" });
  expect(second.get("project")).toBeUndefined();
  first.clear();
  first.save("project", { query: "late scroll callback" });
  expect(first.get("project")).toBeUndefined();
  second.save("project", { query: "other account" });
  expect(second.get("project")?.query).toBe("other account");
});

it("restores late-mounted search controls without overwriting typing when their handle refreshes", async () => {
  const handle = createSearchBarHandle("cached query"),
    writes: string[] = [];
  const commands = {
    focus() {},
    blur() {},
    clearText() {},
    cancelSearch() {},
    toggleCancelButton() {},
    setText(value: string) {
      writes.push(value);
    },
  };
  handle.ref.current = commands;
  expect(writes).toEqual(["cached query"]);
  handle.updateText("edited query");
  expect(writes).toEqual(["cached query"]);
  handle.ref.current = null;
  handle.ref.current = commands;
  expect(writes).toEqual(["cached query"]);
  await Promise.resolve();
  handle.ref.current = null;
  await Promise.resolve();
  handle.ref.current = commands;
  expect(handle.ref.current).toBe(commands);
  expect(writes).toEqual(["cached query", "edited query"]);
});

it("retains collection disclosure choices and workspace searches only within their account", () => {
  const contexts = createProjectContexts();
  contexts.save("a", { collapsedSections: { all: ["ready"], planning: ["archived"] } });
  contexts.save("a", { query: "search" });
  expect(contexts.get("a")?.collapsedSections).toEqual({ all: ["ready"], planning: ["archived"] });
  expect(contexts.get("b")?.collapsedSections).toBeUndefined();
  contexts.saveSearch("workspace-a", "work", "release");
  contexts.saveSearch("workspace-a", "search", "comment");
  expect(contexts.search("workspace-a", "work")).toBe("release");
  expect(contexts.search("workspace-a", "search")).toBe("comment");
  expect(contexts.search("workspace-b", "work")).toBe("");
  contexts.clear();
  contexts.saveSearch("workspace-a", "work", "late");
  expect(contexts.search("workspace-a", "work")).toBe("");
});

it("recent project order does not discard browsing state or revive a signed-out account", () => {
  const contexts = createProjectContexts();
  contexts.save("one", { query: "important" });
  contexts.touch("one");
  contexts.touch("two");
  contexts.touch("one");
  expect(contexts.recent()).toEqual(["one", "two"]);
  expect(contexts.get("one")?.query).toBe("important");
  contexts.clear();
  contexts.touch("one");
  expect(contexts.recent()).toEqual([]);
});

it("focuses a requested native search after its control mounts, after restoring its query", () => {
  const handle = createSearchBarHandle("retained"),
    calls: string[] = [];
  handle.focus();
  expect(calls).toEqual([]);
  handle.ref.current = {
    focus() {
      calls.push("focus");
    },
    blur() {},
    clearText() {},
    cancelSearch() {},
    toggleCancelButton() {},
    setText(value: string) {
      calls.push(value);
    },
  };
  expect(calls).toEqual(["retained", "focus"]);
});
