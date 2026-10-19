// Reads a Kaneo project through the API of a Kaneo instance with an API key. Every request is a
// GET. Kaneo writes descriptions and comments as Markdown.
import { z } from "zod";
import {
  ApiError,
  type ImportSource,
  type ImportSourceProject,
  type TicketExport,
} from "@kanvil/contracts";
import {
  bundleBuilder,
  category,
  dueTime,
  formerMember,
  isoTime,
  kindOf,
  readSource,
  readable,
  sourceTicket,
  startTime,
  type SourceHttp,
} from "./source-bundle.ts";

type Kaneo = Extract<ImportSource, { provider: "kaneo" }>;
const task = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  description: z.string().nullish(),
  // Kaneo leaves out descriptions over 64 KiB from lists.
  descriptionDeferred: z.boolean().optional(),
  // A column slug, or `planned` or `archived`.
  status: z.string(),
  priority: z.string().nullish(),
  startDate: z.string().nullish(),
  dueDate: z.string().nullish(),
  createdAt: z.string(),
  userId: z.string().nullish(),
  assigneeName: z.string().nullish(),
  labels: z.array(z.object({ name: z.string(), color: z.string().nullish() })).default([]),
  externalLinks: z.array(z.unknown()).default([]),
});
type Task = z.output<typeof task>;
const column = z.object({
  id: z.string(),
  name: z.string(),
  isFinal: z.boolean().default(false),
  position: z.number().default(0),
  tasks: z.array(task).default([]),
});
const board = z.object({
  data: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullish(),
    // Kaneo leaves out project descriptions over 64 KiB too.
    descriptionDeferred: z.boolean().optional(),
    workspaceId: z.string(),
    columns: z.array(column).default([]),
    archivedTasks: z.array(task).default([]),
    plannedTasks: z.array(task).default([]),
  }),
  pagination: z.object({
    totalPages: z.number(),
    relatedTotalPages: z.number().default(1),
  }),
});
const relation = z.object({
  id: z.string(),
  sourceTaskId: z.string(),
  targetTaskId: z.string(),
  relationType: z.string(),
});
const comment = z.object({
  id: z.string(),
  userId: z.string().nullish(),
  content: z.string().nullish(),
  createdAt: z.string(),
  user: z.object({ name: z.string().nullish() }).nullish(),
});
const priorities = ["urgent", "high", "medium", "low"] as const;
const priorityOf = (
  value: string | null | undefined,
): TicketExport["tickets"][number]["priority"] =>
  priorities.find((priority) => priority === value) ?? "none";
// Planned tasks have no column; they take a backlog state of their own.
const plannedRef = "kaneo:planned";
// Kaneo's own projects hold at most 100 tasks a page.
const pageSize = 100;

