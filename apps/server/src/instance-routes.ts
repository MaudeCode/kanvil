import { isDeepStrictEqual } from "node:util";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { okSchema } from "@kanvil/contracts";
import { eq, count } from "drizzle-orm";
import {
  adminInstanceSchema,
  photoResultSchema,
  instanceUpdateSchema,
  brokerSettingsSchema,
  s3SettingsSchema,
  searchSettingsSchema,
  photoInputSchema,
} from "@kanvil/contracts/instance";
import { blobObjects, profilePhotos, storageBackends } from "./schema.ts";
import { user } from "./auth-schema.ts";
import { requireSession } from "./access.ts";
import { fail, requireRow, type Actor } from "./domain.ts";
import type { Database } from "./database.ts";
import type { Instance } from "./instance.ts";
import { decodeBlobData, type BlobStorage } from "./blob-storage.ts";
import { brokerEndpoint, type EventDelivery } from "./event-delivery.ts";
import type { createTicketSearch } from "./search.ts";

export function registerInstanceRoutes(
  app: OpenAPIHono<{ Variables: { actor: Actor } }>,
  database: Database,
  instance: Instance,
  blobs: BlobStorage,
  search: ReturnType<typeof createTicketSearch>,
  delivery: EventDelivery,
) {
  app.openAPIRegistry.registerComponent("securitySchemes", "sessionCookie", {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
    description:
      "Signed-in local or OIDC session. Instance administration additionally requires the admin role.",
  });
  const endpoints = [
    { method: "get", path: "/admin/instance", output: adminInstanceSchema },
    { method: "patch", path: "/admin/instance", input: instanceUpdateSchema, output: okSchema },
    { method: "post", path: "/admin/storage/test", input: s3SettingsSchema, output: okSchema },
    { method: "post", path: "/admin/search/test", input: searchSettingsSchema, output: okSchema },
    { method: "post", path: "/admin/broker/test", input: brokerSettingsSchema, output: okSchema },
    { method: "post", path: "/admin/search/reindex", output: okSchema, status: 202 },
    { method: "post", path: "/admin/storage/cleanup", output: z.object({ removed: z.number() }) },
    { method: "post", path: "/profile/photo", input: photoInputSchema, output: photoResultSchema },
    { method: "delete", path: "/profile/photo", output: photoResultSchema },
  ] as const;
  for (const endpoint of endpoints)
    app.openAPIRegistry.registerPath({
      method: endpoint.method,
      path: `/api/v1${endpoint.path}`,
      security: [{ sessionCookie: [] }],
      ...("input" in endpoint
        ? {
            request: {
              body: { content: { "application/json": { schema: endpoint.input } }, required: true },
            },
          }
        : {}),
      responses: {
        ["status" in endpoint ? endpoint.status : 200]: {
          description: "Success",
          content: { "application/json": { schema: endpoint.output } },
        },
        401: { description: "Session required" },
        403: { description: "Administrator access required" },
        409: { description: "Settings version conflict" },
        503: { description: "Integration unavailable" },
      },
    });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/api/v1/users/{id}/photo",
    security: [{ sessionCookie: [] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: "Private profile image",
        content: {
          "image/png": { schema: z.string() },
          "image/jpeg": { schema: z.string() },
          "image/webp": { schema: z.string() },
        },
      },
      401: { description: "Session required" },
      404: { description: "No profile photo" },
    },
  });
  app.use("/api/v1/admin/*", async (c, next) => {
    const actor = requireSession(c.get("actor"));
    if (!actor.admin) fail(403, "forbidden", "Instance administrator access is required");
    await next();
  });
  app.get("/api/v1/admin/instance", async () => {
    const row = await instance.read(),
      active = await instance.storage(),
      backend = active ? await instance.backend(active.id) : null,
      broker = await instance.broker(),
      external = await instance.search(),
      status = await search.status();
    const locations = await database.db
      .select({
        id: storageBackends.id,
        config: storageBackends.config,
        objects: count(blobObjects.id),
      })
      .from(storageBackends)
      .leftJoin(blobObjects, eq(blobObjects.backendId, storageBackends.id))
      .groupBy(storageBackends.id);
    return Response.json({
      id: row.identity,
      version: row.version,
      name: row.name,
      description: row.description,
      storage: {
        provider: backend ? "s3" : "local",
        source: instance.config.KANVIL_STORAGE_PROVIDER ? "deployment" : "admin",
        settings: backend ? { ...backend.settings, secretAccessKey: undefined } : null,
        secretConfigured: !!backend?.settings.secretAccessKey,
        ...(await blobs.status()),
      },
      search: {
        provider: external ? "elasticsearch" : "postgres",
        source: instance.config.KANVIL_SEARCH_PROVIDER ? "deployment" : "admin",
        settings: external ? { ...external, apiKey: undefined, password: undefined } : null,
        secretConfigured: !!(external?.apiKey || external?.password),
        ...status,
      },
      broker: {
        provider: broker ? "rabbitmq" : "postgres",
        source: instance.config.KANVIL_BROKER_PROVIDER ? "deployment" : "admin",
        settings: broker ? { endpoint: brokerEndpoint(broker), exchange: broker.exchange } : null,
        secretConfigured: !!broker?.url,
        ...delivery.status(),
      },
      deployment: {
        url: instance.config.KANVIL_URL,
        version: "0.1.0",
        oidc: instance.config.OIDC_DISCOVERY_URL
          ? {
              name: instance.config.OIDC_NAME,
              discoveryUrl: instance.config.OIDC_DISCOVERY_URL,
              clientId: instance.config.OIDC_CLIENT_ID,
            }
          : null,
        push: instance.config.KANVIL_PUSH_ENABLED,
      },
      locations: await Promise.all(
        locations.map(async (location) => {
          const saved = await instance.backend(location.id);
          return {
            id: location.id,
            bucket: saved.settings.bucket,
            endpoint: saved.settings.endpoint,
            prefix: saved.settings.prefix,
            objects: location.objects,
          };
        }),
      ),
    });
  });
  app.patch("/api/v1/admin/instance", async (c) => {
    const input = instanceUpdateSchema.parse(await c.req.json());
    if ((await instance.read()).version !== input.expectedVersion)
      fail(409, "version_conflict", "Instance settings changed. Reload before saving.");
    if (!instance.config.KANVIL_STORAGE_PROVIDER && input.storage.provider === "s3") {
      const candidate = await instance.resolveS3(input.storage),
        active = await instance.storage();
      if (
        !isDeepStrictEqual(candidate, active ? (await instance.backend(active.id)).settings : null)
      )
        await blobs.test({ provider: "s3", config: candidate });
    }
    if (!instance.config.KANVIL_SEARCH_PROVIDER && input.search.provider === "elasticsearch") {
      const candidate = await instance.resolveSearch(input.search);
      if (!isDeepStrictEqual(candidate, await instance.search())) await search.test(candidate);
    }
    if (!instance.config.KANVIL_BROKER_PROVIDER && input.broker?.provider === "rabbitmq") {
      const candidate = await instance.resolveBroker(input.broker);
      if (!isDeepStrictEqual(candidate, await instance.broker())) await delivery.test(candidate);
    }
    await instance.update(input);
    return Response.json({ ok: true });
  });
  app.post("/api/v1/admin/storage/test", async (c) => {
    const active = instance.config.KANVIL_STORAGE_PROVIDER ? await instance.storage() : null;
    await blobs.test({
      provider: "s3",
      config: active
        ? (await instance.backend(active.id)).settings
        : await instance.resolveS3(s3SettingsSchema.parse(await c.req.json())),
    });
    return Response.json({ ok: true });
  });
  app.post("/api/v1/admin/search/test", async (c) => {
    const active = instance.config.KANVIL_SEARCH_PROVIDER ? await instance.search() : null;
    await search.test(
      active ?? (await instance.resolveSearch(searchSettingsSchema.parse(await c.req.json()))),
    );
    return Response.json({ ok: true });
  });
  app.post("/api/v1/admin/broker/test", async (c) => {
    const active = instance.config.KANVIL_BROKER_PROVIDER ? await instance.broker() : null;
    await delivery.test(
      active ?? (await instance.resolveBroker(brokerSettingsSchema.parse(await c.req.json()))),
    );
    return Response.json({ ok: true });
  });
  app.post("/api/v1/admin/search/reindex", async () => {
    await search.rebuild();
    return Response.json({ ok: true }, { status: 202 });
  });
  app.post("/api/v1/admin/storage/cleanup", async () =>
    Response.json({ removed: await blobs.collect() }),
  );
  app.post("/api/v1/profile/photo", async (c) => {
    const actor = requireSession(c.get("actor")),
      input = photoInputSchema.parse(await c.req.json()),
      bytes = decodeBlobData(input.data, 512000);
    const valid =
      input.contentType === "image/png"
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : input.contentType === "image/jpeg"
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.subarray(0, 4).toString() === "RIFF" &&
            bytes.subarray(8, 12).toString() === "WEBP";
    if (!valid) fail(400, "invalid_photo", "Choose a PNG, JPEG, or WebP photo");
    const id = crypto.randomUUID(),
      image = `/api/v1/users/${actor.id}/photo?v=${id}`;
    await database.db.transaction(async (tx) => {
      await blobs.put(tx, id, bytes, input.contentType);
      await tx
        .insert(profilePhotos)
        .values({ userId: actor.id, objectId: id })
        .onConflictDoUpdate({ target: profilePhotos.userId, set: { objectId: id } });
      await tx.update(user).set({ image, updatedAt: new Date() }).where(eq(user.id, actor.id));
    });
    void blobs.sync().catch(() => {});
    return Response.json({ image });
  });
  app.delete("/api/v1/profile/photo", async (c) => {
    const actor = requireSession(c.get("actor"));
    await database.db.transaction(async (tx) => {
      await tx.delete(profilePhotos).where(eq(profilePhotos.userId, actor.id));
      await tx
        .update(user)
        .set({ image: null, updatedAt: new Date() })
        .where(eq(user.id, actor.id));
    });
    return Response.json({ image: null });
  });
  app.get("/api/v1/users/:id/photo", async (c) => {
    requireSession(c.get("actor"));
    const photo = requireRow(
      (
        await database.db
          .select()
          .from(profilePhotos)
          .where(eq(profilePhotos.userId, c.req.param("id")))
      )[0],
    );
    const blob = await blobs.get(photo.objectId);
    return new Response(new Uint8Array(blob.data), {
      headers: {
        "Content-Type": blob.contentType,
        "Cache-Control": "private, max-age=300",
        ETag: `"${blob.sha256}"`,
      },
    });
  });
}
