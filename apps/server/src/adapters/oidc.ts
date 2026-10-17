import { decodeJwt } from "jose";
import { z } from "zod";
import type { OAuth2Tokens } from "better-auth/oauth2";
import type { Config } from "../config.ts";

const identitySchema = z.object({
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.literal(true),
  name: z.string().nullish(),
  picture: z.string().nullish(),
});
const discoverySchema = z.object({
  issuer: z.string(),
  userinfo_endpoint: z.url({ protocol: /^https?$/ }),
});

export function createOIDCUserInfo(config: Config) {
  return async (tokens: OAuth2Tokens) => {
    // Better Auth verifies the ID token before invoking its Generic OAuth getUserInfo callback.
    if (!tokens.idToken) return null;
    const claims = decodeJwt(tokens.idToken);
    let profile = identitySchema.safeParse(claims);
    if (!profile.success) {
      if (!config.OIDC_DISCOVERY_URL || !tokens.accessToken) return null;
      const discovery = await fetch(config.OIDC_DISCOVERY_URL, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!discovery.ok) return null;
      const metadata = discoverySchema.parse(await discovery.json());
      if (metadata.issuer !== claims.iss) return null;
      const response = await fetch(metadata.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      profile = identitySchema.safeParse(await response.json());
    }
    if (!profile.success || profile.data.sub !== claims.sub) return null;
    return {
      ...profile.data,
      id: profile.data.sub,
      emailVerified: true,
      name: profile.data.name ?? "",
      image: profile.data.picture ?? undefined,
    };
  };
}

export function matchesOIDCBinding(
  binding: { accountId: string; idToken: string | null },
  issuer: string | undefined,
  clientId: string | undefined,
) {
  if (!binding.idToken || !issuer || !clientId) return false;
  try {
    // Stored ID tokens were verified on linking/sign-in. Expiry does not erase a binding.
    const claims = decodeJwt(binding.idToken);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return claims.iss === issuer && claims.sub === binding.accountId && audience.includes(clientId);
  } catch {
    return false;
  }
}
