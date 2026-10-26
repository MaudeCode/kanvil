import { expect, it } from "vite-plus/test";
import { sectionEntries, ticketSections } from "./ticket-sections.ts";

const tickets = [
  { id: "one", stateId: "ready", status: "todo" as const },
  { id: "two", stateId: null, status: "todo" as const },
  { id: "three", stateId: "old-state", status: "done" as const },
];
const workflow = [
  { id: "ready", name: "Ready", category: "todo" as const },
  { id: "next", name: "Next", category: "todo" as const },
  { id: "finished", name: "Finished", category: "done" as const },
];

it("groups by workflow ID, falling back to the category's first state for legacy tickets", () => {
  const sections = ticketSections(tickets, workflow);
  expect(
    sections.map((section) => [section.id, section.tickets.map((ticket) => ticket.id)]),
  ).toEqual([
    ["ready", ["one", "two"]],
    ["next", []],
    ["finished", ["three"]],
  ]);
});

it("removes collapsed children from virtual-list data while keeping full matching counts", () => {
  const sections = ticketSections(tickets, workflow);
  expect(sectionEntries(sections, new Set(["ready"]), false)).toEqual([
    { id: "section-ready", sectionId: "ready", heading: "Ready", count: 2 },
    { id: "section-next", sectionId: "next", heading: "Next", count: 0 },
    { id: "section-finished", sectionId: "finished", heading: "Finished", count: 1 },
    { id: "three", ticket: tickets[2] },
  ]);
  expect(
    sectionEntries(sections, new Set(), false).filter((entry) => "ticket" in entry),
  ).toHaveLength(3);
});

it("shows only matching groups for search and accepts separate temporary disclosure choices", () => {
  const sections = ticketSections(tickets.slice(0, 1), workflow),
    normal = new Set(["ready"]);
  expect(sectionEntries(sections, new Set(), true).map((entry) => entry.id)).toEqual([
    "section-ready",
    "one",
  ]);
  expect(sectionEntries(sections, new Set(["ready"]), true).map((entry) => entry.id)).toEqual([
    "section-ready",
  ]);
  expect(sectionEntries(sections, normal, false).map((entry) => entry.id)).toEqual([
    "section-ready",
    "section-next",
    "section-finished",
  ]);
});

it("falls back to canonical states when the workflow is unavailable", () => {
  const sections = ticketSections(tickets);
  expect(sections.find((section) => section.id === "todo")?.tickets).toHaveLength(2);
  expect(sections.find((section) => section.id === "done")?.tickets).toHaveLength(1);
});
