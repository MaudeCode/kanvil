import { z } from "zod";
import { scopes } from "@kanvil/contracts";
import { fail, type Actor, type Domain } from "./domain.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Database } from "./database.ts";
import { apikey } from "./auth-schema.ts";
import { eq } from "drizzle-orm";

const credentialPermissions = z.object({ kanvil: z.array(z.enum(scopes)) });
const credentialMetadata = z.object({ projectIds: z.array(z.uuid()).max(1000) });
// ponytail: per-process sliding window; move to PostgreSQL or the broker if Kanvil runs on several instances.
export function createWriteLimiter(max: number, windowMs = 60_000) {
  const recent = new Map<string, number[]>();
  return {
    consume(key: string, now = Date.now()) {
      const hits = (recent.get(key) ?? []).filter((at) => at > now - windowMs);
      if (hits.length >= max) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil(((hits[0] ?? now) + windowMs - now) / 1000),
        );
        fail(429, "rate_limited", "Too many changes in a short time; wait and retry", {
          retryAfterSeconds,
        });
      }
      hits.push(now);
      recent.set(key, hits);
      if (recent.size > 10_000)
        for (const [id, stamps] of recent)
          if (!stamps.some((at) => at > now - windowMs)) recent.delete(id);
    },
    // Returns the latest hit, for work that failed before it counted.
    release(key: string) {
      recent.get(key)?.pop();
    },
  };
}
export function requireSession(actor: Actor) {
  if (actor.machine) fail(403, "session_required", "Use a signed-in account for this action");
  return actor;
}
export function requireInstanceAdmin(actor: Actor) {
  requireSession(actor);
  if (!actor.admin) fail(403, "forbidden", "Instance administrator access is required");
  return actor;
}
function storedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
export function createAccess(auth: Auth, domain: Domain, config: Config, database: Database) {
  async function credentialActor(key: {
    id: string;
    referenceId: string;
    permissions?: unknown;
    metadata?: unknown;
  }) {
    const permissions = credentialPermissions.safeParse(storedJson(key.permissions));
    const metadata = credentialMetadata.safeParse(storedJson(key.metadata));
    if (!permissions.success || !metadata.success)
      fail(403, "invalid_credential_scope", "This credential has no valid project permissions");
    return domain.actor(key.referenceId, {
      ownerId: key.id,
      scopes: permissions.data.kanvil,
      projectIds: metadata.data.projectIds,
    });
  }
  async function authenticate(request: Request): Promise<Actor> {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (token) {
      if (!token.startsWith("kv_")) fail(401, "unauthorized", "Use a Kanvil API credential");
      const result = await auth.api.verifyApiKey({ body: { key: token } });
      if (!result.valid || !result.key)
        fail(401, "unauthorized", "The API credential is invalid or expired");
      return credentialActor(result.key);
    }
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) fail(401, "unauthorized", "Sign in to continue");
    // An impersonated session never counts as the person's own sign-in, so it cannot pass the
    // recent sign-in check that account and workspace deletion require.
    return domain.actor(
      session.user.id,
      undefined,
      session.session.impersonatedBy ? undefined : session.session.createdAt,
    );
  }
  async function revalidate(request: Request, identity: Actor) {
    if (!identity.machine) return authenticate(request);
    const key = (await database.db.select().from(apikey).where(eq(apikey.id, identity.ownerId)))[0];
    if (
      !key?.enabled ||
      key.referenceId !== identity.id ||
      (key.expiresAt && key.expiresAt <= new Date())
    )
      fail(401, "unauthorized", "The API credential is invalid or expired");
    // A stream frame is not a new API request. Keep access current without consuming rate allowance.
    return credentialActor(key);
  }
  function checkOrigin(request: Request) {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const origin = request.headers.get("origin");
    if (origin && !config.trustedOrigins.includes(origin))
      fail(403, "invalid_origin", "This origin is not allowed");
    if (request.headers.get("sec-fetch-site") === "cross-site" && !origin)
      fail(403, "invalid_origin", "Cross-site writes are not allowed");
  }
  return { authenticate, revalidate, checkOrigin };
}
