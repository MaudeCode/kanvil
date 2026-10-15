import { z } from "zod";
import { scopes } from "@kanvil/contracts";
import { fail, type Actor, type Domain } from "./domain.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";

const credentialPermissions = z.object({ kanvil: z.array(z.enum(scopes)) });
const credentialMetadata = z.object({ projectIds: z.array(z.uuid()).max(1000) });
export function requireSession(actor: Actor) {
  if (actor.machine) fail(403, "session_required", "Use a signed-in account for this action");
  return actor;
}
export function createAccess(auth: Auth, domain: Domain, config: Config) {
  async function authenticate(request: Request): Promise<Actor> {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (token) {
      if (!token.startsWith("kv_")) fail(401, "unauthorized", "Use a Kanvil API credential");
      const result = await auth.api.verifyApiKey({ body: { key: token } });
      if (!result.valid || !result.key)
        fail(401, "unauthorized", "The API credential is invalid or expired");
      const permissions = credentialPermissions.safeParse(result.key.permissions);
      const metadata = credentialMetadata.safeParse(result.key.metadata);
      if (!permissions.success || !metadata.success)
        fail(403, "invalid_credential_scope", "This credential has no valid project permissions");
      return domain.actor(result.key.referenceId, {
        ownerId: result.key.id,
        scopes: permissions.data.kanvil,
        projectIds: metadata.data.projectIds,
      });
    }
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) fail(401, "unauthorized", "Sign in to continue");
    return domain.actor(session.user.id);
  }
  function checkOrigin(request: Request) {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const origin = request.headers.get("origin");
    if (origin && !config.trustedOrigins.includes(origin))
      fail(403, "invalid_origin", "This origin is not allowed");
    if (request.headers.get("sec-fetch-site") === "cross-site" && !origin)
      fail(403, "invalid_origin", "Cross-site writes are not allowed");
  }
  return { authenticate, checkOrigin };
}
