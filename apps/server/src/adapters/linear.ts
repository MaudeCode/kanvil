// Reads a Linear team through the GraphQL API. Every request is a query; the reader never sends a
// mutation.
import { z } from "zod";
import type { ImportSourceProject, TicketExport, states } from "@kanvil/contracts";
import {
  bundleBuilder,
  byStatus,
  category,
  dueAt,
  hexOrGray,
  isoTime,
  kindOf,
  readSource,
  readable,
  sourceTicket,
  type Outcome,
  type SourceHttp,
} from "./source-bundle.ts";

const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const linearPerson = z
  .object({ id: z.string(), name: z.string(), email: z.string().nullish() })
  .transform(({ id, name, email }) => ({ ref: id, name, email: email ?? "" }));
const ref = z.object({ id: z.string() }).nullable();
const teams = z.object({
  teams: z.object({
    nodes: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() })),
    pageInfo,
  }),
});
const team = z.object({
  team: z.object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    states: z.object({
      nodes: z.array(
        z.object({ id: z.string(), name: z.string(), type: z.string(), color: z.string() }),
      ),
    }),
  }),
});
const issues = z.object({
  team: z.object({
    issues: z.object({
      nodes: z.array(
        z.object({
          id: z.string(),
          identifier: z.string(),
          title: z.string(),
          description: z.string().nullable(),
          priority: z.number(),
          estimate: z.number().nullable(),
          dueDate: z.string().nullable(),
          createdAt: z.string(),
          archivedAt: z.string().nullable(),
          state: z.object({ id: z.string() }),
          parent: ref,
          cycle: ref,
          projectMilestone: ref,
          project: ref,
          assignee: linearPerson.nullable(),
          creator: linearPerson.nullable(),
          labels: z.object({
            nodes: z.array(z.object({ name: z.string(), color: z.string() })),
            pageInfo: pageInfo.pick({ hasNextPage: true }),
          }),
          relations: z.object({
            nodes: z.array(
              z.object({ type: z.string(), relatedIssue: z.object({ id: z.string() }) }),
            ),
            pageInfo: pageInfo.pick({ hasNextPage: true }),
          }),
        }),
      ),
      pageInfo,
    }),
  }),
});
const comments = z.object({
  comments: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        body: z.string(),
        createdAt: z.string(),
        user: linearPerson.nullable(),
        issue: ref,
      }),
    ),
    pageInfo,
  }),
});
const teamsQuery = `query Teams($after: String) {
  teams(first: 100, after: $after) { nodes { id key name } pageInfo { hasNextPage endCursor } }
}`;
const teamQuery = `query Team($team: String!) {
  team(id: $team) { id key name description states(first: 100) { nodes { id name type color } } }
}`;
const issuesQuery = `query Issues($team: String!, $after: String) {
  team(id: $team) {
    issues(first: 50, after: $after, includeArchived: true, orderBy: createdAt) {
      nodes {
        id identifier title description priority estimate dueDate createdAt archivedAt
        state { id } parent { id } cycle { id } projectMilestone { id } project { id }
        assignee { id name email } creator { id name email }
        labels(first: 50) { nodes { name color } pageInfo { hasNextPage } }
        relations(first: 50) { nodes { type relatedIssue { id } } pageInfo { hasNextPage } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const commentsQuery = `query Comments($team: ID!, $after: String) {
  comments(first: 100, after: $after, includeArchived: true, filter: { issue: { team: { id: { eq: $team } } } }) {
    nodes { id body createdAt user { id name email } issue { id } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const graphErrors = z
  .object({
    errors: z
      .array(
        z.object({
          message: z.string().default(""),
          extensions: z.object({ code: z.string().optional() }).optional(),
        }),
      )
      .optional(),
  })
  .catch({});
// Linear answers rate limits and refused keys with GraphQL error codes, often with status 400.
function judge(status: number, data: unknown): Outcome {
  const errors = graphErrors.parse(data).errors ?? [];
  const codes = errors.map((error) => error.extensions?.code);
  if (codes.includes("RATELIMITED")) return "limited";
  if (codes.includes("AUTHENTICATION_ERROR") || codes.includes("FORBIDDEN")) return "rejected";
  if (errors.some((error) => /not found/i.test(error.message))) return "not_found";
  if (errors.length) return status >= 200 && status < 300 ? "invalid" : byStatus(status);
  return byStatus(status);
}
const linearCategory: Record<string, (typeof states)[number]> = {
  triage: "backlog",
  backlog: "backlog",
  unstarted: "todo",
  started: "in_progress",
  completed: "done",
  canceled: "cancelled",
};
const linearPriority = ["none", "urgent", "high", "medium", "low"] as const;
const linearRelation: Record<string, TicketExport["relations"][number]["type"]> = {
  blocks: "blocks",
  duplicate: "duplicate",
  related: "related",
  similar: "related",
};

// Every page of a connection, in order.
const pages = async <T>(
  read: (after: string | null) => Promise<{ nodes: T[]; pageInfo: z.output<typeof pageInfo> }>,
) => {
  const all: T[] = [];
  for (let after: string | null = null; ;) {
    const page = await read(after);
    all.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) return all;
    after = page.pageInfo.endCursor;
  }
};

export function createLinearReader(http: SourceHttp, url: string) {
  const query = async <T extends z.ZodType>(
    token: string,
    schema: T,
    text: string,
    variables: Record<string, unknown>,
  ): Promise<z.output<T>> => {
    const data = await readSource(
      http,
      "linear",
      {
        method: "POST",
        url,
        headers: { Authorization: token },
        body: JSON.stringify({ query: text, variables }),
      },
      judge,
    );
    return readable(
      "linear",
      schema,
      readable("linear", z.object({ data: z.unknown() }), data).data,
    );
  };
  return {
    async projects(token: string): Promise<ImportSourceProject[]> {
      const found = await pages(
        async (after) => (await query(token, teams, teamsQuery, { after })).teams,
      );
      return found.map((item) => ({ ref: item.id, key: item.key, name: item.name }));
    },
    async bundle(token: string, teamId: string, includeComments: boolean) {
      const source = (await query(token, team, teamQuery, { team: teamId })).team;
      const out = bundleBuilder("linear");
      const workflow = source.states.nodes.map((state) => ({
        ref: state.id,
        name: out.clip(state.name.trim(), 40),
        category: category(state.name, linearCategory[state.type] ?? "todo"),
        color: hexOrGray(state.color),
      }));
      const read = await pages(
        async (after) =>
          (await query(token, issues, issuesQuery, { team: source.id, after })).team.issues,
      );
      for (const issue of read) {
        const labels = out.labels(issue.labels.nodes);
        out.ticket(
          sourceTicket({
            ref: issue.id,
            key: issue.identifier,
            title: out.clip(issue.title.trim(), 500) || issue.identifier,
            description: out.clip(issue.description ?? "", 100_000),
            priority: linearPriority[issue.priority] ?? "none",
            kind: kindOf(labels),
            labels,
            stateRef: issue.state.id,
            assigneeRef: out.person(issue.assignee),
            parentRef: issue.parent?.id ?? null,
            createdByRef: out.person(issue.creator),
            createdAt: isoTime(issue.createdAt),
            dueAt: dueAt(issue.dueDate),
            archived: issue.archivedAt !== null,
          }),
        );
        for (const relation of issue.relations.nodes)
          out.relation({
            sourceRef: issue.id,
            targetRef: relation.relatedIssue.id,
            type: linearRelation[relation.type] ?? "related",
          });
        if (issue.labels.pageInfo.hasNextPage || issue.relations.pageInfo.hasNextPage)
          out.note(
            "labels or relationships past 50",
            "Kanvil reads the first 50 labels and relationships of each Linear issue.",
          );
        if (issue.cycle)
          out.note("cycles", "Kanvil has no cycles; issues keep their state and dates.");
        if (issue.estimate !== null)
          out.note("estimates", "Kanvil has no estimates; difficulty is left unset.");
        if (issue.projectMilestone)
          out.note("milestones", "Kanvil has no milestones; the issues import without them.");
        if (issue.project)
          out.note(
            "Linear projects",
            "Project membership is not carried over; issues import into one project.",
          );
      }
      if (includeComments) {
        const notes = await pages(
          async (after) =>
            (await query(token, comments, commentsQuery, { team: source.id, after })).comments,
        );
        for (const note of notes)
          if (note.issue && note.body.trim())
            out.comment({
              ref: note.id,
              ticketRef: note.issue.id,
              authorRef: out.person(note.user),
              body: out.clip(note.body, 50_000),
              createdAt: isoTime(note.createdAt),
            });
      } else out.note("comments", "Left out when the import was set up.", null);
      out.note("attachments", "Files and linked resources stay in Linear.", null);
      return out.build(
        {
          ref: source.id,
          key: source.key,
          name: source.name,
          description: source.description ?? "",
        },
        workflow,
      );
    },
  };
}
