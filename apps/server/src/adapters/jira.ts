// Reads a Jira Cloud or Data Center project through REST API version 2, which both editions serve
// and which returns text as strings. Every request is a GET.
import { z } from "zod";
import type { ImportSource, ImportSourceProject, TicketExport, states } from "@kanvil/contracts";
import {
  bundleBuilder,
  category,
  dueAt,
  isoTime,
  kindOf,
  readSource,
  readable,
  sourceTicket,
} from "./source-bundle.ts";
import type { SourceHttp } from "./source-bundle.ts";

type Jira = Extract<ImportSource, { provider: "jira" }>;
const jiraProject = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullish(),
});
const jiraPerson = z
  .object({
    accountId: z.string().optional(),
    key: z.string().optional(),
    name: z.string().optional(),
    displayName: z.string().default(""),
    emailAddress: z.string().default(""),
  })
  .nullish();
const jiraComment = z.object({
  id: z.string(),
  body: z.string().nullish(),
  author: jiraPerson,
  created: z.string(),
});
const commentPage = z.object({
  comments: z.array(jiraComment),
  total: z.number(),
  startAt: z.number().default(0),
});
const jiraIssue = z.object({
  id: z.string(),
  key: z.string(),
  fields: z.object({
    summary: z.string().default(""),
    description: z.string().nullish(),
    priority: z.object({ name: z.string() }).nullish(),
    labels: z.array(z.string()).default([]),
    assignee: jiraPerson,
    reporter: jiraPerson,
    parent: z.object({ id: z.string() }).nullish(),
    issuelinks: z
      .array(
        z.object({
          type: z.object({ name: z.string() }),
          outwardIssue: z.object({ id: z.string() }).optional(),
        }),
      )
      .default([]),
    status: z.object({ id: z.string() }),
    issuetype: z.object({ name: z.string() }).nullish(),
    duedate: z.string().nullish(),
    created: z.string(),
    timeoriginalestimate: z.number().nullish(),
    fixVersions: z.array(z.unknown()).default([]),
    attachment: z.array(z.unknown()).default([]),
    comment: commentPage.optional(),
  }),
});
const statuses = z.array(
  z.object({
    statuses: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        statusCategory: z.object({ key: z.string() }).optional(),
      }),
    ),
  }),
);
const jiraCategory: Record<string, (typeof states)[number]> = {
  new: "todo",
  indeterminate: "in_progress",
  done: "done",
};
const jiraPriority: Record<string, TicketExport["tickets"][number]["priority"]> = {
  highest: "urgent",
  blocker: "urgent",
  critical: "urgent",
  high: "high",
  major: "high",
  medium: "medium",
  low: "low",
  minor: "low",
  lowest: "low",
  trivial: "low",
};
const jiraRelation: Record<string, TicketExport["relations"][number]["type"]> = {
  blocks: "blocks",
  duplicate: "duplicate",
  cloners: "clones",
  "problem/incident": "causes",
};
const pageSize = 50;
const issueFields = [
  "summary",
  "description",
  "priority",
  "labels",
  "assignee",
  "reporter",
  "parent",
  "issuelinks",
  "status",
  "issuetype",
  "duedate",
  "created",
  "timeoriginalestimate",
  "fixVersions",
  "attachment",
];

