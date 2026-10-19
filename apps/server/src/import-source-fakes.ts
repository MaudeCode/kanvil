// What the fake Trello, Plane, PLANKA, and Kaneo APIs in import-source-fixture.ts hold and how they
// answer. Each pages like its real API, in small pages, and checks the credentials it was given.
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";

// The person every source names with the importer's own email.
export const sourceOwnerEmail = "owner@example.test";

export const fakeCredentials = {
  trello: { apiKey: "trello-fixture-key-0123456789", token: "trello-fixture-secret-0123456789" },
  plane: "plane_api_fixture_secret_0123456789",
  planka: {
    username: "ann",
    password: "planka fixture password 0123456789",
    apiKey: "abcdefgh_plankafixturesecret0123456789",
    session: "planka-fixture-session-0123456789",
  },
  kaneo: "kaneo-fixture-secret-0123456789",
};
// A Trello ID starts with its creation time in seconds.
const trelloId = (seconds: number, n: number) =>
  `${seconds.toString(16).padStart(8, "0")}${n.toString(16).padStart(16, "0")}`;
const april = Date.UTC(2026, 3, 1) / 1000;
const page = <T>(items: T[], cursor: string | null) => {
  const start = cursor ? Number(cursor.split(":")[1]) : 0,
    end = start + 2;
  return {
    total_count: items.length,
    next_cursor: `2:${end}:0`,
    next_page_results: end < items.length,
    results: items.slice(start, end),
  };
};

// Records by ID or name, typed by what they hold.
const byKey = <T>(value: Record<string, T>) => value;
// Items with the fields a test does not set.
const trelloCard = <T extends object>(fields: T) => ({
  desc: "",
  due: null,
  start: null,
  dueComplete: false,
  idMembers: [],
  labels: [],
  closed: false,
  badges: { attachments: 0 },
  ...fields,
});
const planeItem = <T extends object>(fields: T) => ({
  description_html: null,
  priority: "none",
  parent: null,
  assignees: [],
  labels: [],
  start_date: null,
  target_date: null,
  created_by: "pu-owner",
  estimate_point: null,
  cycle_id: null,
  attachment_count: 0,
  link_count: 0,
  ...fields,
});
const planeRelations = <T extends Record<string, { issue_id: string }[]>>(fields: T) => ({
  blocking: [],
  blocked_by: [],
  duplicate: [],
  relates_to: [],
  start_before: [],
  start_after: [],
  finish_before: [],
  finish_after: [],
  ...fields,
});
const kaneoTask = <T extends object>(fields: T) => ({
  description: "",
  priority: "no-priority",
  startDate: null,
  dueDate: null,
  userId: null,
  assigneeName: null,
  labels: [],
  externalLinks: [],
  ...fields,
});