export function createKaneoReader(http: SourceHttp) {
  const get = async <T extends z.ZodType>(
    source: Kaneo,
    schema: T,
    path: string,
    query: Record<string, string | number> = {},
  ): Promise<z.output<T>> => {
    // The API is under `/api` of the address people open, unless they gave it already.
    const base = source.baseUrl.endsWith("/api") ? source.baseUrl : `${source.baseUrl}/api`;
    const url = new URL(`${base}/${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
    const data = await readSource(http, "kaneo", {
      method: "GET",
      url: url.toString(),
      headers: { Accept: "application/json", Authorization: `Bearer ${source.token}` },
      body: "",
    });
    return readable("kaneo", schema, data);
  };
  return {
    async projects(source: Kaneo): Promise<ImportSourceProject[]> {
      const workspaces = await get(
        source,
        z.array(z.object({ id: z.string(), name: z.string() })),
        "workspace",
      );
      const found: ImportSourceProject[] = [];
      for (const workspace of workspaces)
        for (const project of await get(
          source,
          z.array(z.object({ id: z.string(), name: z.string(), slug: z.string() })),
          "project",
          { workspaceId: workspace.id, includeArchived: "true" },
        ))
          found.push({
            ref: project.id,
            key: project.slug.toUpperCase(),
            name: project.name,
            group: workspace.name,
          });
      return found;
    },
    async bundle(source: Kaneo, projectId: string, includeComments: boolean) {
      const out = bundleBuilder("kaneo");
      // Each page of tasks comes with pages of their labels, links, and columns; every related
      // page repeats the tasks, so labels and links are merged per task.
      const tasks = new Map<string, Task>(),
        columns = new Map<string, z.output<typeof column>>();
      let project: z.output<typeof board>["data"] | undefined;
      for (let page = 1, pages = 1; page <= pages; page++)
        for (let related = 1, relatedPages = 1; related <= relatedPages; related++) {
          const found = await get(source, board, `task/tasks/${encodeURIComponent(projectId)}`, {
            page,
            limit: pageSize,
            relatedPage: related,
            sortBy: "number",
            sortOrder: "asc",
          });
          project ??= found.data;
          pages = found.pagination.totalPages;
          relatedPages = found.pagination.relatedTotalPages;
          for (const item of found.data.columns)
            if (!columns.has(item.id)) columns.set(item.id, item);
          for (const item of [
            ...found.data.columns.flatMap((list) => list.tasks),
            ...found.data.archivedTasks,
            ...found.data.plannedTasks,
          ]) {
            const known = tasks.get(item.id);
            if (!known) tasks.set(item.id, item);
            else {
              const names = new Set(known.labels.map((label) => label.name));
              known.labels.push(...item.labels.filter((label) => !names.has(label.name)));
              known.externalLinks.push(...item.externalLinks);
            }
          }
        }
      if (!project) throw new ApiError(404, "not_found", "Kaneo has no such project");
      const lists = [...columns.values()].toSorted((a, b) => a.position - b.position);
      const workflow: TicketExport["workflow"] = lists.map((list) => ({
        ref: list.id,
        name: out.clip(list.name.trim(), 40) || list.id,
        category: category(list.name, list.isFinal ? "done" : "todo"),
        color: "default",
      }));
      if ([...tasks.values()].some((item) => item.status === "planned"))
        workflow.unshift({
          ref: plannedRef,
          name: "Planned",
          category: "backlog",
          color: "default",
        });
      // Archived tasks keep no column; they land in the last final one.
      const archivedRef =
        lists.findLast((list) => list.isFinal)?.id ?? lists.at(-1)?.id ?? plannedRef;
      const people = new Map(
        (
          await get(
            source,
            z.array(
              z.object({ id: z.string(), name: z.string().nullish(), email: z.string().nullish() }),
            ),
            `workspace/${encodeURIComponent(project.workspaceId)}/members`,
          )
        ).map((member) => [
          member.id,
          { ref: member.id, name: member.name || member.id, email: member.email ?? "" },
        ]),
      );
      const person = (id: string | null | undefined, name?: string | null) =>
        id ? (people.get(id) ?? { ...formerMember(id), ...(name ? { name } : {}) }) : null;
      // Subtask relations name the parent; tickets wait for every relation before they are added.
      const linked = new Set<string>(),
        parents = new Map<string, string>(),
        pending: TicketExport["tickets"] = [];
      for (const item of tasks.values()) {
        const key = `${project.slug.toUpperCase()}-${item.number}`;
        const description = item.descriptionDeferred
          ? ((
              await get(
                source,
                z.object({ description: z.string().nullish() }),
                `task/${encodeURIComponent(item.id)}`,
              )
            ).description ?? "")
          : (item.description ?? "");
        const labels = out.labels(item.labels);
        pending.push(
          sourceTicket({
            ref: item.id,
            key,
            title: out.clip(item.title.trim(), 500) || key,
            description: out.clip(description, 100_000),
            priority: priorityOf(item.priority),
            kind: kindOf(labels),
            labels,
            stateRef:
              item.status === "planned"
                ? plannedRef
                : item.status === "archived" || !columns.has(item.status)
                  ? archivedRef
                  : item.status,
            assigneeRef: out.person(person(item.userId, item.assigneeName)),
            parentRef: null,
            createdByRef: null,
            createdAt: isoTime(item.createdAt),
            startAt: startTime(item.startDate),
            dueAt: dueTime(item.dueDate),
            archived: item.status === "archived",
          }),
        );
        if (item.externalLinks.length)
          out.note(
            "external links",
            "Links to pull requests and issues stay in Kaneo.",
            item.externalLinks.length,
          );
        // A relation is listed on both of its tasks; each is kept once.
        for (const link of await get(
          source,
          z.array(relation),
          `task-relation/${encodeURIComponent(item.id)}`,
        )) {
          if (linked.has(link.id)) continue;
          linked.add(link.id);
          if (link.relationType === "subtask") {
            if (parents.has(link.targetTaskId))
              out.note("other parents", "A ticket has one parent; subtasks keep the first.");
            else parents.set(link.targetTaskId, link.sourceTaskId);
          } else
            out.relation({
              sourceRef: link.sourceTaskId,
              targetRef: link.targetTaskId,
              type: link.relationType === "blocks" ? "blocks" : "related",
            });
        }
        if (includeComments)
          for (const note of await get(
            source,
            z.array(comment),
            `comment/${encodeURIComponent(item.id)}`,
          ))
            if (note.content?.trim())
              out.comment({
                ref: note.id,
                ticketRef: item.id,
                authorRef: out.person(person(note.userId, note.user?.name)),
                body: out.clip(note.content, 50_000),
                createdAt: isoTime(note.createdAt),
              });
      }
      for (const ticket of pending)
        out.ticket({ ...ticket, parentRef: parents.get(ticket.ref) ?? null });
      if (!includeComments) out.note("comments", "Left out when the import was set up.", null);
      try {
        const fields = await get(
          source,
          z.array(z.unknown()),
          `custom-field/project/${encodeURIComponent(project.id)}`,
        );
        if (fields.length)
          out.note("custom fields", "Custom fields and their values stay in Kaneo.", fields.length);
      } catch (error) {
        // Kaneo before custom fields.
        if (!(error instanceof ApiError && error.code === "not_found")) throw error;
      }
      out.note("time entries", "Kanvil has no time tracking; logged time stays in Kaneo.", null);
      return out.build(
        {
          ref: project.id,
          key: project.slug.toUpperCase(),
          name: project.name,
          description: project.descriptionDeferred
            ? ((
                await get(
                  source,
                  z.object({ description: z.string().nullish() }),
                  `project/${encodeURIComponent(project.id)}`,
                )
              ).description ?? "")
            : (project.description ?? ""),
        },
        workflow,
      );
    },
  };
}
