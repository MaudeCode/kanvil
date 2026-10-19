// Reads a Plane project through the public REST API (`/api/v1`) of Plane Cloud or a self-hosted
// instance. Every request is a GET. Plane writes rich text as HTML, which becomes Markdown here.
import TurndownService from "turndown";
import { z } from "zod";
import {
  ApiError,
  type ImportSource,
  type ImportSourceProject,
  type TicketExport,
  type states,
} from "@kanvil/contracts";
import {
  bundleBuilder,
  formerMember,
  category,
  dueTime,
  isoTime,
  kindOf,
  readSource,
  readable,
  sourceTicket,
  startTime,
  toneOf,
  type SourceHttp,
} from "./source-bundle.ts";

type Plane = Extract<ImportSource, { provider: "plane" }>;
const perPage = 100;
// A list endpoint: most page with a cursor, a few answer with every item at once.
const listOf = <T extends z.ZodType>(item: T) =>
  z.union([
    z.array(item).transform((results) => ({ results, next_cursor: null, more: false })),
    z
      .object({
        results: z.array(item),
        next_cursor: z.string().nullish(),
        next_page_results: z.boolean().default(false),
      })
      .transform(({ results, next_cursor, next_page_results }) => ({
        results,
        next_cursor,
        more: next_page_results,
      })),
  ]);
const project = z.object({
  id: z.string(),
  identifier: z.string(),
  name: z.string(),
  description: z.string().nullish(),
});
const state = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullish(),
  group: z.string(),
});
const label = z.object({ id: z.string(), name: z.string(), color: z.string().nullish() });
const member = z.object({
  id: z.string(),
  display_name: z.string().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  email: z.string().nullish(),
});
// Plane gives what a work item names as an ID, or embeds it as an object holding one.
const named = z.union([z.string(), z.object({ id: z.string() }).transform(({ id }) => id)]);
const item = z.object({
  id: z.string(),
  sequence_id: z.number(),
  name: z.string(),
  description_html: z.string().nullish(),
  priority: z.string().nullish(),
  state: named.nullish(),
  parent: named.nullish(),
  assignees: z.array(named).default([]),
  labels: z.array(named).default([]),
  start_date: z.string().nullish(),
  target_date: z.string().nullish(),
  created_at: z.string(),
  created_by: named.nullish(),
  estimate_point: named.nullish(),
  cycle_id: z.string().nullish(),
  attachment_count: z.number().default(0),
  link_count: z.number().default(0),
});
const comment = z.object({
  id: z.string(),
  comment_html: z.string().nullish(),
  actor: named.nullish(),
  created_by: named.nullish(),
  created_at: z.string(),
});
const linked = z.array(z.object({ issue_id: z.string() })).default([]);
const relations = z.object({
  blocking: linked,
  duplicate: linked,
  relates_to: linked,
  start_before: linked,
  start_after: linked,
  finish_before: linked,
  finish_after: linked,
});
const planeCategory: Record<string, (typeof states)[number]> = {
  triage: "backlog",
  backlog: "backlog",
  unstarted: "todo",
  started: "in_progress",
  completed: "done",
  cancelled: "cancelled",
};
const priorities = ["urgent", "high", "medium", "low"] as const;
const priorityOf = (
  value: string | null | undefined,
): TicketExport["tickets"][number]["priority"] =>
  priorities.find((priority) => priority === value) ?? "none";
const markdown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
const text = (html: string | null | undefined) => (html ? markdown.turndown(html).trim() : "");
const notFound = (error: unknown) => error instanceof ApiError && error.code === "not_found";