export function seed() {
  const ann = { id: "tm-ann", fullName: "Ann Trello", username: "ann" },
    bob = { id: "tm-bob", fullName: "Bob Trello", username: "bob" };
  const trello = {
    boards: [
      { id: "tb-roadmap", name: "Roadmap", desc: "Product roadmap" },
      { id: "tb-ideas", name: "Ideas", desc: "" },
    ],
    lists: [
      { id: "tl-todo", name: "To Do", closed: false },
      { id: "tl-doing", name: "Doing", closed: false },
      { id: "tl-done", name: "Done", closed: false },
      // A second list with the same name, which holds an archived card.
      { id: "tl-done-old", name: "Done", closed: true },
      // An archived, empty list.
      { id: "tl-unused", name: "Someday", closed: true },
    ],
    members: [ann, bob],
    cards: [
      trelloCard({
        id: trelloId(april, 1),
        idShort: 1,
        name: "Plan the launch",
        desc: "Launch **plan**",
        start: "2026-04-01T09:00:00.000Z",
        due: "2026-05-01T17:00:00.000Z",
        dueComplete: true,
        idList: "tl-doing",
        idMembers: ["tm-ann", "tm-bob"],
        labels: [
          { name: "Bug", color: "red" },
          { name: "", color: "green_dark" },
        ],
        badges: { attachments: 2 },
      }),
      trelloCard({
        id: trelloId(april + 60, 2),
        idShort: 2,
        name: "Write the copy",
        idList: "tl-done-old",
        labels: [{ name: "marketing", color: "sky" }],
        closed: true,
      }),
      trelloCard({ id: trelloId(april + 120, 3), idShort: 3, name: "Ship it", idList: "tl-todo" }),
    ],
    checklists: [
      {
        id: trelloId(april, 10),
        idCard: trelloId(april, 1),
        name: "Steps",
        pos: 2,
        checkItems: [
          { name: "Review", state: "incomplete", pos: 2 },
          { name: "Draft", state: "complete", pos: 1 },
        ],
      },
    ],
    // Newest first, as Trello answers.
    comments: [
      {
        id: trelloId(april + 7200, 21),
        date: "2026-04-01T11:00:00.000Z",
        data: { text: "Copy is ready", card: { id: trelloId(april, 1) } },
        memberCreator: bob,
      },
      {
        id: trelloId(april + 3600, 20),
        date: "2026-04-01T10:00:00.000Z",
        data: { text: "Drafting now", card: { id: trelloId(april, 1) } },
        memberCreator: ann,
      },
    ],
    customFields: [{ id: "tf-1" }],
  };

  const plane = {
    // Plane before 1.1 has no `work-items` or relations.
    legacy: false,
    projects: [
      { id: "pp-web", identifier: "WEB", name: "Website", description: "Site work" },
      { id: "pp-app", identifier: "APP", name: "App", description: "" },
      { id: "pp-ops", identifier: "OPS", name: "Operations", description: "" },
    ],
    states: [
      { id: "ps-backlog", name: "Backlog", group: "backlog", color: "#a3a3a3" },
      { id: "ps-todo", name: "Todo", group: "unstarted", color: "#3a3a3a" },
      { id: "ps-progress", name: "In Progress", group: "started", color: "#f59e0b" },
      { id: "ps-done", name: "Done", group: "completed", color: "#16a34a" },
      { id: "ps-cancelled", name: "Cancelled", group: "cancelled", color: "#ef4444" },
    ],
    labels: [
      { id: "pl-bug", name: "bug", color: "#ff0000" },
      { id: "pl-ui", name: "ui", color: "#00ff00" },
    ],
    members: [
      {
        id: "pu-owner",
        display_name: "owner",
        first_name: "Owner",
        last_name: "Plane",
        email: sourceOwnerEmail,
      },
      { id: "pu-dev", display_name: "dev", first_name: "", last_name: "", email: "dev@else.test" },
    ],
    items: [
      planeItem({
        id: "pw-1",
        sequence_id: 1,
        name: "Redesign the homepage",
        description_html:
          '<p>New <strong>hero</strong> and a <a href="https://example.test/brief">brief</a>.</p><ul><li>Desktop</li><li>Mobile</li></ul>',
        priority: "high",
        state: "ps-progress",
        assignees: ["pu-owner", "pu-dev"],
        labels: ["pl-ui"],
        start_date: "2026-05-01",
        target_date: "2026-05-31",
        created_at: "2026-04-20T08:00:00.000000Z",
        estimate_point: "pe-1",
        cycle_id: "pc-1",
        attachment_count: 1,
      }),
      planeItem({
        id: "pw-2",
        sequence_id: 2,
        name: "Fix the footer",
        priority: "urgent",
        state: "ps-todo",
        parent: "pw-1",
        labels: ["pl-bug"],
        created_at: "2026-04-21T08:00:00.000000Z",
        created_by: "pu-gone",
      }),
      planeItem({
        id: "pw-3",
        sequence_id: 3,
        name: "Remove the old copy",
        priority: "low",
        state: "ps-done",
        created_at: "2026-04-22T08:00:00.000000Z",
      }),
    ],
    relations: byKey({
      "pw-1": planeRelations({
        blocking: [{ issue_id: "pw-3" }],
        relates_to: [{ issue_id: "pw-2" }],
        start_before: [{ issue_id: "pw-2" }],
      }),
      "pw-2": planeRelations({ relates_to: [{ issue_id: "pw-1" }] }),
      "pw-3": planeRelations({ blocked_by: [{ issue_id: "pw-1" }] }),
    }),
    // Newest first, as Plane answers.
    comments: byKey({
      "pw-1": [
        {
          id: "pc-2",
          comment_html: "<p>Shipped to staging</p>",
          actor: "pu-dev",
          created_at: "2026-04-24T08:00:00.000000Z",
        },
        {
          id: "pc-1",
          comment_html: "<p>First <em>pass</em></p>",
          actor: "pu-owner",
          created_at: "2026-04-23T08:00:00.000000Z",
        },
      ],
    }),
    modules: 2,
  };

  const plankaUsers = [
    { id: "5001", name: "Ann Planka", username: "ann", email: sourceOwnerEmail },
    // PLANKA 2 hides other people's emails.
    { id: "5002", name: "Bob Planka", username: "bob" },
  ];
  const planka = {
    projects: [{ id: "1001", name: "Marketing" }],
    boards: [
      { id: "2001", projectId: "1001", name: "Campaigns", position: 2 },
      { id: "2002", projectId: "1001", name: "Classic", position: 1 },
    ],
    // PLANKA 2: typed lists, task lists, archived cards apart, comments on their own route.
    modern: {
      item: { id: "2001", name: "Campaigns" },
      included: {
        users: plankaUsers.slice(0, 1),
        lists: [
          { id: "3002", name: "Live", type: "closed", position: 2, color: null },
          { id: "3001", name: "Ideas", type: "active", position: 1, color: "lagoon-blue" },
          { id: "3003", name: null, type: "archive", position: null, color: null },
          { id: "3004", name: null, type: "trash", position: null, color: null },
        ],
        cards: [
          {
            id: "4001",
            name: "Spring launch",
            description: "Launch **it**",
            dueDate: "2026-03-20T10:00:00.000Z",
            isDueCompleted: false,
            listId: "3001",
            prevListId: null,
            creatorUserId: "5001",
            createdAt: "2026-02-01T09:00:00.000Z",
            listChangedAt: "2026-02-01T09:00:00.000Z",
            stopwatch: { startedAt: null, total: 60 },
            commentsTotal: 2,
          },
          {
            id: "4002",
            name: "Retro",
            description: null,
            dueDate: null,
            listId: "3002",
            prevListId: null,
            creatorUserId: "5002",
            createdAt: "2026-02-02T09:00:00.000Z",
            listChangedAt: "2026-02-02T09:00:00.000Z",
            stopwatch: null,
            commentsTotal: 0,
          },
        ],
        labels: [
          { id: "6001", name: "Urgent", color: "berry-red", position: 1 },
          { id: "6002", name: null, color: "lagoon-blue", position: 2 },
        ],
        cardLabels: [
          { id: "6101", cardId: "4001", labelId: "6001" },
          { id: "6102", cardId: "4001", labelId: "6002" },
        ],
        cardMemberships: [{ id: "6201", cardId: "4001", userId: "5001" }],
        taskLists: [{ id: "7001", cardId: "4001", name: "Prep", position: 1 }],
        tasks: [
          { id: "7102", taskListId: "7001", name: "Send invites", isCompleted: false, position: 2 },
          { id: "7101", taskListId: "7001", name: "Book a venue", isCompleted: true, position: 1 },
        ],
        attachments: [{ id: "6301", cardId: "4001" }],
        customFieldValues: [],
      },
    },
    // Some PLANKA versions ignore the archive cursor and answer the first page again.
    ignoresCursor: false,
    archiveReads: 0,
    archived: [
      {
        id: "4003",
        name: "Old flyer",
        description: null,
        dueDate: null,
        listId: "3003",
        prevListId: "3001",
        creatorUserId: "5001",
        createdAt: "2026-01-01T09:00:00.000Z",
        listChangedAt: "2026-01-05T09:00:00.000Z",
        stopwatch: null,
        commentsTotal: 0,
      },
    ],
    // Newest first, as PLANKA answers.
    comments: byKey({
      "4001": [
        { id: "8002", text: "Venue booked", userId: "5002", createdAt: "2026-02-04T09:00:00.000Z" },
        { id: "8001", text: "Starting", userId: "5001", createdAt: "2026-02-03T09:00:00.000Z" },
      ],
    }),
    // PLANKA 1: untyped lists, tasks on cards, comments among card actions.
    classic: {
      item: { id: "2002", name: "Classic" },
      included: {
        users: plankaUsers,
        lists: [{ id: "3101", name: "Backlog", position: 1 }],
        cards: [
          {
            id: "4101",
            name: "Old way",
            description: "Plain",
            dueDate: null,
            isDueDateCompleted: false,
            listId: "3101",
            creatorUserId: "5002",
            createdAt: "2025-01-01T09:00:00.000Z",
            stopwatch: null,
          },
        ],
        labels: [],
        cardLabels: [],
        cardMemberships: [{ id: "6202", cardId: "4101", userId: "5002" }],
        tasks: [{ id: "7201", cardId: "4101", name: "Check", isCompleted: false, position: 1 }],
        attachments: [],
      },
    },
    actions: byKey({
      "4101": [
        {
          id: "8102",
          type: "commentCard",
          data: { text: "Classic comment" },
          userId: "5001",
          createdAt: "2025-01-03T09:00:00.000Z",
        },
        {
          id: "8101",
          type: "createCard",
          data: {},
          userId: "5002",
          createdAt: "2025-01-01T09:00:00.000Z",
        },
      ],
    }),
  };

  const kaneo = {
    workspaces: [{ id: "kw-acme", name: "Acme" }],
    projects: [
      { id: "kp-platform", name: "Platform", slug: "plat", workspaceId: "kw-acme" },
      { id: "kp-docs", name: "Docs", slug: "docs", workspaceId: "kw-acme" },
    ],
    columns: [
      { id: "to-do", name: "To Do", isFinal: false, position: 0 },
      { id: "in-progress", name: "In Progress", isFinal: false, position: 1 },
      { id: "done", name: "Done", isFinal: true, position: 2 },
    ],
    // Labels split across the two related pages: `[first page labels, second page labels]`.
    tasks: [
      kaneoTask({
        id: "kt-1",
        number: 1,
        title: "Set up CI",
        description: "Run **checks**",
        status: "in-progress",
        priority: "high",
        startDate: "2026-06-01T00:00:00.000Z",
        dueDate: "2026-06-10T00:00:00.000Z",
        createdAt: "2026-05-01T09:00:00.000Z",
        userId: "ku-owner",
        assigneeName: "Owner Kaneo",
        externalLinks: [{ url: "https://example.test/pull/1" }],
      }),
      kaneoTask({
        id: "kt-2",
        number: 2,
        title: "Add caching",
        status: "to-do",
        createdAt: "2026-05-02T09:00:00.000Z",
        userId: "ku-gone",
        assigneeName: "Gone Person",
      }),
      kaneoTask({
        id: "kt-3",
        number: 3,
        title: "Retire the VM",
        status: "archived",
        priority: "low",
        createdAt: "2026-05-03T09:00:00.000Z",
      }),
      kaneoTask({
        id: "kt-4",
        number: 4,
        title: "Explore search",
        status: "planned",
        description: null,
        descriptionDeferred: true,
        createdAt: "2026-05-04T09:00:00.000Z",
      }),
    ],
    // A task's labels on each related page.
    labels: byKey({
      "kt-1": [[{ name: "bug", color: "red" }], [{ name: "backend", color: "#3b82f6" }]],
    }),
    descriptions: byKey({ "kt-4": "A long **description**" }),
    members: [
      { id: "ku-owner", name: "Owner Kaneo", email: sourceOwnerEmail },
      { id: "ku-dev", name: "Dev Kaneo", email: "dev@else.test" },
    ],
    relations: [
      { id: "kr-1", sourceTaskId: "kt-1", targetTaskId: "kt-2", relationType: "subtask" },
      { id: "kr-2", sourceTaskId: "kt-1", targetTaskId: "kt-3", relationType: "blocks" },
    ],
    comments: byKey({
      "kt-1": [
        {
          id: "kc-1",
          userId: "ku-dev",
          content: "Pipeline is green",
          createdAt: "2026-05-05T09:00:00.000Z",
          user: { name: "Dev Kaneo" },
        },
      ],
    }),
    customFields: [{ id: "kf-1" }],
  };
  return { trello, plane, planka, kaneo };
}
export type SourceData = ReturnType<typeof seed>;

