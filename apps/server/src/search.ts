import { createPollingJob } from "./adapters/polling-jobs.ts";
import type { JobScheduler } from "./adapters/ports.ts";
import { createTicketIndex } from "./adapters/ticket-indexes.ts";
import type { SearchQuery, TicketIndexFactory } from "./adapters/ports.ts";
import { createHmac } from "node:crypto";
import { and, eq, inArray, sql, ilike, or, type SQL } from "drizzle-orm";
import { searchState, tickets, events, eventClock } from "./schema.ts";
import type { Database, Connection, Transaction } from "./database.ts";
import type { Instance } from "./instance.ts";
import type { SearchSettings } from "@kanvil/contracts/instance";
import { fail, one } from "./domain.ts";

// An ILIKE pattern that matches the query literally anywhere in the text.
export const likePattern = (query: string) =>
  `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
// Each phrase costs a predicate per searchable field, so only this many distinct ones count.
export const phraseLimit = 8;
// Double-quoted segments are exact phrases and the rest is free text; an unpaired quote stays a
// literal character. Repeated phrases count once and phrases past `phraseLimit` are dropped, which
// can only widen the result. A query of only empty quotes searches for itself.
export function parseQuery(query: string): SearchQuery {
  const phrases: string[] = [];
  const terms = query
    .replace(/"([^"]*)"/gu, (_, phrase: string) => {
      const value = phrase.replace(/\s+/gu, " ").trim();
      if (
        value &&
        phrases.length < phraseLimit &&
        !phrases.some((seen) => seen.toLowerCase() === value.toLowerCase())
      )
        phrases.push(value);
      return " ";
    })
    .replace(/\s+/gu, " ")
    .trim();
  return phrases.length || terms ? { phrases, terms } : { phrases, terms: query };
}
// Every phrase and the free text, each of which must match somewhere.
export const querySegments = ({ phrases, terms }: SearchQuery) =>
  terms ? [...phrases, terms] : phrases;
export function postgresSearch(query: string): SQL | undefined {
  return and(
    ...querySegments(parseQuery(query)).map((segment) => {
      const value = likePattern(segment);
      return or(
        ilike(tickets.title, value),
        ilike(tickets.description, value),
        ilike(tickets.key, value),
        ilike(tickets.acceptanceCriteria, value),
        sql`array_to_string(${tickets.labels}, ' ') ILIKE ${value}`,
        sql`array_to_string(${tickets.scopes}, ' ') ILIKE ${value}`,
      );
    }),
  );
}
// Title matches first, then tickets that matched only in other text.
const postgresRank = (query: string) =>
  sql<number>`CASE WHEN ${and(
    ...querySegments(parseQuery(query)).map((segment) =>
      ilike(tickets.title, likePattern(segment)),
    ),
  )} THEN 0 ELSE 1 END`;
// `engine` says what matched: the external index only while it is current. `indexing` is set when
// an index is configured but PostgreSQL answered because the index is behind or unavailable.
// `rank` orders matches by relevance, ascending.
export type TicketMatch = {
  where: SQL | undefined;
  rank: SQL<number>;
  engine: "postgres" | "index";
  indexing: boolean;
};
export type TicketSearchProvider = {
  where: (
    db: Connection | Transaction,
    projectIds: readonly string[],
    query: string,
  ) => Promise<TicketMatch>;
};
export const builtinSearch: TicketSearchProvider = {
  where: async (_db, _ids, query) => ({
    where: postgresSearch(query),
    rank: postgresRank(query),
    engine: "postgres",
    indexing: false,
  }),
};
export function createTicketSearch(
  database: Database,
  instance: Instance,
  factory: TicketIndexFactory = createTicketIndex,
  schedule: JobScheduler = createPollingJob,
) {
  // A keyed fingerprint does not expose an offline verifier for saved integration passwords.
  const fingerprint = (settings: SearchSettings) =>
    createHmac("sha256", instance.config.BETTER_AUTH_SECRET)
      .update(JSON.stringify(settings))
      .digest("hex");
  async function work() {
    const settings = await instance.search();
    if (!settings) return;
    const index = factory({ provider: "elasticsearch", config: settings });
    try {
      await database.db.transaction(
        async (tx) => {
          const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(7361084) AS acquired`);
          if (!lock.rows[0]?.acquired) return;
          const root = await instance.read(tx),
            hash = fingerprint(settings),
            clock = one(await tx.select().from(eventClock).where(eq(eventClock.id, 1)));
          await tx.insert(searchState).values({ id: 1 }).onConflictDoNothing();
          const state = one(await tx.select().from(searchState).where(eq(searchState.id, 1)));
          if (state.configHash === hash && state.cursor === clock.value && !state.error) return;
          await index.initialize(root.identity);
          let cursor = clock.value;
          if (
            state.configHash !== hash ||
            state.cursor < clock.floor ||
            state.cursor > clock.value
          ) {
            await index.reset(root.identity);
            const all = await tx.select().from(tickets);
            for (let offset = 0; offset < all.length; offset += 500)
              await index.write(root.identity, all.slice(offset, offset + 500));
          } else {
            const pending = await tx
              .select()
              .from(events)
              .where(sql`${events.id}>${state.cursor}`)
              .orderBy(events.id)
              .limit(500);
            // A prefix change re-keys its project's tickets under one project event.
            const rekeyed = pending.flatMap((event) =>
              event.type === "project.updated" && "previousKey" in event.data
                ? [event.projectId]
                : [],
            );
            const ids = [
              ...new Set([
                ...pending.flatMap((event) => (event.ticketId ? [event.ticketId] : [])),
                ...(rekeyed.length
                  ? await tx
                      .select({ id: tickets.id })
                      .from(tickets)
                      .where(inArray(tickets.projectId, rekeyed))
                  : []
                ).map((row) => row.id),
              ]),
            ];
            const rows = ids.length
              ? await tx.select().from(tickets).where(inArray(tickets.id, ids))
              : [];
            await index.write(
              root.identity,
              rows,
              ids.filter((id) => !rows.some((row) => row.id === id)),
            );
            cursor = pending.at(-1)?.id ?? clock.value;
          }
          await tx
            .update(searchState)
            .set({ configHash: hash, cursor, error: null })
            .where(eq(searchState.id, 1));
        },
        { isolationLevel: "repeatable read" },
      );
    } catch {
      await database.db
        .insert(searchState)
        .values({
          id: 1,
          error: "External search is unavailable. PostgreSQL search remains active.",
        })
        .onConflictDoUpdate({
          target: searchState.id,
          set: { error: "External search is unavailable. PostgreSQL search remains active." },
        });
    }
  }
  async function where(
    _db: Connection | Transaction,
    projectIds: readonly string[],
    query: string,
  ): Promise<TicketMatch> {
    const settings = await instance.search();
    const fallback = (): TicketMatch => ({
      where: postgresSearch(query),
      rank: postgresRank(query),
      engine: "postgres",
      indexing: !!settings,
    });
    if (!settings) return fallback();
    const state = (await database.db.select().from(searchState).where(eq(searchState.id, 1)))[0],
      clock = (await database.db.select().from(eventClock).where(eq(eventClock.id, 1)))[0];
    if (
      !state ||
      !clock ||
      state.error ||
      state.configHash !== fingerprint(settings) ||
      state.cursor !== clock.value
    )
      return fallback();
    const root = await instance.read();
    try {
      const hits = await factory({ provider: "elasticsearch", config: settings }).find(
        root.identity,
        projectIds,
        parseQuery(query),
      );
      const ids = hits.map((hit) => hit.id),
        ranks = hits.map((hit) => hit.rank);
      return {
        where: ids.length ? inArray(tickets.id, ids) : sql`false`,
        // The index's rank of each ID, as two array parameters rather than one per ID; equally
        // relevant tickets tie so the caller's recency order decides between them.
        rank: sql<number>`(${`{${ranks.join(",")}}`}::int[])[array_position(${`{${ids.join(",")}}`}::uuid[], ${tickets.id})]`,
        engine: "index",
        indexing: false,
      };
    } catch {
      return fallback();
    }
  }
  async function test(settings: SearchSettings) {
    try {
      const index = factory({ provider: "elasticsearch", config: settings });
      const root = await instance.read();
      await index.initialize(root.identity);
      await index.probe(root.identity);
    } catch {
      fail(
        503,
        "search_unavailable",
        "External search is unavailable. Check the address, index permissions, and credentials.",
      );
    }
  }

  async function rebuild() {
    await database.db
      .insert(searchState)
      .values({ id: 1, configHash: "" })
      .onConflictDoUpdate({ target: searchState.id, set: { configHash: "", error: null } });
    void sync().catch(() => {});
  }
  const job = schedule("ticket-index", 1000, work);
  const sync = job.trigger;
  return {
    where,
    sync,
    test,
    rebuild,
    async status() {
      const settings = await instance.search(),
        state = (await database.db.select().from(searchState).where(eq(searchState.id, 1)))[0],
        clock = (await database.db.select().from(eventClock).where(eq(eventClock.id, 1)))[0];
      return {
        status: !settings
          ? "builtin"
          : state?.error
            ? "unavailable"
            : state?.configHash === fingerprint(settings) && state?.cursor === clock?.value
              ? "ready"
              : "indexing",
        cursor: state?.cursor.toString() ?? "0",
        error: state?.error ?? null,
      };
    },
    close: job.close,
  };
}
