import { z } from "zod";
import {
  searchSettingsSchema,
  searchAuthentication,
  type SearchSettings,
} from "@kanvil/contracts/instance";
import type { TicketIndex, TicketIndexDocument } from "./ports.ts";
function fail(_status: number, _code: string, message: string): never {
  throw new Error(message);
}
function headers(settings: SearchSettings) {
  return {
    "Content-Type": "application/json",
    ...(searchAuthentication(settings) === "apiKey" && settings.apiKey
      ? { Authorization: `ApiKey ${settings.apiKey}` }
      : searchAuthentication(settings) === "basic" && settings.username && settings.password
        ? {
            Authorization: `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString("base64")}`,
          }
        : {}),
  };
}
async function call(settings: SearchSettings, path: string, init: RequestInit = {}) {
  const requestHeaders = new Headers(headers(settings));
  new Headers(init.headers).forEach((value, name) => requestHeaders.set(name, value));
  return fetch(`${settings.url.replace(/\/$/, "")}/${path}`, {
    ...init,
    headers: requestHeaders,
    signal: AbortSignal.timeout(15000),
  });
}
async function accepted(response: Response) {
  if (!response.ok)
    fail(
      503,
      "search_unavailable",
      "Elasticsearch is unavailable. Check its address, index, and credentials.",
    );
  return response;
}
async function ensure(settings: SearchSettings, identity: string) {
  const mapping = await call(settings, `${settings.index}/_mapping`);
  if (mapping.status === 404) {
    await accepted(
      await call(settings, settings.index, {
        method: "PUT",
        body: JSON.stringify({
          mappings: {
            _meta: { kanvilInstanceId: identity },
            properties: {
              instanceId: { type: "keyword" },
              projectId: { type: "keyword" },
              key: { type: "text" },
              title: { type: "text" },
              description: { type: "text" },
              acceptanceCriteria: { type: "text" },
              labels: { type: "keyword" },
              scopes: { type: "keyword" },
            },
          },
        }),
      }),
    );
    return;
  }
  const result = z
    .record(
      z.string(),
      z.object({
        mappings: z.object({ _meta: z.object({ kanvilInstanceId: z.string() }).optional() }),
      }),
    )
    .parse(await (await accepted(mapping)).json());
  if (result[settings.index]?.mappings["_meta"]?.kanvilInstanceId !== identity)
    fail(409, "index_not_owned", "Choose a dedicated, unused Kanvil index name.");
}
async function bulk(
  settings: SearchSettings,
  identity: string,
  rows: TicketIndexDocument[],
  deleted: string[] = [],
) {
  const lines = rows.flatMap((row) => [
    JSON.stringify({ index: { _id: row.id } }),
    JSON.stringify({
      id: row.id,
      instanceId: identity,
      projectId: row.projectId,
      key: row.key,
      title: row.title,
      description: row.description,
      acceptanceCriteria: row.acceptanceCriteria,
      labels: row.labels,
      scopes: row.scopes,
    }),
  ]);
  for (const id of deleted) lines.push(JSON.stringify({ delete: { _id: id } }));
  if (!lines.length) return;
  const response = await accepted(
    await call(settings, `${settings.index}/_bulk?refresh=wait_for`, {
      method: "POST",
      headers: { "Content-Type": "application/x-ndjson" },
      body: lines.join("\n") + "\n",
    }),
  );
  if (z.object({ errors: z.boolean() }).parse(await response.json()).errors)
    fail(503, "search_unavailable", "Elasticsearch rejected an indexing operation");
}
async function testSearchConnection(settings: SearchSettings, identity: string) {
  const id = crypto.randomUUID(),
    token = crypto.randomUUID();
  try {
    await accepted(
      await call(settings, `${settings.index}/_doc/${id}?refresh=wait_for`, {
        method: "PUT",
        body: JSON.stringify({
          instanceId: identity,
          projectId: crypto.randomUUID(),
          title: token,
        }),
      }),
    );
    const result = z
      .object({ _source: z.object({ title: z.string() }) })
      .parse(await (await accepted(await call(settings, `${settings.index}/_doc/${id}`))).json());
    if (result["_source"].title !== token) throw new Error("Search readback failed");
  } finally {
    await accepted(await call(settings, `${settings.index}/_doc/${id}`, { method: "DELETE" }));
  }
}

export function createElasticsearchIndex(configuration: unknown): TicketIndex {
  const settings = searchSettingsSchema.parse(configuration);
  return {
    initialize: (identity) => ensure(settings, identity),
    async reset(identity) {
      await accepted(
        await call(settings, `${settings.index}/_delete_by_query?refresh=true`, {
          method: "POST",
          body: JSON.stringify({ query: { term: { instanceId: identity } } }),
        }),
      );
    },
    write: (identity, rows, deleted) => bulk(settings, identity, rows, deleted),
    probe: (identity) => testSearchConnection(settings, identity),
    async find(identity, projectId, query) {
      let scrollId: string | undefined;
      try {
        const found: string[] = [];
        let response = await accepted(
          await call(settings, `${settings.index}/_search?scroll=1m`, {
            method: "POST",
            body: JSON.stringify({
              size: 1000,
              _source: false,
              sort: ["_doc"],
              query: {
                bool: {
                  filter: [{ term: { projectId } }, { term: { instanceId: identity } }],
                  must: [
                    {
                      multi_match: {
                        query,
                        fields: [
                          "title^3",
                          "key^3",
                          "description",
                          "acceptanceCriteria",
                          "labels",
                          "scopes",
                        ],
                        operator: "and",
                        fuzziness: "AUTO",
                      },
                    },
                  ],
                },
              },
            }),
          }),
        );
        for (;;) {
          const result = z
            .object({
              _scroll_id: z.string().optional(),
              hits: z.object({ hits: z.array(z.object({ _id: z.uuid() })) }),
            })
            .parse(await response.json());
          scrollId = result["_scroll_id"] ?? scrollId;
          found.push(...result.hits.hits.map((hit) => hit["_id"]));
          if (found.length > 10000) throw new Error("External search unavailable");
          if (!result.hits.hits.length || !scrollId) break;
          response = await accepted(
            await call(settings, "_search/scroll", {
              method: "POST",
              body: JSON.stringify({ scroll: "1m", scroll_id: scrollId }),
            }),
          );
        }
        return found;
      } catch {
        throw new Error("External search unavailable");
      } finally {
        if (scrollId)
          await call(settings, "_search/scroll", {
            method: "DELETE",
            body: JSON.stringify({ scroll_id: [scrollId] }),
          }).catch(() => {});
      }
    },
  };
}