interface Answer {
  status: number;
  body: unknown;
}
const ok = (body: unknown): Answer => ({ status: 200, body });
const missing: Answer = { status: 404, body: { message: "Not found" } };
type Serve = (
  data: SourceData,
  method: string,
  url: URL,
  headers: IncomingHttpHeaders,
  body: string,
) => Answer;
const value = (headers: IncomingHttpHeaders, name: string) => {
  const found = headers[name];
  return Array.isArray(found) ? (found[0] ?? "") : (found ?? "");
};

// Trello pages a board's cards and actions newest first, `limit` at a time, before an ID.
const trello: Serve = (data, method, url, headers) => {
  const { apiKey, token } = fakeCredentials.trello;
  if (
    value(headers, "authorization") !==
    `OAuth oauth_consumer_key="${apiKey}", oauth_token="${token}"`
  )
    return { status: 401, body: "invalid token" };
  if (method !== "GET") return { status: 405, body: "" };
  const path = url.pathname.replace(/^\/trello\/1\//, ""),
    query = url.searchParams;
  const capped = <T extends { id: string }>(items: T[]) => {
    const before = query.get("before");
    return [...items]
      .toSorted((a, b) => b.id.localeCompare(a.id))
      .filter((found) => !before || found.id < before)
      .slice(0, Number(query.get("limit") ?? 50));
  };
  if (path === "members/me/boards") return ok(data.trello.boards);
  const [, id, part] = /^boards\/([^/]+)(?:\/(.+))?$/.exec(path) ?? [];
  const board = data.trello.boards.find((found) => found.id === id);
  if (!board || id !== "tb-roadmap")
    return { status: 404, body: "The requested resource was not found." };
  if (!part) return ok(board);
  if (part === "lists") return ok(data.trello.lists);
  if (part === "members") return ok(data.trello.members);
  if (part === "cards/all") return ok(capped(data.trello.cards));
  if (part === "checklists") return ok(capped(data.trello.checklists));
  if (part === "actions" && query.get("filter") === "commentCard")
    return ok(capped(data.trello.comments));
  if (part === "customFields") return ok(data.trello.customFields);
  return missing;
};

// Plane pages with `per_page` and a cursor; this fake answers two items a page whatever is asked.
const plane: Serve = (data, method, url, headers) => {
  if (value(headers, "x-api-key") !== fakeCredentials.plane)
    return { status: 403, body: { detail: "Given API token is not valid" } };
  if (method !== "GET") return { status: 405, body: {} };
  const path = url.pathname.replace(/^\/plane\/api\/v1\/workspaces\/acme\//, ""),
    cursor = url.searchParams.get("cursor");
  if (path === url.pathname) return { status: 404, body: { error: "No such workspace" } };
  if (path === "projects/") return ok(page(data.plane.projects, cursor));
  const [, id, rest = ""] = /^projects\/([^/]+)\/(.*)$/.exec(path) ?? [];
  const project = data.plane.projects.find((found) => found.id === id);
  // Plane refuses a project you cannot read as forbidden, not missing.
  if (!project || id !== "pp-web")
    return { status: 403, body: { detail: "You do not have permission to perform this action." } };
  if (rest === "") return ok(project);
  if (rest === "states/") return ok(page(data.plane.states, cursor));
  if (rest === "labels/") return ok(page(data.plane.labels, cursor));
  if (rest === "members/") return ok(data.plane.members);
  if (rest === "modules/") return ok({ ...page([], cursor), total_count: data.plane.modules });
  const kind = data.plane.legacy ? "issues" : "work-items";
  if (rest === `${kind}/`) return ok(page(data.plane.items, cursor));
  const [, item, child] = /^(?:work-items|issues)\/([^/]+)\/([a-z]+)\/$/.exec(rest) ?? [];
  if (!rest.startsWith(`${kind}/`) || !item) return missing;
  if (child === "relations" && !data.plane.legacy) return ok(data.plane.relations[item] ?? {});
  if (child === "comments") return ok(page(data.plane.comments[item] ?? [], cursor));
  return missing;
};

// PLANKA signs in with a password or takes an API key; archived cards and comments page 50 at a
// time, newest first, before an ID or a list change.
const planka: Serve = (data, method, url, headers, body) => {
  const credentials = fakeCredentials.planka;
  const path = url.pathname.replace(/^\/planka\/api\//, "");
  if (path === "access-tokens" && method === "POST") {
    const signIn = z
      .object({ emailOrUsername: z.string(), password: z.string() })
      .partial()
      .parse(JSON.parse(body));
    return signIn.emailOrUsername === credentials.username &&
      signIn.password === credentials.password
      ? ok({ item: credentials.session })
      : { status: 401, body: { code: "E_UNAUTHORIZED", message: "Invalid credentials" } };
  }
  const bearer = value(headers, "authorization") === `Bearer ${credentials.session}`;
  if (!bearer && value(headers, "x-api-key") !== credentials.apiKey)
    return { status: 401, body: { code: "E_UNAUTHORIZED", message: "Access token is missing" } };
  if (path === "access-tokens/me" && method === "DELETE") return ok({ item: {} });
  if (method !== "GET") return { status: 405, body: {} };
  const newest = <T extends { id: string }>(items: T[]) => {
    const before = url.searchParams.get("beforeId");
    return items.filter((found) => !before || BigInt(found.id) < BigInt(before)).slice(0, 50);
  };
  const empty = {
    users: [],
    cardLabels: [],
    cardMemberships: [],
    taskLists: [],
    tasks: [],
    attachments: [],
    customFieldValues: [],
  };
  if (path === "projects")
    return ok({ items: data.planka.projects, included: { boards: data.planka.boards } });
  if (path === "boards/2001") return ok(data.planka.modern);
  if (path === "boards/2002") return ok(data.planka.classic);
  if (path === "lists/3003/cards") {
    // A reader that keeps asking for the same page is cut off.
    if (++data.planka.archiveReads > 10) return { status: 400, body: { message: "Runaway" } };
    const changed = data.planka.ignoresCursor
      ? null
      : url.searchParams.get("before[listChangedAt]");
    const items = data.planka.archived
      .filter((found) => !changed || found.listChangedAt < changed)
      .toSorted((a, b) => b.listChangedAt.localeCompare(a.listChangedAt))
      .slice(0, 50);
    return ok({ items, included: empty });
  }
  const [, card, kind] = /^cards\/(\d+)\/(comments|actions)$/.exec(path) ?? [];
  if (card && kind === "comments" && data.planka.comments[card])
    return ok({
      items: newest(data.planka.comments[card]),
      included: { users: [{ id: "5002", name: "Bob Planka", username: "bob" }] },
    });
  if (card && kind === "actions")
    return ok({
      items: newest(data.planka.actions[card] ?? []),
      included: { users: [] },
    });
  return { status: 404, body: { code: "E_NOT_FOUND", message: "Board not found" } };
};

// Kaneo pages a project's tasks with `page`; each task page has related pages for labels.
const kaneo: Serve = (data, method, url, headers) => {
  if (value(headers, "authorization") !== `Bearer ${fakeCredentials.kaneo}`)
    return { status: 401, body: { message: "Unauthorized", code: "UNAUTHORIZED" } };
  if (method !== "GET") return { status: 405, body: {} };
  const path = url.pathname.replace(/^\/kaneo\/api\//, ""),
    query = url.searchParams;
  if (path === "workspace") return ok(data.kaneo.workspaces);
  if (path === "project")
    return ok(
      data.kaneo.projects.filter((found) => found.workspaceId === query.get("workspaceId")),
    );
  if (path === "workspace/kw-acme/members") return ok(data.kaneo.members);
  if (path === "task/tasks/kp-platform") {
    const pageNumber = Number(query.get("page") ?? 1),
      related = Number(query.get("relatedPage") ?? 1);
    const slice = data.kaneo.tasks.slice((pageNumber - 1) * 2, pageNumber * 2).map((found) => ({
      ...found,
      labels: data.kaneo.labels[found.id]?.[related - 1] ?? [],
      externalLinks: related === 1 ? found.externalLinks : [],
    }));
    const project = data.kaneo.projects[0]!;
    return ok({
      data: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: "Platform work",
        workspaceId: project.workspaceId,
        columns: data.kaneo.columns.map((column) => ({
          ...column,
          tasks: slice.filter((found) => found.status === column.id),
        })),
        archivedTasks: slice.filter((found) => found.status === "archived"),
        plannedTasks: slice.filter((found) => found.status === "planned"),
      },
      pagination: {
        total: data.kaneo.tasks.length,
        page: pageNumber,
        pageSize: 2,
        totalPages: Math.ceil(data.kaneo.tasks.length / 2),
        relatedPage: related,
        relatedTotalPages: 2,
      },
    });
  }
  const [, task] = /^task\/([^/]+)$/.exec(path) ?? [];
  if (task) return ok({ id: task, description: data.kaneo.descriptions[task] ?? "" });
  const [, related] = /^task-relation\/(.+)$/.exec(path) ?? [];
  if (related)
    return ok(
      data.kaneo.relations.filter(
        (found) => found.sourceTaskId === related || found.targetTaskId === related,
      ),
    );
  const [, commented] = /^comment\/(.+)$/.exec(path) ?? [];
  if (commented) return ok(data.kaneo.comments[commented] ?? []);
  if (path === "custom-field/project/kp-platform") return ok(data.kaneo.customFields);
  return { status: 404, body: { message: "Project not found", code: "NOT_FOUND" } };
};

export const sourceFakes: Record<string, Serve> = { trello, plane, planka, kaneo };
