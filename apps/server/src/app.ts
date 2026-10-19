import { createAccountAdministration } from "./account-administration.ts";
import { createDatabase } from "./database.ts";
import { createInstance } from "./instance.ts";
import { createBlobStorage, imageResponse, stagedUploadCutoff } from "./blob-storage.ts";
import { createTicketSearch } from "./search.ts";
import { registerInstanceRoutes } from "./instance-routes.ts";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { applicationVersion } from "./version.ts";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { APIError as AuthAPIError } from "better-auth/api";
import {
  ApiError,
  errorSchema,
  operations,
  isOperation,
  credentialInput,
  notificationIdsInput,
  notificationPreferencesSchema,
  notificationPreferencesInput,
  notificationReadInput,
  pushDeviceInput,
} from "@kanvil/contracts";
import { defaultAdapters, type RuntimeAdapters } from "./runtime-adapters.ts";
import {
  createAccess,
  createWriteLimiter,
  requireSession,
  requireInstanceAdmin,
} from "./access.ts";
import { createDomain, fail, json, requireRow, type Actor, one } from "./domain.ts";
import { createMcp } from "./mcp.ts";
import { deliverySecrets } from "./sealing.ts";
import { sendDueReminders } from "./reminders.ts";
import { deliverBatch } from "./outbox.ts";
import { readCalendarFeed } from "./calendar-operations.ts";
import { apikey } from "./auth-schema.ts";
import {
  projects,
  workspaces,
  workspaceMembers,
  attachmentContent,
  attachments,
  eventClock,
  events,
  notifications,
  notificationPreferences,
  pushDevices,
  stagedUploads,
} from "./schema.ts";
import type { Database } from "./database.ts";
import type { Config } from "./config.ts";
import { Expo } from "expo-server-sdk";

type Variables = { actor: Actor };
const setupInput = z
  .object({
    token: z.string().max(200),
    email: z.email(),
    name: z.string().trim().min(1).max(120),
    password: z.string().min(12).max(128),
  })
  .strict();
const toPreferences = (row?: typeof notificationPreferences.$inferSelect) =>
  notificationPreferencesSchema.parse(
    row
      ? {
          inApp: row.inApp,
          push: row.push,
          categories: row.categories,
          reminderLead: { amount: row.reminderAmount, unit: row.reminderUnit },
        }
      : {},
  );
const digest = (value: string) => createHash("sha256").update(value).digest();

