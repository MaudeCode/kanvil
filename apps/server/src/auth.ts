import { betterAuth } from "better-auth";
import { admin, genericOAuth, jwt } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { apiKey } from "@better-auth/api-key";
import { expo } from "@better-auth/expo";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import * as schema from "./auth-schema.ts";
import type { Database } from "./database.ts";
import type { Config } from "./config.ts";

export function createAuth(database: Database, config: Config) {
  return betterAuth({
    appName: "Kanvil",
    baseURL: config.KANVIL_URL,
    secret: config.BETTER_AUTH_SECRET,
    database: drizzleAdapter(database.db, { provider: "pg", schema }),
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    account: {
      accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: true },
    },
    onAPIError: { errorURL: `${config.KANVIL_URL}/login` },
    telemetry: { enabled: false },
    plugins: [
      admin(),
      apiKey({
        defaultPrefix: "kv_",
        enableMetadata: true,
        maximumNameLength: 100,
        keyExpiration: { minExpiresIn: 1 / 24, maxExpiresIn: 365 },
      }),
      expo(),
      jwt(),
      mcp({
        loginPage: "/login",
        consentPage: "/authorize",
        resource: `${config.KANVIL_URL}/mcp`,
        scopes: [
          "openid",
          "profile",
          "offline_access",
          "kanvil:read",
          "kanvil:write",
          "kanvil:claim",
          "kanvil:admin",
        ],
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
      genericOAuth({
        config:
          config.OIDC_DISCOVERY_URL && config.OIDC_CLIENT_ID && config.OIDC_CLIENT_SECRET
            ? [
                {
                  providerId: "oidc",
                  discoveryUrl: config.OIDC_DISCOVERY_URL,
                  requireIdTokenVerification: true,
                  clientId: config.OIDC_CLIENT_ID,
                  clientSecret: config.OIDC_CLIENT_SECRET,
                  scopes: ["openid", "profile", "email"],
                  pkce: true,
                  disableSignUp: true,
                },
              ]
            : [],
      }),
    ],
  });
}
export type Auth = ReturnType<typeof createAuth>;