export function createPlaneReader(http: SourceHttp) {
  const get = async <T extends z.ZodType>(
    source: Plane,
    schema: T,
    path: string,
    query: Record<string, string | number> = {},
  ): Promise<z.output<T>> => {
    const url = new URL(
      `${source.baseUrl}/api/v1/workspaces/${encodeURIComponent(source.workspace)}/${path}`,
    );
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
    const data = await readSource(http, "plane", {
      method: "GET",
      url: url.toString(),
      headers: { Accept: "application/json", "X-API-Key": source.token },
      body: "",
    });
    return readable("plane", schema, data);
  };
  // Every page of a list, in order.
  const all = async <T extends z.ZodType>(source: Plane, schema: T, path: string) => {
    const found: z.output<T>[] = [];
    for (let cursor: string | null | undefined = null; ;) {
      const page: {
        results: z.output<T>[];
        next_cursor?: string | null | undefined;
        more: boolean;
      } = await get(source, listOf(schema), path, {
        per_page: perPage,
        ...(cursor ? { cursor } : {}),
      });
      found.push(...page.results);
      if (!page.more || !page.next_cursor || page.next_cursor === cursor) return found;
      cursor = page.next_cursor;
    }
  };
  return {
    async projects(source: Plane): Promise<ImportSourceProject[]> {
      return (await all(source, project, "projects/")).map((found) => ({
        ref: found.id,
        key: found.identifier,
        name: found.name,
        group: "",
      }));
    },
    async bundle(source: Plane, projectId: string, includeComments: boolean) {
      const found = await get(source, project, `projects/${encodeURIComponent(projectId)}/`);
      const path = `projects/${encodeURIComponent(found.id)}`;
      const out = bundleBuilder("plane");
      const workflow = (await all(source, state, `${path}/states/`)).map((entry) => ({
        ref: entry.id,
        name: out.clip(entry.name.trim(), 40),
        category: category(entry.name, planeCategory[entry.group] ?? "todo"),
        color: toneOf(entry.color),
      }));
      const labels = new Map(
        (await all(source, label, `${path}/labels/`)).map((entry) => [entry.id, entry]),
      );
      const people = new Map(
        (await all(source, member, `${path}/members/`)).map((entry) => [
          entry.id,
          {
            ref: entry.id,
            name:
              entry.display_name ||
              [entry.first_name, entry.last_name].filter(Boolean).join(" ") ||
              entry.id,
            email: entry.email ?? "",
          },
        ]),
      );
      const person = (id: string | null | undefined) =>
        id ? (people.get(id) ?? formerMember(id)) : null;
      // Plane 1.1 renamed issues to work items; earlier versions only serve `issues/`.
      let items: z.output<typeof item>[],
        kind: "work-items" | "issues" = "work-items";
      try {
        items = await all(source, item, `${path}/work-items/`);
      } catch (error) {
        if (!notFound(error)) throw error;
        kind = "issues";
        items = await all(source, item, `${path}/issues/`);
      }
      const key = (sequence: number) => `${found.identifier}-${sequence}`;
      // Relations are listed on both work items; each is kept once.
      const related = new Set<string>();
      let readsRelations = kind === "work-items";
      for (const work of items) {
        const names = out.labels(
          work.labels.flatMap((id) => {
            const tag = labels.get(id);
            return tag ? [{ name: tag.name, color: tag.color }] : [];
          }),
        );
        out.ticket(
          sourceTicket({
            ref: work.id,
            key: key(work.sequence_id),
            title: out.clip(work.name.trim(), 500) || key(work.sequence_id),
            description: out.clip(text(work.description_html), 100_000),
            priority: priorityOf(work.priority),
            kind: kindOf(names),
            labels: names,
            stateRef: work.state ?? workflow[0]?.ref ?? "",
            assigneeRef: out.assignee(work.assignees.flatMap((id) => person(id) ?? [])),
            parentRef: work.parent ?? null,
            createdByRef: out.person(person(work.created_by)),
            createdAt: isoTime(work.created_at),
            startAt: startTime(work.start_date),
            dueAt: dueTime(work.target_date),
            archived: false,
          }),
        );
        if (work.estimate_point)
          out.note("estimates", "Kanvil has no estimates; difficulty is left unset.");
        if (work.cycle_id)
          out.note("cycles", "Kanvil has no cycles; work items keep their state and dates.");
        if (work.attachment_count)
          out.note("attachments", "Files stay in Plane.", work.attachment_count);
        if (work.link_count) out.note("links", "Work item links stay in Plane.", work.link_count);
        if (readsRelations)
          try {
            const links = await get(
              source,
              relations,
              `${path}/work-items/${encodeURIComponent(work.id)}/relations/`,
            );
            const add = (
              type: "blocks" | "duplicate" | "related",
              target: string,
              mutual: boolean,
            ) => {
              const pair = mutual ? [work.id, target].toSorted().join(":") : `${work.id}:${target}`;
              if (related.has(`${type}:${pair}`)) return;
              related.add(`${type}:${pair}`);
              out.relation({ sourceRef: work.id, targetRef: target, type });
            };
            for (const other of links.blocking) add("blocks", other.issue_id, false);
            for (const other of links.duplicate) add("duplicate", other.issue_id, true);
            for (const other of links.relates_to) add("related", other.issue_id, true);
            const dated =
              links.start_before.length +
              links.start_after.length +
              links.finish_before.length +
              links.finish_after.length;
            if (dated)
              out.note(
                "date dependencies",
                "Kanvil has no start or finish dependencies; the work items keep their dates.",
                dated,
              );
          } catch (error) {
            // Plane serves relations from version 1.3.
            if (!notFound(error)) throw error;
            readsRelations = false;
          }
        if (includeComments)
          for (const note of (
            await all(source, comment, `${path}/${kind}/${encodeURIComponent(work.id)}/comments/`)
          ).toSorted((a, b) => a.created_at.localeCompare(b.created_at))) {
            const body = text(note.comment_html);
            if (body)
              out.comment({
                ref: note.id,
                ticketRef: work.id,
                authorRef: out.person(person(note.actor ?? note.created_by)),
                body: out.clip(body, 50_000),
                createdAt: isoTime(note.created_at),
              });
          }
      }
      if (!readsRelations)
        out.note("relations", "This Plane version does not list relations through its API.", null);
      if (!includeComments) out.note("comments", "Left out when the import was set up.", null);
      out.note(
        "archived, draft, and intake work items",
        "Plane's API does not list them; restore or publish them in Plane first.",
        null,
      );
      try {
        const modules = await get(
          source,
          z.object({ total_count: z.number().default(0) }).catch({ total_count: 0 }),
          `${path}/modules/`,
          { per_page: 1 },
        );
        if (modules.total_count)
          out.note(
            "modules",
            "Kanvil has no modules; the work items import without them.",
            modules.total_count,
          );
      } catch (error) {
        if (!notFound(error)) throw error;
      }
      return out.build(
        {
          ref: found.id,
          key: found.identifier,
          name: found.name,
          description: found.description ?? "",
        },
        workflow,
      );
    },
  };
}