export function createJiraReader(http: SourceHttp) {
  const get = async <T extends z.ZodType>(
    source: Jira,
    schema: T,
    path: string,
    query: Record<string, string | number> = {},
  ): Promise<z.output<T>> => {
    const url = new URL(`${source.baseUrl}/rest/api/2/${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
    const data = await readSource(http, "jira", {
      method: "GET",
      url: url.toString(),
      headers: {
        Accept: "application/json",
        Authorization:
          source.edition === "cloud"
            ? `Basic ${Buffer.from(`${source.email}:${source.token}`).toString("base64")}`
            : `Bearer ${source.token}`,
      },
      body: "",
    });
    return readable("jira", schema, data);
  };
  // Cloud pages issues with a token; Data Center by offset.
  async function* issuePages(source: Jira, project: string, fields: string[]) {
    const jql = `project = ${JSON.stringify(project)} ORDER BY created ASC`;
    const common = { jql, fields: fields.join(","), maxResults: pageSize };
    if (source.edition === "cloud")
      for (let token: string | undefined; ;) {
        const page = await get(
          source,
          z.object({
            issues: z.array(jiraIssue),
            nextPageToken: z.string().nullish(),
            isLast: z.boolean().optional(),
          }),
          "search/jql",
          { ...common, ...(token ? { nextPageToken: token } : {}) },
        );
        yield page.issues;
        if (page.isLast === true || !page.nextPageToken) return;
        token = page.nextPageToken;
      }
    for (let startAt = 0; ;) {
      const page = await get(
        source,
        z.object({ issues: z.array(jiraIssue), total: z.number() }),
        "search",
        { ...common, startAt },
      );
      yield page.issues;
      startAt += page.issues.length;
      if (!page.issues.length || startAt >= page.total) return;
    }
  }
  return {
    async projects(source: Jira): Promise<ImportSourceProject[]> {
      let found: z.output<typeof jiraProject>[] = [];
      if (source.edition === "data_center")
        found = await get(source, z.array(jiraProject), "project");
      else
        for (let startAt = 0; ;) {
          const page = await get(
            source,
            z.object({ values: z.array(jiraProject), isLast: z.boolean().default(true) }),
            "project/search",
            { startAt, maxResults: pageSize },
          );
          found.push(...page.values);
          startAt += page.values.length;
          if (page.isLast || !page.values.length) break;
        }
      return found.map((item) => ({ ref: item.id, key: item.key, name: item.name, group: "" }));
    },
    async bundle(source: Jira, projectRef: string, includeComments: boolean) {
      const project = await get(source, jiraProject, `project/${encodeURIComponent(projectRef)}`);
      const out = bundleBuilder("jira");
      // Statuses repeat across issue types; each is one workflow state.
      const workflow = new Map<string, TicketExport["workflow"][number]>();
      for (const type of await get(source, statuses, `project/${project.id}/statuses`))
        for (const status of type.statuses)
          workflow.set(status.id, {
            ref: status.id,
            name: out.clip(status.name.trim(), 40),
            category: category(
              status.name,
              jiraCategory[status.statusCategory?.key ?? ""] ?? "todo",
            ),
            color: "default",
          });
      const person = (who: z.output<typeof jiraPerson>) => {
        const ref = who && (who.accountId ?? who.key ?? who.name);
        return out.person(
          who && ref ? { ref, name: who.displayName || ref, email: who.emailAddress } : null,
        );
      };
      const fields = includeComments ? [...issueFields, "comment"] : issueFields;
      for await (const page of issuePages(source, project.key, fields))
        for (const { id, key, fields: issue } of page) {
          const labels = out.labels(issue.labels.map((name) => ({ name })));
          out.ticket(
            sourceTicket({
              ref: id,
              key,
              title: out.clip(issue.summary.trim(), 500) || key,
              description: out.clip(issue.description ?? "", 100_000),
              priority: jiraPriority[issue.priority?.name.toLowerCase() ?? ""] ?? "none",
              kind: kindOf([issue.issuetype?.name ?? "", ...labels]),
              labels,
              stateRef: issue.status.id,
              assigneeRef: person(issue.assignee),
              parentRef: issue.parent?.id ?? null,
              createdByRef: person(issue.reporter),
              createdAt: isoTime(issue.created),
              dueAt: dueAt(issue.duedate),
              archived: false,
            }),
          );
          for (const link of issue.issuelinks)
            if (link.outwardIssue)
              out.relation({
                sourceRef: id,
                targetRef: link.outwardIssue.id,
                type: jiraRelation[link.type.name.toLowerCase()] ?? "related",
              });
          if (issue.timeoriginalestimate != null)
            out.note("estimates", "Kanvil has no estimates; difficulty is left unset.");
          if (issue.fixVersions.length)
            out.note(
              "fix versions",
              "Kanvil has no releases or milestones; the issues import without them.",
            );
          if (issue.attachment.length)
            out.note(
              "attachments",
              "Files stay in Jira; text that links to them keeps its addresses.",
              issue.attachment.length,
            );
          if (!issue.comment) continue;
          const notes = [...issue.comment.comments];
          // The search returns the first comments of an issue; the rest come page by page.
          while (notes.length < issue.comment.total) {
            const more = await get(source, commentPage, `issue/${id}/comment`, {
              startAt: notes.length,
              maxResults: 100,
            });
            if (!more.comments.length) break;
            notes.push(...more.comments);
          }
          for (const note of notes)
            if (note.body?.trim())
              out.comment({
                ref: note.id,
                ticketRef: id,
                authorRef: person(note.author),
                body: out.clip(note.body, 50_000),
                createdAt: isoTime(note.created),
              });
        }
      if (!includeComments) out.note("comments", "Left out when the import was set up.", null);
      out.note(
        "sprints and story points",
        "Jira keeps them in custom fields an import does not read.",
        null,
      );
      out.note(
        "Jira formatting",
        "Descriptions and comments keep Jira's wiki markup as plain text.",
        null,
      );
      if (source.edition === "data_center")
        out.note(
          "epic links",
          "Data Center keeps epic links in a custom field an import does not read; sub-tasks keep their parent.",
          null,
        );
      return out.build(
        {
          ref: project.id,
          key: project.key,
          name: project.name,
          description: project.description ?? "",
        },
        [...workflow.values()],
      );
    },
  };
}