export async function createApplication(
  database: Database,
  config: Config,
  overrides: Partial<RuntimeAdapters> = {},
) {
  const adapters = { ...defaultAdapters, ...overrides };
  // Integration receipts must remain writable while domain transactions wait for the global write lock.
  const integrationDatabase = createDatabase(config.DATABASE_URL);
  const instance = createInstance(integrationDatabase, config);
  await instance.read();
  const blobs = createBlobStorage(
      integrationDatabase,
      instance,
      adapters.objectStore,
      adapters.jobs,
    ),
    search = createTicketSearch(integrationDatabase, instance, adapters.ticketIndex, adapters.jobs);
  const secrets = deliverySecrets(config),
    senders = adapters.senders(config);
  const auth = adapters.auth(database, config),
    domain = createDomain(database, {
      blobs,
      search,
      secrets,
      publicUrl: config.KANVIL_URL,
      mail: senders.mail,
    }),
    access = createAccess(auth, domain, config, database),
    realtime = await adapters.realtime(config, instance, integrationDatabase);
  const unsubscribeJobs = realtime.subscribe(() => {
    void blobs.sync().catch(() => {});
    void search.sync().catch(() => {});
  });
  // Queued deliveries are durable, so a restart resumes where the last worker stopped.
  const outbox = adapters.jobs("outbox", 5000, () =>
    deliverBatch(database, config, senders, secrets),
  );
  const reminders = adapters.jobs("due-reminders", 60_000, () => sendDueReminders(database));
  const accounts = createAccountAdministration(integrationDatabase, auth, config);
  const app = new OpenAPIHono<{ Variables: Variables }>({
    defaultHook: (result) => {
      if (!result.success)
        return Response.json(
          {
            error: {
              code: "validation_error",
              message: "Invalid request",
              details: result.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            },
          },
          { status: 400 },
        );
      return undefined;
    },
  });
  app.use("*", secureHeaders());
  app.use(
    "*",
    bodyLimit({
      maxSize: 15_000_000,
      onError: () =>
        Response.json(
          { error: { code: "payload_too_large", message: "The request exceeds the upload limit" } },
          { status: 413 },
        ),
    }),
  );
  app.onError((error) => {
    if (error instanceof AuthAPIError && error.statusCode >= 400 && error.statusCode < 500)
      return Response.json(
        {
          error: {
            code: typeof error.body?.code === "string" ? error.body.code : "authentication_error",
            message:
              typeof error.body?.message === "string"
                ? error.body.message
                : "Authentication request failed",
          },
        },
        { status: error.statusCode },
      );
    if (error instanceof ApiError) {
      const retry =
        error.status === 429 &&
        error.details &&
        typeof error.details === "object" &&
        "retryAfterSeconds" in error.details
          ? String(error.details.retryAfterSeconds)
          : undefined;
      return Response.json(
        {
          error: {
            status: error.status,
            code: error.code,
            message: error.message,
            details: error.details,
          },
        },
        { status: error.status, headers: retry ? { "Retry-After": retry } : {} },
      );
    }
    if (error instanceof z.ZodError)
      return Response.json(
        {
          error: {
            code: "validation_error",
            message: "Invalid request",
            details: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        },
        { status: 400 },
      );
    if (error instanceof SyntaxError || error instanceof HTTPException)
      return Response.json(
        { error: { code: "invalid_request", message: "The request could not be parsed" } },
        { status: error instanceof HTTPException ? error.status : 400 },
      );
    console.error("Kanvil request failed", { name: error.name });
    return Response.json(
      { error: { code: "internal_error", message: "The request could not be completed" } },
      { status: 500 },
    );
  });
  app.notFound(() =>
    Response.json(
      { error: { code: "not_found", message: "The requested endpoint was not found" } },
      { status: 404 },
    ),
  );
  app.get("/healthz", async () => {
    await database.pool.query("SELECT 1");
    return Response.json({ status: "ok" });
  });
  const setupRequired = async () =>
    (await database.pool.query('SELECT count(*)::int AS count FROM "user"')).rows[0]?.count === 0;
  app.get("/api/v1/info", async () =>
    Response.json({
      ...(await instance.read().then((row) => ({ name: row.name, description: row.description }))),
      version: applicationVersion,
      authentication: await instance.authentication(),
      setupRequired: await setupRequired(),
      push: config.KANVIL_PUSH_ENABLED,
      email: !!config.SMTP_URL,
      oidc: config.OIDC_DISCOVERY_URL ? { id: "oidc", name: config.OIDC_NAME } : null,
    }),
  );
  app.post("/api/v1/setup", async (c) => {
    access.checkOrigin(c.req.raw);
    const input = setupInput.parse(await c.req.json());
    if (
      !config.KANVIL_SETUP_TOKEN ||
      !timingSafeEqual(digest(input.token), digest(config.KANVIL_SETUP_TOKEN))
    )
      fail(403, "invalid_setup_token", "The setup token is invalid");
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7361080)`);
      if (!(await setupRequired()))
        fail(409, "setup_complete", "Initial setup is already complete");
      const created = await auth.api.createUser({
        body: { email: input.email, name: input.name, password: input.password, role: "admin" },
      });
      const workspace = one(
        await tx.select().from(workspaces).where(eq(workspaces.slug, "kanvil")),
      );
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: workspace.id, userId: created.user.id, role: "admin" });
    });
    return Response.json({ ok: true }, { status: 201 });
  });
  // Credential creation is scoped through Kanvil instead of accepting arbitrary plugin metadata.
  app.all("/api/auth/api-key/*", () =>
    Response.json(
      { error: { code: "not_found", message: "Use the Kanvil credentials API" } },
      { status: 404 },
    ),
  );
  app.on(["GET", "POST"], ["/api/auth/*", "/.well-known/*"], (c) => accounts.handleAuth(c.req.raw));
  // Credentials are limited by the auth layer; sessions and MCP OAuth clients get a write budget.
  const writes = createWriteLimiter(config.KANVIL_SESSION_WRITE_LIMIT);
  const mcpHandler = createMcp(auth, domain, access, config, (key) => writes.consume(key));
  app.all("/mcp", (c) => mcpHandler(c.req.raw));
  // Calendar feeds authenticate by their secret path, so calendar apps can subscribe without a
  // session. Unknown, malformed, and revoked tokens all read as not found.
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/api/calendar/{token}.ics",
    request: { params: z.object({ token: z.string() }) },
    responses: {
      200: { description: "iCalendar feed", content: { "text/calendar": { schema: z.string() } } },
      404: { description: "Feed unavailable" },
    },
  });
  app.get("/api/calendar/:file", async (c) => {
    const token = /^(.+)\.ics$/.exec(c.req.param("file"))?.[1],
      body = token ? await readCalendarFeed(database.db, token, config.KANVIL_URL) : null;
    if (body === null) fail(404, "not_found", "This calendar feed does not exist or was revoked");
    return new Response(body, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="kanvil.ics"',
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  });
  app.use("/api/v1/*", async (c, next) => {
    access.checkOrigin(c.req.raw);
    const actor = await access.authenticate(c.req.raw);
    c.set("actor", actor);
    if (!actor.machine && !["GET", "HEAD", "OPTIONS"].includes(c.req.method))
      writes.consume(actor.id);
    await next();
  });

  app.use("/api/v1/admin/*", async (c, next) => {
    requireInstanceAdmin(c.get("actor"));
    await next();
  });
  registerInstanceRoutes(app, database, instance, blobs, search, realtime, auth);
  accounts.register(app);
  // Uploaded project images: the icon and the background behind its ticket views.
  for (const [image, column, description] of [
    ["icon", projects.iconObjectId, "Private project icon"],
    ["background", projects.backgroundObjectId, "Private project background"],
  ] as const) {
    app.openAPIRegistry.registerPath({
      method: "get",
      path: `/api/v1/projects/{projectId}/${image}`,
      security: [{ sessionCookie: [] }],
      request: { params: z.object({ projectId: z.string() }) },
      responses: {
        200: {
          description,
          content: {
            "image/png": { schema: z.string() },
            "image/jpeg": { schema: z.string() },
            "image/webp": { schema: z.string() },
          },
        },
        404: { description: `Project ${image} unavailable` },
      },
    });
    app.get(`/api/v1/projects/:projectId/${image}`, async (c) => {
      const project = await domain.execute(
        "get_project",
        { projectId: c.req.param("projectId") },
        c.get("actor"),
      );
      const row = one(
        await database.db
          .select({ objectId: column })
          .from(projects)
          .where(eq(projects.id, project.id)),
      );
      if (!row.objectId) fail(404, "not_found", `This project has no uploaded ${image}`);
      return imageResponse(await blobs.get(row.objectId));
    });
  }

  app.get("/api/v1/credentials", async (c) => {
    const identity = c.get("actor");
    if (identity.machine) fail(403, "forbidden", "Use a signed-in account to manage credentials");
    const rows = await database.db
      .select({
        id: apikey.id,
        name: apikey.name,
        start: apikey.start,
        enabled: apikey.enabled,
        expiresAt: apikey.expiresAt,
        createdAt: apikey.createdAt,
        permissions: apikey.permissions,
        metadata: apikey.metadata,
      })
      .from(apikey)
      .where(eq(apikey.referenceId, identity.id))
      .orderBy(desc(apikey.createdAt));
    return Response.json(json(rows));
  });
  app.post("/api/v1/credentials", async (c) => {
    const identity = c.get("actor");
    if (identity.machine) fail(403, "forbidden", "Use a signed-in account to manage credentials");
    const input = credentialInput.parse(await c.req.json()),
      allowed = await domain.accessibleProjects(identity);
    if (input.projectIds.some((id) => !allowed.some((row) => row.id === id)))
      fail(403, "forbidden", "Choose projects you can access");
    const key = await auth.api.createApiKey({
      body: {
        userId: identity.id,
        name: input.name,
        prefix: "kv_",
        metadata: { projectIds: input.projectIds },
        permissions: { kanvil: input.scopes },
        expiresIn: input.expiresIn,
        rateLimitEnabled: true,
        rateLimitMax: 600,
        rateLimitTimeWindow: 60_000,
      },
    });
    return Response.json(
      { id: key.id, key: key.key, name: key.name, expiresAt: key.expiresAt },
      { status: 201 },
    );
  });
  app.delete("/api/v1/credentials/:id", async (c) => {
    const identity = c.get("actor");
    if (identity.machine) fail(403, "forbidden", "Use a signed-in account to manage credentials");
    const id = c.req.param("id");
    one(
      await database.db
        .select({ id: apikey.id })
        .from(apikey)
        .where(and(eq(apikey.id, id), eq(apikey.referenceId, identity.id))),
    );
    await auth.api.deleteApiKey({ body: { keyId: id }, headers: c.req.raw.headers });
    return Response.json({ ok: true });
  });
  app.get("/api/v1/snapshot", async (c) =>
    Response.json(
      await domain.snapshot(c.get("actor"), z.string().min(1).parse(c.req.query("projectId"))),
    ),
  );
  app.get("/api/v1/checkpoint", async () => {
    const row = one(await database.db.select().from(eventClock).where(eq(eventClock.id, 1)));
    return Response.json({ cursor: row.value.toString() });
  });
  app.get("/api/v1/projects/:projectId/attachments/:id/content", async (c) => {
    const id = z.uuid().parse(c.req.param("id")),
      projectId = c.req.param("projectId"),
      actor = c.get("actor");
    const attached = (
      await database.db.select().from(attachments).where(eq(attachments.id, id))
    )[0];
    let row: { name: string; contentType: string; size: number }, objectId: string | null;
    if (attached) {
      const authorized = await domain.execute(
        "list_attachments",
        { projectId, ticketId: attached.ticketId },
        actor,
      );
      requireRow(authorized.find((item) => item.id === id));
      row = attached;
      objectId = attached.objectId;
    } else {
      // Before create_ticket claims it, the same address serves a staged upload to its uploader.
      const visible = await domain.execute("get_project", { projectId }, actor);
      row = one(
        await database.db
          .select()
          .from(stagedUploads)
          .where(
            and(
              eq(stagedUploads.id, id),
              eq(stagedUploads.projectId, visible.id),
              eq(stagedUploads.actorId, actor.id),
              gt(stagedUploads.createdAt, stagedUploadCutoff()),
            ),
          ),
      );
      objectId = id;
    }
    const bytes = objectId
      ? (await blobs.get(objectId)).data
      : one(
          await database.db
            .select({ data: attachmentContent.data })
            .from(attachmentContent)
            .where(eq(attachmentContent.id, id)),
        ).data;
    if (bytes.length !== row.size)
      fail(500, "attachment_corrupt", "Attachment integrity check failed");
    return new Response(bytes, {
      headers: {
        "Content-Type": row.contentType,
        "Content-Length": String(row.size),
        "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        "Cache-Control": "no-store",
        "Content-Security-Policy": "sandbox",
      },
    });
  });
  app.get("/api/v1/notifications/preferences", async (c) => {
    const row = (
      await database.db
        .select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, c.get("actor").id))
    )[0];
    return Response.json(toPreferences(row));
  });
  app.put("/api/v1/notifications/preferences", async (c) => {
    const identity = requireSession(c.get("actor"));
    const { categories, reminderLead, ...channels } = notificationPreferencesInput.parse(
      await c.req.json(),
    );
    const values = {
      ...channels,
      ...(reminderLead && { reminderAmount: reminderLead.amount, reminderUnit: reminderLead.unit }),
    };
    const row = one(
      await database.db
        .insert(notificationPreferences)
        .values({ userId: identity.id, ...values, categories: categories ?? {} })
        .onConflictDoUpdate({
          target: notificationPreferences.userId,
          set: {
            ...values,
            ...(categories && {
              categories: sql`${notificationPreferences.categories} || ${JSON.stringify(categories)}::jsonb`,
            }),
          },
        })
        .returning(),
    );
    return Response.json(toPreferences(row));
  });
  app.post("/api/v1/notifications/device", async (c) => {
    const identity = requireSession(c.get("actor"));
    if (!config.KANVIL_PUSH_ENABLED)
      fail(503, "push_disabled", "Push notifications are disabled on this server");
    const input = pushDeviceInput.parse(await c.req.json());
    if (!Expo.isExpoPushToken(input.token))
      fail(400, "invalid_push_token", "Use an Expo push token");
    const current = requireRow(
      (await auth.api.getSession({ headers: c.req.raw.headers }))?.session,
    );
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7361080)`);
      const existing = (
        await tx.select().from(pushDevices).where(eq(pushDevices.token, input.token))
      )[0];
      if (existing?.userId === identity.id && existing.sessionId === current.id) return;
      if (existing) await tx.delete(pushDevices).where(eq(pushDevices.id, existing.id));
      await tx
        .insert(pushDevices)
        .values({ userId: identity.id, sessionId: current.id, token: input.token });
    });
    return Response.json({ ok: true });
  });
  app.delete("/api/v1/notifications/device", async (c) => {
    const identity = requireSession(c.get("actor")),
      input = pushDeviceInput.parse(await c.req.json());
    await database.db
      .delete(pushDevices)
      .where(and(eq(pushDevices.userId, identity.id), eq(pushDevices.token, input.token)));
    return Response.json({ ok: true });
  });
  app.get("/api/v1/notifications", async (c) => {
    const identity = c.get("actor"),
      allowed = await domain.accessibleProjects(identity);
    if (!allowed.length) return Response.json([]);
    return Response.json(
      json(
        await database.db
          .select({
            id: notifications.id,
            readAt: notifications.readAt,
            category: notifications.category,
            createdAt: notifications.createdAt,
            event: events,
          })
          .from(notifications)
          .innerJoin(events, eq(events.id, notifications.eventId))
          .where(
            and(
              eq(notifications.userId, identity.id),
              eq(notifications.inbox, true),
              isNull(notifications.dismissedAt),
              inArray(
                notifications.projectId,
                allowed.map((row) => row.id),
              ),
            ),
          )
          .orderBy(desc(notifications.createdAt))
          .limit(100),
      ),
    );
  });
  // Inbox state is personal: only the account's own sessions change it, never its credentials.
  app.post("/api/v1/notifications/read", async (c) => {
    const identity = requireSession(c.get("actor")),
      input = notificationReadInput.parse(await c.req.json());
    await database.db
      .update(notifications)
      .set({ readAt: input.read ? sql`coalesce(${notifications.readAt}, now())` : null })
      .where(and(eq(notifications.userId, identity.id), inArray(notifications.id, input.ids)));
    return Response.json({ ok: true });
  });
  app.post("/api/v1/notifications/dismiss", async (c) => {
    const identity = requireSession(c.get("actor")),
      input = notificationIdsInput.parse(await c.req.json());
    await database.db
      .update(notifications)
      .set({ dismissedAt: new Date() })
      .where(
        and(
          eq(notifications.userId, identity.id),
          inArray(notifications.id, input.ids),
          isNull(notifications.dismissedAt),
        ),
      );
    return Response.json({ ok: true });
  });
  app.get("/api/v1/events", async (c) => {
    const projectId = c.req.query("projectId");
    const raw = c.req.query("cursor") ?? c.req.header("last-event-id");
    let cursor =
      raw === undefined
        ? one(await database.db.select().from(eventClock).where(eq(eventClock.id, 1))).value
        : BigInt(
            z
              .string()
              .regex(/^\d{1,19}$/)
              .parse(raw),
          );
    await domain.readEvents(c.get("actor"), cursor, projectId);
    c.header("X-Accel-Buffering", "no");
    c.header("Cache-Control", "no-cache, no-transform");
    return streamSSE(c, async (stream) => {
      let active = true,
        busy = false,
        again = false;
      let finish: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const stop = () => {
        if (!active) return;
        active = false;
        clearInterval(heartbeat);
        unsubscribe();
        unsubscribeClose();
        finish();
      };
      const pump = async () => {
        if (!active) return;
        if (busy) {
          again = true;
          return;
        }
        busy = true;
        try {
          do {
            if (!active) break;
            again = false;
            const identity = await access.revalidate(c.req.raw, c.get("actor"));
            const batch = await domain.readEvents(identity, cursor, projectId);
            for (const event of batch.items) {
              if (!active) break;
              await stream.writeSSE({
                event: "change",
                id: event.id.toString(),
                data: JSON.stringify(json(event)),
              });
            }
            cursor = batch.cursor;
            if (active)
              await stream.writeSSE({
                event: "checkpoint",
                id: cursor.toString(),
                data: JSON.stringify({ cursor: cursor.toString() }),
              });
            if (batch.items.length === 200) again = true;
          } while (again);
        } catch (error) {
          if (active && error instanceof ApiError)
            await stream
              .writeSSE({
                event: "error",
                data: JSON.stringify({
                  status: error.status,
                  code: error.code,
                  message: error.message,
                }),
              })
              .catch(() => {});
          stop();
        } finally {
          busy = false;
        }
      };
      const schedule = () => {
        void pump();
      };
      const unsubscribe = realtime.subscribe(schedule),
        unsubscribeClose = realtime.onClose(stop);
      const heartbeat = setInterval(schedule, 15_000);
      stream.onAbort(stop);
      await pump();
      await done;
    });
  });

  for (const name of Object.keys(operations).filter(isOperation)) {
    const spec = operations[name],
      params: Record<string, z.ZodType> = {},
      rest: Record<string, z.ZodType> = {};
    const keys = [...spec.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
    for (const [key, value] of Object.entries(spec.input.shape)) {
      if (keys.includes(key)) params[key] = value;
      else rest[key] = value;
    }
    const method =
      spec.method === "GET"
        ? "get"
        : spec.method === "POST"
          ? "post"
          : spec.method === "PATCH"
            ? "patch"
            : "delete";
    const route = createRoute({
      method,
      path: `/api/v1${spec.path}`,
      operationId: name,
      description: spec.description,
      security: [{ bearerAuth: [] }],
      request: {
        params: z.object(params),
        ...(method === "get"
          ? { query: z.object(rest).strict() }
          : {
              body: {
                content: { "application/json": { schema: z.object(rest).strict() } },
                required: true,
              },
            }),
      },
      responses: {
        200: { description: "Success", content: { "application/json": { schema: spec.output } } },
        400: {
          description: "Invalid input",
          content: { "application/json": { schema: errorSchema } },
        },
        401: { description: "Authentication required" },
        403: { description: "Insufficient permissions" },
        404: { description: "Not found" },
        409: { description: "Version, ownership, or dependency conflict" },
        429: { description: "Too many writes from this session; see Retry-After" },
      },
    });
    app.openapi(route, async (c) => {
      // A repeated query parameter carries a list, such as `status=todo&status=done`.
      const values =
        spec.method === "GET"
          ? Object.fromEntries(
              Object.entries(c.req.queries()).map(([key, list]) => [
                key,
                list.length === 1 ? list[0] : list,
              ]),
            )
          : z.record(z.string(), z.unknown()).parse(await c.req.json());
      return Response.json(
        await domain.execute(name, { ...values, ...c.req.param() }, c.get("actor")),
      );
    });
  }
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "Kanvil API credential. Signed-in browser/mobile sessions are also accepted.",
  });
  app.doc31("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Kanvil API", version: applicationVersion },
    servers: [{ url: config.KANVIL_URL }],
  });
  const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.get("Content-Type")?.startsWith("text/html")) return;
    // Hono retains previous headers when replacing a response, so discard the old body length first.
    c.header("Content-Length", undefined);
    const imageUrl = new URL("/brand/social.png", config.KANVIL_URL).href;
    const html = (await c.res.text()).replaceAll(
      'content="/brand/social.png"',
      `content="${imageUrl}"`,
    );
    c.res = new Response(html, { status: c.res.status, headers: c.res.headers });
  });
  app.on(
    "GET",
    "*",
    serveStatic({
      root: webRoot,
      onFound: (path, c) => {
        c.header(
          "Cache-Control",
          path.endsWith("/index.html")
            ? "no-store"
            : c.req.path.startsWith("/assets/")
              ? "public, max-age=31536000, immutable"
              : "public, max-age=3600",
        );
      },
    }),
  );
  app.get("*", async (c, next) => {
    if (
      c.req.path.startsWith("/api/") ||
      c.req.path.startsWith("/.well-known/") ||
      c.req.path === "/mcp" ||
      c.req.path.includes(".")
    )
      return next();
    c.header("Cache-Control", "no-store");
    return serveStatic({ root: webRoot, path: "index.html" })(c, next);
  });
  return {
    app,
    auth,
    domain,
    instance,
    blobs,
    search,
    realtime,
    close: async () => {
      unsubscribeJobs();
      await realtime.close();
      await search.close();
      await blobs.close();
      await integrationDatabase.pool.end();
      await outbox.close();
      await reminders.close();
    },
  };
}
