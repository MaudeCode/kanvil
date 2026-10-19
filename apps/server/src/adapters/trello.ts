// Reads a Trello board through REST API version 1. Every request is a GET, signed with the key and
// token in the Authorization header so they never appear in a URL.
import { z } from "zod";
import type { ImportSource, ImportSourceProject } from "@kanvil/contracts";
import {
  bundleBuilder,
  formerMember,
  byStatus,
  category,
  isoTime,
  kindOf,
  readSource,
  readable,
  sourceTicket,
  withChecklists,
  type Outcome,
  type SourceHttp,
} from "./source-bundle.ts";

type Trello = Extract<ImportSource, { provider: "trello" }>;
const board = z.object({ id: z.string(), name: z.string(), desc: z.string().default("") });
const list = z.object({ id: z.string(), name: z.string(), closed: z.boolean().default(false) });
const label = z.object({ name: z.string().nullish(), color: z.string().nullish() });
const card = z.object({
  id: z.string(),
  idShort: z.number().optional(),
  name: z.string(),
  desc: z.string().default(""),
  due: z.string().nullish(),
  start: z.string().nullish(),
  dueComplete: z.boolean().default(false),
  idList: z.string(),
  idMembers: z.array(z.string()).default([]),
  labels: z.array(label).default([]),
  closed: z.boolean().default(false),
  badges: z.object({ attachments: z.number().default(0) }).optional(),
});
const checklist = z.object({
  id: z.string(),
  idCard: z.string(),
  name: z.string(),
  pos: z.number().default(0),
  checkItems: z
    .array(z.object({ name: z.string(), state: z.string(), pos: z.number().default(0) }))
    .default([]),
});
const member = z.object({
  id: z.string(),
  fullName: z.string().nullish(),
  username: z.string().default(""),
});
const comment = z.object({
  id: z.string(),
  date: z.string(),
  data: z.object({ text: z.string().default(""), card: z.object({ id: z.string() }).optional() }),
  memberCreator: member.nullish(),
});
// Trello caps a card or action page at 1000 and pages older items with `before`.
const pageLimit = 1000;
const byPosition = (a: { pos: number }, b: { pos: number }) => a.pos - b.pos;
// A Trello ID starts with its creation time in seconds.
const createdAt = (id: string) => new Date(parseInt(id.slice(0, 8), 16) * 1000).toISOString();
const personOf = (who: z.output<typeof member>) => ({
  ref: who.id,
  name: who.fullName || who.username || who.id,
  email: "",
});
// Trello refuses a missing or malformed token with 400 and a plain-text body.
const judge = (status: number, data: unknown): Outcome =>
  status === 400 && data === undefined ? "rejected" : byStatus(status);

