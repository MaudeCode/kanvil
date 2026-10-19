// A fake Linear GraphQL API and Jira REST API on loopback, for the import suites. It serves one
// Linear team and one Jira project in small pages, records every request, and can answer the next
// requests with a scripted failure. No real account or token is involved.
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { z } from "zod";

export interface SourceRequest {
  method: string;
  path: string;
  authorization: string;
  body: string;
}
export const sourceOwnerEmail = "owner@example.test";
const ann = { id: "lin-user-ann", name: "Ann Linear", email: sourceOwnerEmail };
const bob = { id: "lin-user-bob", name: "Bob Elsewhere", email: "bob@elsewhere.test" };
const states = [
  { id: "lin-backlog", name: "Backlog", type: "backlog", color: "#bec2c8" },
  { id: "lin-todo", name: "Todo", type: "unstarted", color: "#e2e2e2" },
  { id: "lin-started", name: "In Progress", type: "started", color: "#f2c94c" },
  // Linear calls review a started state; its name maps it onto Kanvil's review category.
  { id: "lin-review", name: "In Review", type: "started", color: "#0f783c" },
  { id: "lin-done", name: "Done", type: "completed", color: "#5e6ad2" },
  { id: "lin-canceled", name: "Canceled", type: "canceled", color: "#95a2b3" },
];
const none = { nodes: [], pageInfo: { hasNextPage: false } };
const issue = (fields: Record<string, unknown>) => ({
  description: null,
  priority: 0,
  estimate: null,
  dueDate: null,
  archivedAt: null,
  parent: null,
  cycle: null,
  projectMilestone: null,
  project: null,
  assignee: null,
  creator: ann,
  labels: none,
  relations: none,
  ...fields,
});
const linearIssues = [
  issue({
    id: "lin-1",
    identifier: "ENG-1",
    title: "Ship the importer",
    description: "Parent **work**",
    priority: 1,
    estimate: 3,
    dueDate: "2026-12-01",
    createdAt: "2026-01-02T03:04:05.000Z",
    state: { id: "lin-review" },
    assignee: ann,
    cycle: { id: "cycle-1" },
    labels: {
      nodes: [
        { name: "Bug", color: "#EB5757" },
        { name: "migration", color: "#4ea7fc" },
      ],
      pageInfo: { hasNextPage: false },
    },
  }),
  issue({
    id: "lin-2",
    identifier: "ENG-2",
    title: "Map nested issues",
    priority: 3,
    createdAt: "2026-01-03T00:00:00.000Z",
    state: { id: "lin-todo" },
    parent: { id: "lin-1" },
    assignee: bob,
    labels: { nodes: [{ name: "migration", color: "#4ea7fc" }], pageInfo: { hasNextPage: false } },
    relations: {
      nodes: [
        { type: "blocks", relatedIssue: { id: "lin-3" } },
        // An issue of another team, which the import leaves out.
        { type: "related", relatedIssue: { id: "lin-elsewhere" } },
      ],
      pageInfo: { hasNextPage: false },
    },
  }),
  issue({
    id: "lin-3",
    identifier: "ENG-3",
    title: "Archive the old tracker",
    priority: 4,
    createdAt: "2026-01-04T00:00:00.000Z",
    archivedAt: "2026-02-01T00:00:00.000Z",
    state: { id: "lin-done" },
    projectMilestone: { id: "milestone-1" },
    project: { id: "project-1" },
  }),
];
const linearComments = [
  {
    id: "lin-c1",
    body: "Started on the mapping",
    createdAt: "2026-01-05T00:00:00.000Z",
    user: bob,
    issue: { id: "lin-1" },
  },
  {
    id: "lin-c2",
    body: "Posted by an integration",
    createdAt: "2026-01-06T00:00:00.000Z",
    user: null,
    issue: { id: "lin-1" },
  },
  {
    id: "lin-c3",
    body: "Blocked until ENG-3",
    createdAt: "2026-01-07T00:00:00.000Z",
    user: ann,
    issue: { id: "lin-2" },
  },
];
const jiraOwner = {
  accountId: "jira-owner",
  displayName: "Owner Jira",
  emailAddress: sourceOwnerEmail,
};
// Jira Cloud hides most emails; this person cannot be matched.
const jiraHidden = { accountId: "jira-hidden", displayName: "Hidden Email" };
const jiraFields = (fields: Record<string, unknown>) => ({
  description: null,
  priority: null,
  labels: [],
  assignee: null,
  reporter: jiraOwner,
  issuelinks: [],
  issuetype: { name: "Task" },
  duedate: null,
  timeoriginalestimate: null,
  fixVersions: [],
  attachment: [],
  ...fields,
});
const jiraComment = (id: string, body: string, author: unknown) => ({
  id,
  body,
  author,
  created: "2026-03-02T10:00:00.000+0000",
});
const jiraIssues = [
  {
    id: "10001",
    key: "OPS-1",
    fields: jiraFields({
      summary: "Database failover drill",
      description: "h2. Steps\n* one",
      priority: { name: "Highest" },
      labels: ["infra"],
      assignee: jiraOwner,
      issuetype: { name: "Bug" },
      status: { id: "3" },
      duedate: "2026-04-30",
      created: "2026-03-01T09:00:00.000+0000",
      issuelinks: [
        // Each link is on both issues; only the outward side is read.
        { type: { name: "Blocks" }, outwardIssue: { id: "10003" } },
      ],
      // The search returns the first comment; the second comes from the comment endpoint.
      comment: { comments: [jiraComment("c1", "First look", jiraHidden)], total: 2, startAt: 0 },
    }),
  },
  {
    id: "10002",
    key: "OPS-2",
    fields: jiraFields({
      summary: "Write the runbook",
      priority: { name: "Low" },
      status: { id: "1" },
      issuetype: { name: "Sub-task" },
      parent: { id: "10001" },
      assignee: jiraHidden,
      created: "2026-03-02T09:00:00.000+0000",
      comment: { comments: [], total: 0, startAt: 0 },
    }),
  },
  {
    id: "10003",
    key: "OPS-3",
    fields: jiraFields({
      summary: "Retire the old cluster",
      status: { id: "4" },
      created: "2026-03-03T09:00:00.000+0000",
      issuelinks: [{ type: { name: "Blocks" }, inwardIssue: { id: "10001" } }],
      timeoriginalestimate: 7200,
      fixVersions: [{ id: "v1" }],
      attachment: [{ id: "a1" }, { id: "a2" }],
      comment: { comments: [], total: 0, startAt: 0 },
    }),
  },
];
const jiraStatuses = [
  {
    name: "Task",
    statuses: [
      { id: "1", name: "To Do", statusCategory: { key: "new" } },
      { id: "2", name: "In Progress", statusCategory: { key: "indeterminate" } },
      { id: "3", name: "In Review", statusCategory: { key: "indeterminate" } },
      { id: "4", name: "Done", statusCategory: { key: "done" } },
    ],
  },
  { name: "Bug", statuses: [{ id: "4", name: "Done", statusCategory: { key: "done" } }] },
];
const jiraProject = { id: "10000", key: "OPS", name: "Operations", description: "Ops work" };
// Two items per page, so every reader pages.
const pageOf = <T>(items: T[], cursor: string | null) => {
  const start = cursor ? Number(cursor) : 0,
    end = start + 2;
  return {
    nodes: items.slice(start, end),
    pageInfo: {
      hasNextPage: end < items.length,
      endCursor: end < items.length ? String(end) : null,
    },
  };
};

