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
export function requireSession(actor: Actor) {
  if (actor.machine) fail(403, "session_required", "Use a signed-in account for this action");
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
    return domain.actor(session.user.id);
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
