// Reads a PLANKA board through its REST API, from PLANKA 1.x and 2.x. Reads are GETs. A password
// sign-in opens one session with `POST /api/access-tokens` and closes it when the read ends; a
// PLANKA 2 API key needs neither.
import { z } from "zod";
import type { ImportSource, ImportSourceProject } from "@kanvil/contracts";
import {
  bundleBuilder,
  byStatus,
  formerMember,
  category,
  isoTime,
  kindOf,
  readSource,
  readable,
  sourceTicket,
  withChecklists,
  type SourceHttp,
} from "./source-bundle.ts";

type Planka = Extract<ImportSource, { provider: "planka" }>;
type Headers = Record<string, string>;
const user = z.object({
  id: z.string(),
  name: z.string().nullish(),
  username: z.string().nullish(),
  // PLANKA 2 shows emails only to administrators and the person themselves.
  email: z.string().nullish(),
});
const card = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  dueDate: z.string().nullish(),
  listId: z.string(),
  prevListId: z.string().nullish(),
  creatorUserId: z.string().nullish(),
  createdAt: z.string(),
  listChangedAt: z.string().nullish(),
  stopwatch: z.unknown().nullish(),
  // PLANKA 2 only.
  commentsTotal: z.number().optional(),
});
// What a board or a list of cards includes with its cards; PLANKA 1 has tasks on cards, PLANKA 2
// in task lists.
const included = z.object({
  users: z.array(user).default([]),
  cards: z.array(card).default([]),
  cardLabels: z.array(z.object({ cardId: z.string(), labelId: z.string() })).default([]),
  cardMemberships: z.array(z.object({ cardId: z.string(), userId: z.string() })).default([]),
  taskLists: z
    .array(
      z.object({
        id: z.string(),
        cardId: z.string(),
        name: z.string().nullish(),
        position: z.number().nullish(),
      }),
    )
    .optional(),
  tasks: z
    .array(
      z.object({
        cardId: z.string().nullish(),
        taskListId: z.string().nullish(),
        name: z.string(),
        isCompleted: z.boolean().default(false),
        position: z.number().nullish(),
      }),
    )
    .default([]),
  attachments: z.array(z.object({ cardId: z.string() })).default([]),
  customFieldValues: z.array(z.object({ cardId: z.string() })).default([]),
});
const board = z.object({
  item: z.object({ id: z.string(), name: z.string() }),
  included: included.extend({
    lists: z
      .array(
        z.object({
          id: z.string(),
          name: z.string().nullish(),
          // PLANKA 2: active, closed, archive, or trash.
          type: z.string().nullish(),
          position: z.number().nullish(),
        }),
      )
      .default([]),
    labels: z
      .array(z.object({ id: z.string(), name: z.string().nullish(), color: z.string().nullish() }))
      .default([]),
  }),
});
const cardPage = z.object({ items: z.array(card), included: included.omit({ cards: true }) });
const notes = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      // PLANKA 1 lists card actions, of which comments are one type.
      type: z.string().optional(),
      text: z.string().optional(),
      data: z.object({ text: z.string().optional() }).nullish(),
      userId: z.string().nullish(),
      createdAt: z.string(),
    }),
  ),
  included: z.object({ users: z.array(user).default([]) }).default({ users: [] }),
});
// PLANKA pages archived cards and comments 50 at a time.
const pageSize = 50;
const byPosition = (
  a: { position?: number | null | undefined },
  b: { position?: number | null | undefined },
) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER);

// Every page of a PLANKA list, 50 at a time, each asked for after the last item of the one before.
// A page with nothing new means PLANKA ignored the cursor: reading stops there instead of asking
// for it again, and `stalled` is told.
async function pages<P extends { items: { id: string }[] }>(
  read: (last: P["items"][number] | undefined) => Promise<P>,
  stalled: () => void,
): Promise<P[]> {
  const found: P[] = [],
    seen = new Set<string>();
  for (let last: P["items"][number] | undefined; ;) {
    const page = await read(last);
    const fresh = page.items.filter((item) => !seen.has(item.id));
    if (!fresh.length && page.items.length) {
      stalled();
      return found;
    }
    for (const item of fresh) seen.add(item.id);
    found.push({ ...page, items: fresh });
    if (page.items.length < pageSize) return found;
    last = page.items.at(-1);
  }
}
// Records by the card they belong to.
function grouped<T extends { cardId: string }>(items: T[]) {
  const map = new Map<string, T[]>();
  for (const entry of items) map.set(entry.cardId, [...(map.get(entry.cardId) ?? []), entry]);
  return map;
}

