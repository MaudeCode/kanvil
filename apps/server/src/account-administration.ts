import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, asc, count, eq, gt, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { hasAdminRole, okSchema } from "@kanvil/contracts";
import {
  accountQuerySchema,
  accountsSchema,
  accountDetailsSchema,
  localPasswordSchema,
} from "@kanvil/contracts/users";
import { account, session, user } from "./auth-schema.ts";
import { members, projects, workspaces, workspaceMembers } from "./schema.ts";
import { fail, json, type Actor, one } from "./domain.ts";
import type { Auth } from "./auth.ts";
import type { Database } from "./database.ts";
const person = {
  id: user.id,
  name: user.name,
  email: user.email,
  image: user.image,
  role: user.role,
  banned: sql<boolean>`coalesce(${user.banned}, false)`,
  createdAt: user.createdAt,
};
const mutationBody = z
  .object({
    userId: z.string().optional(),
    role: z.union([z.string(), z.array(z.string())]).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
function authPath(request: Request) {
  try {
    return decodeURIComponent(new URL(request.url).pathname)
      .replace(/\/+/g, "/")
      .replace(/\/$/, "");
  } catch {
    return fail(400, "invalid_path", "The authentication path is invalid");
  }
}
export function createAccountAdministration(database: Database, auth: Auth) {
  async function revokeAfterPasswordChange(headers: Headers, userId: string) {
    try {
      await auth.api.revokeUserSessions({ headers, body: { userId } });
    } catch {
      fail(
        503,
        "session_revocation_failed",
        "The password changed, but existing sessions could not be revoked. Revoke this user’s sessions before continuing.",
      );
    }
  }
  async function mutate(request: Request, run: () => Promise<Response>) {
    const login = await auth.api.getSession({ headers: request.headers });
    if (!login) fail(401, "unauthorized", "Sign in to continue");
    if (!hasAdminRole(login.user.role) || login.user.banned)
      fail(403, "forbidden", "Instance administrator access is required");
    // This pool is separate from the auth adapter's pool; waiting guards cannot starve the guarded operation.
    const lock = await database.pool.connect();
    let locked = false;
    try {
      await lock.query("SELECT pg_advisory_lock(7361083)");
      locked = true;
      const path = authPath(request);
      let passwordUserId: string | undefined;
      if (path.endsWith("/admin/set-user-password"))
        passwordUserId = mutationBody.parse(await request.clone().json()).userId;
      if (
        ["set-role", "update-user", "ban-user", "remove-user"].some((name) =>
          path.endsWith(`/admin/${name}`),
        )
      ) {
        const body = mutationBody.parse(await request.clone().json());
        if (body.userId) {
          const current = one(
            (
              await lock.query<{ id: string; role: string | null; banned: boolean }>(
                `SELECT id, role, coalesce(banned,false) AS banned FROM "user" WHERE id = $1`,
                [body.userId],
              )
            ).rows,
          );
          const role = body.role ?? body.data?.role ?? current.role;
          const candidate = z
            .union([z.string(), z.array(z.string())])
            .nullable()
            .safeParse(role);
          const nextRole = candidate.success
            ? Array.isArray(candidate.data)
              ? candidate.data.join(",")
              : candidate.data
            : current.role;
          if (body.data && Object.hasOwn(body.data, "banned")) z.boolean().parse(body.data.banned);
          const banned =
            path.endsWith("/ban-user") ||
            body.data?.banned === true ||
            (body.data?.banned === undefined && current.banned);
          if (
            hasAdminRole(current.role) &&
            !current.banned &&
            (!hasAdminRole(nextRole) || banned || path.endsWith("/remove-user"))
          ) {
            const remaining = await lock.query(
              `SELECT id FROM "user" WHERE id <> $1 AND NOT coalesce(banned,false) AND 'admin' = ANY(string_to_array(role, ',')) LIMIT 1`,
              [current.id],
            );
            if (!remaining.rowCount)
              fail(409, "last_administrator", "Keep at least one active instance administrator");
          }
        }
      }
      const response = await run();
      if (response.ok && passwordUserId)
        await revokeAfterPasswordChange(request.headers, passwordUserId);
      return response;
    } finally {
      try {
        if (locked) await lock.query("SELECT pg_advisory_unlock(7361083)");
      } finally {
        lock.release();
      }
    }
  }
  return {
    handleAuth(request: Request) {
      const path = authPath(request);
      const guarded = [
        "set-role",
        "update-user",
        "ban-user",
        "unban-user",
        "remove-user",
        "set-user-password",
      ].some((name) => path === `/api/auth/admin/${name}`);
      return request.method === "POST" && guarded
        ? mutate(request, () => auth.handler(request))
        : auth.handler(request);
    },
    register(app: OpenAPIHono<{ Variables: { actor: Actor } }>) {
      app.openAPIRegistry.registerPath({
        method: "get",
        path: "/api/v1/admin/users",
        security: [{ sessionCookie: [] }],
        request: { query: accountQuerySchema },
        responses: {
          200: {
            description: "Accounts without credentials or session tokens",
            content: { "application/json": { schema: accountsSchema } },
          },
        },
      });
      app.openAPIRegistry.registerPath({
        method: "get",
        path: "/api/v1/admin/users/{id}",
        security: [{ sessionCookie: [] }],
        request: { params: z.object({ id: z.string() }) },
        responses: {
          200: {
            description: "Account access and sign-in summary",
            content: { "application/json": { schema: accountDetailsSchema } },
          },
        },
      });
      app.openAPIRegistry.registerPath({
        method: "post",
        path: "/api/v1/admin/users/{id}/password",
        security: [{ sessionCookie: [] }],
        request: {
          params: z.object({ id: z.string() }),
          body: {
            required: true,
            content: { "application/json": { schema: localPasswordSchema } },
          },
        },
        responses: {
          200: {
            description: "Local password changed and sessions revoked",
            content: { "application/json": { schema: okSchema } },
          },
        },
      });
      app.get("/api/v1/admin/users", async (c) => {
        const input = accountQuerySchema.parse(c.req.query()),
          needle = `%${input.q.replace(/[\\%_]/g, "\\$&")}%`;
        const administrator = sql`'admin' = ANY(string_to_array(${user.role}, ','))`;
        const filter = and(
          input.q ? or(ilike(user.name, needle), ilike(user.email, needle)) : undefined,
          input.role === "admin"
            ? administrator
            : input.role === "user"
              ? sql`NOT coalesce(${administrator},false)`
              : undefined,
          input.status === "all"
            ? undefined
            : input.status === "disabled"
              ? eq(user.banned, true)
              : sql`NOT coalesce(${user.banned},false)`,
        );
        const [users, total] = await Promise.all([
          database.db
            .select(person)
            .from(user)
            .where(filter)
            .orderBy(asc(user.name), asc(user.id))
            .limit(input.limit)
            .offset(input.offset),
          database.db.select({ value: count() }).from(user).where(filter),
        ]);
        return Response.json(json({ users, total: total[0]?.value ?? 0 }));
      });
      app.get("/api/v1/admin/users/:id", async (c) => {
        const id = c.req.param("id"),
          row = one(await database.db.select(person).from(user).where(eq(user.id, id)));
        const [spaces, direct, providers, sessions] = await Promise.all([
          database.db
            .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
            .from(workspaceMembers)
            .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
            .where(eq(workspaceMembers.userId, id))
            .orderBy(workspaces.name),
          database.db
            .select({ id: projects.id, name: projects.name, role: members.role })
            .from(members)
            .innerJoin(projects, eq(projects.id, members.projectId))
            .where(eq(members.userId, id))
            .orderBy(projects.name),
          database.db
            .select({ provider: account.providerId })
            .from(account)
            .where(eq(account.userId, id)),
          database.db
            .select({ value: count() })
            .from(session)
            .where(and(eq(session.userId, id), gt(session.expiresAt, new Date()))),
        ]);
        return Response.json(
          json({
            ...row,
            workspaces: spaces,
            projects: direct,
            providers: [...new Set(providers.map((provider) => provider.provider))],
            sessionCount: sessions[0]?.value ?? 0,
          }),
        );
      });
      app.post("/api/v1/admin/users/:id/password", async (c) =>
        mutate(c.req.raw, async () => {
          const input = localPasswordSchema.parse(await c.req.json()),
            userId = c.req.param("id");
          await auth.api.setUserPassword({
            headers: c.req.raw.headers,
            body: { userId, newPassword: input.password },
          });
          await revokeAfterPasswordChange(c.req.raw.headers, userId);
          return Response.json({ ok: true });
        }),
      );
    },
  };
}
