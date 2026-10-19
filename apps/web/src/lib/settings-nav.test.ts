import { expect, it } from "vite-plus/test";
import { expanded, settingsGroups, settingsHref, settingsLocation } from "./settings-nav.ts";
const projects = [
  { id: "p1", name: "Alpha" },
  { id: "p2", name: "Beta" },
];
it("shows only the groups the server granted", () => {
  expect(settingsGroups({ projects: [], admin: false }).map((group) => group.id)).toEqual([
    "account",
  ]);
  expect(
    settingsGroups({ workspace: { id: "w1" }, projects, admin: true }).map((group) => group.id),
  ).toEqual(["account", "workspace", "projects", "admin"]);
});
it("keeps the existing settings URLs", () => {
  const groups = settingsGroups({ workspace: { id: "w1" }, projects, admin: true });
  expect(groups.flatMap((group) => group.entries.map(settingsHref))).toEqual([
    "/settings?section=account",
    "/settings?section=appearance",
    "/settings?section=preferences",
    "/settings?section=credentials",
    "/settings?section=notifications",
    "/workspaces/w1/settings?section=general",
    "/workspaces/w1/settings?section=members",
    "/projects/p1/settings?section=general",
    "/projects/p2/settings?section=general",
    "/admin?section=general",
    "/admin?section=storage",
    "/admin?section=search",
    "/admin?section=events",
    "/admin?section=users",
    "/admin?section=workspaces",
    "/admin?section=authentication",
  ]);
});
it("expands the open project and locates its section", () => {
  const groups = settingsGroups({ projects, admin: false }),
    [alpha, beta] = groups[1]!.entries;
  expect(expanded(alpha!, "/projects/p2/settings")).toEqual([]);
  expect(expanded(beta!, "/projects/p2/settings").map((entry) => entry.label)).toEqual([
    "General",
    "Members",
    "Labels",
  ]);
  const location = settingsLocation(groups, "/projects/p2/settings", "labels");
  expect([location?.group.title, location?.entry.label]).toEqual(["Project settings", "Labels"]);
  expect(settingsLocation(groups, "/admin", "users")).toBeUndefined();
});