export function createPlankaReader(http: SourceHttp) {
  const read = async <T extends z.ZodType>(
    source: Planka,
    headers: Headers,
    schema: T,
    path: string,
    query: Record<string, string> = {},
  ): Promise<z.output<T>> => {
    const url = new URL(`${source.baseUrl}/api/${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const data = await readSource(http, "planka", {
      method: "GET",
      url: url.toString(),
      headers: { Accept: "application/json", ...headers },
      body: "",
    });
    return readable("planka", schema, data);
  };
  // Runs a read with the source's credentials. A password signs in first and signs out after,
  // whatever the read's outcome; the session is all a sign-in ever writes.
  const session = async <T>(source: Planka, use: (headers: Headers) => Promise<T>) => {
    if (source.signIn === "api_key") return use({ "X-Api-Key": source.token });
    const { item: token } = readable(
      "planka",
      z.object({ item: z.string() }),
      await readSource(
        http,
        "planka",
        {
          method: "POST",
          url: `${source.baseUrl}/api/access-tokens`,
          headers: { Accept: "application/json" },
          body: JSON.stringify({ emailOrUsername: source.username, password: source.password }),
        },
        byStatus,
        { retry: false },
      ),
    );
    const headers = { Authorization: `Bearer ${token}` };
    try {
      return await use(headers);
    } finally {
      await http({
        method: "DELETE",
        url: `${source.baseUrl}/api/access-tokens/me`,
        headers,
        body: "",
      }).catch(() => undefined);
    }
  };
  return {
    projects: (source: Planka): Promise<ImportSourceProject[]> =>
      session(source, async (headers) => {
        const found = await read(
          source,
          headers,
          z.object({
            items: z.array(z.object({ id: z.string(), name: z.string() })),
            included: z.object({
              boards: z
                .array(
                  z.object({
                    id: z.string(),
                    projectId: z.string(),
                    name: z.string(),
                    position: z.number().nullish(),
                  }),
                )
                .default([]),
            }),
          }),
          "projects",
        );
        return found.items.flatMap((project) =>
          found.included.boards
            .filter((item) => item.projectId === project.id)
            .toSorted(byPosition)
            .map((item) => ({ ref: item.id, key: "", name: item.name, group: project.name })),
        );
      }),
    bundle: (source: Planka, boardId: string, includeComments: boolean) =>
      session(source, async (headers) => {
        const { item, included: contents } = await read(
          source,
          headers,
          board,
          `boards/${encodeURIComponent(boardId)}`,
        );
        const modern = contents.taskLists !== undefined;
        const out = bundleBuilder("planka");
        const lists = [...contents.lists].toSorted(byPosition);
        // PLANKA 2 keeps archived and deleted cards in their own lists, outside the workflow.
        const states = lists.filter(
          (list) => !list.type || ["active", "closed"].includes(list.type),
        );
        const workflow = states.map((list) => ({
          ref: list.id,
          name: out.clip((list.name ?? "").trim(), 40) || "Untitled list",
          category: category(list.name ?? "", list.type === "closed" ? "done" : "todo"),
          color: "default" as const,
        }));
        const merged = { ...contents, cards: [...contents.cards], archived: new Set<string>() };
        for (const archive of lists.filter((list) => list.type === "archive"))
          for (const page of await pages<z.output<typeof cardPage>>(
            (last) =>
              read(
                source,
                headers,
                cardPage,
                `lists/${encodeURIComponent(archive.id)}/cards`,
                last?.listChangedAt
                  ? { "before[listChangedAt]": last.listChangedAt, "before[id]": last.id }
                  : {},
              ),
            () =>
              out.note(
                "archived cards past the first page",
                "PLANKA answered the same page again; the archived cards it did not return are left out.",
                null,
              ),
          )) {
            for (const found of page.items) merged.archived.add(found.id);
            merged.cards.push(...page.items);
            merged.users.push(...page.included.users);
            merged.cardLabels.push(...page.included.cardLabels);
            merged.cardMemberships.push(...page.included.cardMemberships);
            merged.taskLists?.push(...(page.included.taskLists ?? []));
            merged.tasks.push(...page.included.tasks);
            merged.attachments.push(...page.included.attachments);
            merged.customFieldValues.push(...page.included.customFieldValues);
          }
        if (lists.some((list) => list.type === "trash"))
          out.note("deleted cards", "Cards in PLANKA's trash are left out.", null);
        const people = new Map<string, { ref: string; name: string; email: string }>();
        const know = (users: z.output<typeof user>[]) => {
          for (const found of users)
            people.set(found.id, {
              ref: found.id,
              name: found.name || found.username || found.id,
              email: found.email ?? "",
            });
        };
        know(merged.users);
        // Comments come first: their pages name people the board may not.
        const threads = new Map<string, z.output<typeof notes>["items"]>();
        if (includeComments)
          for (const found of merged.cards) {
            if (found.commentsTotal === 0) continue;
            const thread = await pages<z.output<typeof notes>>(
              (last) =>
                read(
                  source,
                  headers,
                  notes,
                  `cards/${encodeURIComponent(found.id)}/${modern ? "comments" : "actions"}`,
                  last ? { beforeId: last.id } : {},
                ),
              () =>
                out.note(
                  "comments past the first page",
                  "PLANKA answered the same page again; older comments are left out.",
                  null,
                ),
            );
            for (const page of thread) know(page.included.users);
            threads.set(
              found.id,
              thread.flatMap((page) => page.items),
            );
          }
        const person = (id: string | null | undefined) =>
          id ? (people.get(id) ?? formerMember(id)) : null;
        const labels = new Map(contents.labels.map((label) => [label.id, label]));
        const cardLabels = grouped(merged.cardLabels),
          memberships = grouped(merged.cardMemberships),
          attachments = grouped(merged.attachments),
          values = grouped(merged.customFieldValues),
          taskLists = grouped(merged.taskLists ?? []);
        const known = new Set(states.map((list) => list.id));
        // An archived card returns to the list it left, or else to the first closed or last list.
        const fallback =
          states.find((list) => list.type === "closed")?.id ?? states.at(-1)?.id ?? "";
        for (const found of merged.cards) {
          const names = out.labels(
            (cardLabels.get(found.id) ?? []).flatMap(({ labelId }) => {
              const label = labels.get(labelId);
              return label
                ? [{ name: label.name?.trim() || label.color || "label", color: label.color }]
                : [];
            }),
          );
          const checklists = modern
            ? (taskLists.get(found.id) ?? []).toSorted(byPosition).map((list) => ({
                name: list.name ?? "Tasks",
                items: merged.tasks.filter((task) => task.taskListId === list.id),
              }))
            : [{ name: "Tasks", items: merged.tasks.filter((task) => task.cardId === found.id) }];
          const archived = merged.archived.has(found.id);
          const stateRef = known.has(found.listId)
            ? found.listId
            : found.prevListId && known.has(found.prevListId)
              ? found.prevListId
              : fallback;
          out.ticket(
            sourceTicket({
              ref: found.id,
              key: out.clip(found.name.trim(), 40),
              title: out.clip(found.name.trim(), 500) || "Untitled card",
              description: out.clip(
                withChecklists(
                  found.description ?? "",
                  checklists.map((list) => ({
                    name: list.name,
                    items: list.items
                      .toSorted(byPosition)
                      .map((task) => ({ name: task.name, done: task.isCompleted })),
                  })),
                ),
                100_000,
              ),
              priority: "none",
              kind: kindOf(names),
              labels: names,
              stateRef,
              assigneeRef: out.assignee(
                (memberships.get(found.id) ?? []).flatMap(({ userId }) => person(userId) ?? []),
              ),
              parentRef: null,
              createdByRef: out.person(person(found.creatorUserId)),
              createdAt: isoTime(found.createdAt),
              dueAt: found.dueDate ? isoTime(found.dueDate) : null,
              archived,
            }),
          );
          const files = attachments.get(found.id)?.length ?? 0;
          if (files) out.note("attachments", "Files and links stay in PLANKA.", files);
          const filled = values.get(found.id)?.length ?? 0;
          if (filled) out.note("custom fields", "Custom field values stay in PLANKA.", filled);
          if (found.stopwatch)
            out.note("stopwatches", "Kanvil has no time tracking; recorded time stays in PLANKA.");
          // Pages run newest first.
          for (const note of (threads.get(found.id) ?? []).toReversed()) {
            const body = (note.text ?? note.data?.text ?? "").trim();
            if ((note.type && note.type !== "commentCard") || !body) continue;
            out.comment({
              ref: note.id,
              ticketRef: found.id,
              authorRef: out.person(person(note.userId)),
              body: out.clip(body, 50_000),
              createdAt: isoTime(note.createdAt),
            });
          }
        }
        if (!includeComments) out.note("comments", "Left out when the import was set up.", null);
        return out.build({ ref: item.id, key: "", name: item.name, description: "" }, workflow);
      }),
  };
}