// Every item of a capped endpoint: a full page asks again for items older than its oldest.
const all = async <T extends { id: string }>(read: (before: string | null) => Promise<T[]>) => {
  const found = new Map<string, T>();
  for (let before: string | null = null; ;) {
    const page = await read(before);
    const fresh = page.filter((item) => !found.has(item.id));
    for (const item of fresh) found.set(item.id, item);
    if (page.length < pageLimit || !fresh.length) return [...found.values()];
    before = fresh.map((item) => item.id).reduce((a, b) => (a < b ? a : b));
  }
};
const paged = (before: string | null) => ({
  limit: pageLimit,
  ...(before ? { before } : {}),
});
export function createTrelloReader(http: SourceHttp, url: string) {
  const get = async <T extends z.ZodType>(
    source: Trello,
    schema: T,
    path: string,
    query: Record<string, string | number> = {},
  ): Promise<z.output<T>> => {
    const target = new URL(`${url}/1/${path}`);
    for (const [name, value] of Object.entries(query)) target.searchParams.set(name, String(value));
    const data = await readSource(
      http,
      "trello",
      {
        method: "GET",
        url: target.toString(),
        headers: {
          Accept: "application/json",
          Authorization: `OAuth oauth_consumer_key="${source.apiKey}", oauth_token="${source.token}"`,
        },
        body: "",
      },
      judge,
    );
    return readable("trello", schema, data);
  };
  return {
    async projects(source: Trello): Promise<ImportSourceProject[]> {
      const boards = await get(
        source,
        z.array(board.pick({ id: true, name: true })),
        "members/me/boards",
        {
          filter: "all",
          fields: "name",
        },
      );
      return boards.map((item) => ({ ref: item.id, key: "", name: item.name, group: "" }));
    },
    async bundle(source: Trello, boardId: string, includeComments: boolean) {
      const found = await get(source, board, `boards/${encodeURIComponent(boardId)}`, {
        fields: "name,desc",
      });
      const path = `boards/${encodeURIComponent(found.id)}`;
      const out = bundleBuilder("trello");
      const lists = await get(source, z.array(list), `${path}/lists`, {
        filter: "all",
        fields: "name,closed",
      });
      const members = new Map(
        (
          await get(source, z.array(member), `${path}/members`, { fields: "fullName,username" })
        ).map((item) => [item.id, personOf(item)]),
      );
      const cards = await all((before) =>
        get(source, z.array(card), `${path}/cards/all`, {
          fields: "idShort,name,desc,due,start,dueComplete,idList,idMembers,labels,closed,badges",
          ...paged(before),
        }),
      );
      const checklists = new Map<string, z.output<typeof checklist>[]>();
      for (const item of await all((before) =>
        get(source, z.array(checklist), `${path}/checklists`, {
          fields: "idCard,name,pos",
          checkItems: "all",
          checkItem_fields: "name,state,pos",
          ...paged(before),
        }),
      ))
        checklists.set(item.idCard, [...(checklists.get(item.idCard) ?? []), item]);
      // Archived lists stay in the workflow when cards are still in them.
      const used = new Set(cards.map((item) => item.idList));
      const closedLists = new Set(lists.filter((item) => item.closed).map((item) => item.id));
      const workflow = lists
        .filter((item) => !item.closed || used.has(item.id))
        .map((item) => ({
          ref: item.id,
          name: out.clip(item.name.trim(), 40),
          category: category(item.name, "todo"),
          color: "default" as const,
        }));
      for (const item of cards) {
        const labels = out.labels(
          item.labels.map((tag) => ({
            name: tag.name?.trim() || tag.color || "label",
            color: tag.color,
          })),
        );
        const own = (checklists.get(item.id) ?? []).toSorted(byPosition);
        out.ticket(
          sourceTicket({
            ref: item.id,
            key: item.idShort === undefined ? "" : `#${item.idShort}`,
            title: out.clip(item.name.trim(), 500) || "Untitled card",
            description: out.clip(
              withChecklists(
                item.desc,
                own.map((checks) => ({
                  name: checks.name,
                  items: checks.checkItems
                    .toSorted(byPosition)
                    .map((check) => ({ name: check.name, done: check.state === "complete" })),
                })),
              ),
              100_000,
            ),
            priority: "none",
            kind: kindOf(labels),
            labels,
            stateRef: item.idList,
            assigneeRef: out.assignee(
              item.idMembers.map((id) => members.get(id) ?? formerMember(id)),
            ),
            parentRef: null,
            createdByRef: null,
            createdAt: createdAt(item.id),
            startAt: item.start ? isoTime(item.start) : null,
            dueAt: item.due ? isoTime(item.due) : null,
            archived: item.closed || closedLists.has(item.idList),
          }),
        );
        if (item.dueComplete)
          out.note(
            "completed due dates",
            "Kanvil has no due-date checkmark; the cards keep their due date and list.",
          );
        if (item.badges?.attachments)
          out.note("attachments", "Files and links stay in Trello.", item.badges.attachments);
      }
      if (includeComments) {
        const notes = await all((before) =>
          get(source, z.array(comment), `${path}/actions`, {
            filter: "commentCard",
            fields: "data,date",
            memberCreator_fields: "fullName,username",
            ...paged(before),
          }),
        );
        for (const note of notes.toSorted((a, b) => a.date.localeCompare(b.date)))
          if (note.data.card && note.data.text.trim())
            out.comment({
              ref: note.id,
              ticketRef: note.data.card.id,
              authorRef: out.person(note.memberCreator ? personOf(note.memberCreator) : null),
              body: out.clip(note.data.text, 50_000),
              createdAt: isoTime(note.date),
            });
      } else out.note("comments", "Left out when the import was set up.", null);
      const fields = await get(source, z.array(z.unknown()), `${path}/customFields`);
      if (fields.length)
        out.note("custom fields", "Power-Up custom fields stay in Trello.", fields.length);
      return out.build(
        { ref: found.id, key: "", name: found.name, description: found.desc },
        workflow,
      );
    },
  };
}
