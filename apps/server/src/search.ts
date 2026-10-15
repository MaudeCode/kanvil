import { createPollingJob } from "./adapters/polling-jobs.ts";
import type { JobScheduler } from "./adapters/ports.ts";
import { createTicketIndex } from "./adapters/ticket-indexes.ts";
import type { TicketIndexFactory } from "./adapters/ports.ts";
import { createHmac } from "node:crypto";
import { eq, inArray, sql, ilike, or, type SQL } from "drizzle-orm";
import { searchState, tickets, events, eventClock } from "./schema.ts";
import type { Database, Connection, Transaction } from "./database.ts";
import type { Instance } from "./instance.ts";
import type { SearchSettings } from "@kanvil/contracts/instance";
import { fail, requireRow } from "./domain.ts";

export function postgresSearch(query: string): SQL | undefined {
  const value = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  return or(
    ilike(tickets.title, value),
    ilike(tickets.description, value),
    ilike(tickets.key, value),
    ilike(tickets.acceptanceCriteria, value),
    sql`array_to_string(${tickets.labels}, ' ') ILIKE ${value}`,
    sql`array_to_string(${tickets.scopes}, ' ') ILIKE ${value}`,
  );
}
export type TicketSearchProvider = {
  where: (
    db: Connection | Transaction,
    projectId: string,
    query: string,
  ) => Promise<SQL | undefined>;
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
            clock = requireRow((await tx.select().from(eventClock).where(eq(eventClock.id, 1)))[0]);
          await tx.insert(searchState).values({ id: 1 }).onConflictDoNothing();
          const state = requireRow(
            (await tx.select().from(searchState).where(eq(searchState.id, 1)))[0],
          );
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
            const ids = [
              ...new Set(pending.flatMap((event) => (event.ticketId ? [event.ticketId] : []))),
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
  async function where(_db: Connection | Transaction, projectId: string, query: string) {
    const fallback = () => postgresSearch(query),
      settings = await instance.search();
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
      const ids = await factory({ provider: "elasticsearch", config: settings }).find(
        root.identity,
        projectId,
        query,
      );
      return ids.length ? inArray(tickets.id, ids) : sql`false`;
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