export async function startImportSources() {
  const requests: SourceRequest[] = [];
  let failures: { status: number; headers: Record<string, string>; body: string }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8"),
        url = new URL(request.url ?? "/", "http://source.test");
      requests.push({
        method: request.method ?? "",
        path: url.pathname + url.search,
        authorization: header(request.headers, "authorization"),
        body,
      });
      const failure = failures.shift();
      if (failure) return send(response, failure.status, failure.body, failure.headers);
      if (url.pathname === "/linear/graphql") return send(response, 200, linear(body));
      if (url.pathname.startsWith("/jira/")) {
        const found = jira(url);
        return found === undefined
          ? send(response, 404, { errorMessages: ["Not found"] })
          : send(response, 200, found);
      }
      send(response, 404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fake source did not start");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    linearUrl: `${origin}/linear/graphql`,
    jiraUrl: `${origin}/jira`,
    requests,
    // The next `times` requests answer with this status instead.
    fail(times: number, status: number, headers: Record<string, string> = {}, body = "{}") {
      failures = Array.from({ length: times }, () => ({ status, headers, body }));
    },
    reset() {
      requests.length = 0;
      failures = [];
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
const send = (
  response: ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
) => {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(typeof data === "string" ? data : JSON.stringify(data));
};
const header = (headers: IncomingHttpHeaders, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
};

function linear(body: string) {
  const { query, variables } = z
    .object({
      query: z.string(),
      variables: z.record(z.string(), z.string().nullable()).default({}),
    })
    .parse(JSON.parse(body));
  const after = variables.after ?? null;
  if (!query.startsWith("query ")) return { errors: [{ message: "Only queries are served" }] };
  if (query.startsWith("query Teams"))
    return {
      data: {
        teams: pageOf(
          [
            { id: "lin-team", key: "ENG", name: "Engineering" },
            { id: "lin-team-2", key: "DES", name: "Design" },
            { id: "lin-team-3", key: "OPS", name: "Operations" },
          ],
          after,
        ),
      },
    };
  if (variables.team !== "lin-team")
    return {
      data: null,
      errors: [{ message: "Entity not found: Team", extensions: { code: "INPUT_ERROR" } }],
    };
  if (query.startsWith("query Team("))
    return {
      data: {
        team: {
          id: "lin-team",
          key: "ENG",
          name: "Engineering",
          description: "Product engineering",
          states: { nodes: states },
        },
      },
    };
  if (query.startsWith("query Issues"))
    return { data: { team: { issues: pageOf(linearIssues, after) } } };
  if (query.startsWith("query Comments"))
    return { data: { comments: pageOf(linearComments, after) } };
  return { errors: [{ message: "Unknown query" }] };
}

function jira(url: URL): unknown {
  const path = url.pathname.replace(/^\/jira\/rest\/api\/2\//, ""),
    query = url.searchParams;
  if (path === "project") return [jiraProject, { id: "10010", key: "WEB", name: "Website" }];
  if (path === "project/search") {
    const startAt = Number(query.get("startAt") ?? 0),
      all = [
        jiraProject,
        { id: "10010", key: "WEB", name: "Website" },
        { id: "10020", key: "HR", name: "People" },
      ],
      values = all.slice(startAt, startAt + 2);
    return { values, startAt, isLast: startAt + 2 >= all.length };
  }
  if (path === "project/OPS" || path === "project/10000") return jiraProject;
  if (path === "project/10000/statuses") return jiraStatuses;
  const withComments = (query.get("fields") ?? "").split(",").includes("comment");
  const visible = jiraIssues.map((item) => {
    if (withComments) return item;
    return {
      ...item,
      fields: Object.fromEntries(
        Object.entries(item.fields).filter(([name]) => name !== "comment"),
      ),
    };
  });
  if (path === "search/jql") {
    const start = Number(query.get("nextPageToken") ?? 0),
      end = start + 2;
    return {
      issues: visible.slice(start, end),
      ...(end < visible.length ? { nextPageToken: String(end), isLast: false } : { isLast: true }),
    };
  }
  if (path === "search") {
    const startAt = Number(query.get("startAt") ?? 0);
    return { issues: visible.slice(startAt, startAt + 2), startAt, total: visible.length };
  }
  if (path === "issue/10001/comment")
    return {
      comments: [
        jiraComment("c1", "First look", jiraHidden),
        jiraComment("c2", "Drill passed", jiraOwner),
      ].slice(Number(query.get("startAt") ?? 0)),
      total: 2,
      startAt: Number(query.get("startAt") ?? 0),
    };
  return undefined;
}
