import { createOIDCUserInfo } from "./adapters/oidc.ts";
import { createMailSender } from "./adapters/outbound.ts";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { createInstance } from "./instance.ts";
import { createWriteLimiter } from "./access.ts";
import { betterAuth } from "better-auth";
import { admin, genericOAuth, jwt } from "better-auth/plugins";
import { emailOTP } from "better-auth/plugins/email-otp";
import { verifyGoogleIdToken } from "better-auth/social-providers";
import type { OAuth2Tokens } from "better-auth/oauth2";
import { z } from "zod";
import { signInMethodLabels } from "@kanvil/contracts";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { apiKey } from "@better-auth/api-key";
import { expo } from "@better-auth/expo";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import * as schema from "./auth-schema.ts";
import type { Database } from "./database.ts";
import type { Config } from "./config.ts";

// Built-in OAuth apps in display order, after the deployment's own OIDC provider.
const socialIds = ["github", "google", "discord"] as const;
const socialCredentials = (config: Config) =>
  ({
    github: [config.GITHUB_CLIENT_ID, config.GITHUB_CLIENT_SECRET],
    google: [config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET],
    discord: [config.DISCORD_CLIENT_ID, config.DISCORD_CLIENT_SECRET],
  }) as const;
// The sign-in providers this deployment configured, as clients list them on login and in settings.
export function signInProviders(config: Config) {
  const credentials = socialCredentials(config);
  return [
    ...(config.OIDC_DISCOVERY_URL ? [{ id: "oidc", name: config.OIDC_NAME }] : []),
    ...socialIds
      .filter((id) => credentials[id][0] && credentials[id][1])
      .map((id) => ({ id, name: signInMethodLabels[id] ?? id })),
  ];
}
// Email codes need the SMTP relay and stay off while an administrator requires an identity provider.
export const emailCodesAvailable = (config: Config, policy: { emailPasswordEnabled: boolean }) =>
  !!config.SMTP_URL && !!config.SMTP_FROM && policy.emailPasswordEnabled;
// Email-code endpoints Kanvil uses; the plugin's other email-code endpoints stay closed.
const emailCodePaths = new Set([
  "/email-otp/send-verification-otp",
  "/sign-in/email-otp",
  "/email-otp/request-password-reset",
  "/email-otp/reset-password",
]);
const codeMinutes = 10;
const googleProfileSchema = z.object({
  sub: z.string().min(1),
  aud: z.string(),
  azp: z.string().default(""),
  iss: z.string(),
  iat: z.number(),
  exp: z.number(),
  email: z.email(),
  email_verified: z.boolean(),
  name: z.string().default(""),
  given_name: z.string().default(""),
  family_name: z.string().default(""),
  picture: z.string().default(""),
});

export function createAuth(database: Database, config: Config) {
  const instance = createInstance(database, config);
  const credentials = socialCredentials(config);
  const mail =
    config.SMTP_URL && config.SMTP_FROM
      ? createMailSender(config.SMTP_URL, config.SMTP_FROM)
      : undefined;
  // ponytail: per-process memory; a multi-replica deployment shares Better Auth's per-IP limit only.
  const codeSends = createWriteLimiter(3, 15 * 60_000);
  // Runs after the response, so neither the lookup nor SMTP latency tells a caller whether the
  // address has an account. Disabled and deleted accounts get nothing. A failed send gives its
  // throttle slot back; the code it carried is the one already mailed, if any, so that one stays.
  async function sendCode(email: string, otp: string, type: string, page: string) {
    if (!mail || (type !== "sign-in" && type !== "forget-password")) return;
    const active = await database.pool.query(
      `SELECT 1 FROM "user" WHERE email = $1 AND deleted_at IS NULL
        AND NOT (coalesce(banned, false) AND (ban_expires IS NULL OR ban_expires > now()))`,
      [email],
    );
    if (!active.rowCount) return;
    const link = new URL(page, config.KANVIL_URL);
    link.search = new URLSearchParams({
      email,
      code: otp,
      ...(type === "forget-password" ? { reset: "1" } : {}),
    }).toString();
    const reset = type === "forget-password";
    await mail({
      to: email,
      subject: reset ? "Reset your Kanvil password" : "Your Kanvil sign-in code",
      text: `${reset ? "Your password reset code" : "Your sign-in code"} is ${otp}. It works once and expires in ${codeMinutes} minutes.\n\nOr open this link to ${reset ? "choose a new password" : "sign in"}:\n\n${link.href}\n\nIf you did not ask for this, ignore this email.`,
    }).catch((error: unknown) => {
      codeSends.release(email);
      throw error;
    });
  }
  const social = (id: (typeof socialIds)[number]) => {
    const [clientId, clientSecret] = credentials[id];
    return {
      enabled: !!clientId && !!clientSecret,
      clientId: clientId ?? "",
      clientSecret: clientSecret ?? "",
      // Only accounts that linked the provider sign in; it never creates or claims an account.
      disableSignUp: true,
      // Every sign-in runs the redirect flow with state and PKCE; posted ID tokens are refused.
      disableIdTokenSignIn: true,
    };
  };
  return betterAuth({
    appName: "Kanvil",
    baseURL: config.KANVIL_URL,
    secret: config.BETTER_AUTH_SECRET,
    database: drizzleAdapter(database.db, { provider: "pg", schema, transaction: true }),
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      revokeSessionsOnPasswordReset: true,
    },
    socialProviders: {
      github: social("github"),
      google: {
        ...social("google"),
        // Google's callback reads the ID token unverified; check its signature, issuer, audience,
        // and age against Google's keys before trusting the identity.
        getUserInfo: async (tokens: OAuth2Tokens) => {
          const claims =
            tokens.idToken && config.GOOGLE_CLIENT_ID
              ? await verifyGoogleIdToken({
                  token: tokens.idToken,
                  audience: config.GOOGLE_CLIENT_ID,
                })
              : null;
          const profile = googleProfileSchema.safeParse(claims);
          if (!profile.success) return null;
          return {
            user: {
              name: profile.data.name,
              email: profile.data.email,
              image: profile.data.picture || undefined,
              emailVerified: profile.data.email_verified,
            },
            data: profile.data,
          };
        },
      },
      discord: social("discord"),
    },
    account: {
      accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: true },
    },
    onAPIError: { errorURL: `${config.KANVIL_URL}/login` },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (
          ctx.path === "/sign-in/email" &&
          !(await instance.authentication()).emailPasswordEnabled
        )
          throw new APIError("FORBIDDEN", {
            code: "password_sign_in_disabled",
            message: "Use your identity provider to sign in",
          });
        if (ctx.path.startsWith("/email-otp/") || ctx.path === "/forget-password/email-otp") {
          if (
            !emailCodePaths.has(ctx.path) ||
            (ctx.path === "/email-otp/send-verification-otp" &&
              z.object({ type: z.string() }).safeParse(ctx.body).data?.type !== "sign-in")
          )
            throw new APIError("NOT_FOUND", { code: "not_found", message: "Not found" });
        }
        if (
          emailCodePaths.has(ctx.path) &&
          !emailCodesAvailable(config, await instance.authentication())
        )
          throw new APIError("FORBIDDEN", {
            code: "email_codes_unavailable",
            message: "Email codes are not available on this instance",
          });
        // A throttled request ends before the plugin makes a code, so the last code mailed to the
        // address stays valid. It answers like any other request.
        if (
          ctx.path === "/email-otp/send-verification-otp" ||
          ctx.path === "/email-otp/request-password-reset"
        ) {
          const email = z.object({ email: z.string() }).safeParse(ctx.body).data?.email;
          try {
            if (email) codeSends.consume(email.toLowerCase());
          } catch {
            return ctx.json({ success: true });
          }
        }
        return undefined;
      }),
    },
    user: {
      // Set once by account deletion; nothing a person or the authentication API sends can change it.
      additionalFields: { deletedAt: { type: "date", required: false, input: false } },
      validateUserInfo: async ({ user, source }) => {
        if (source.method !== "oauth") return undefined;
        if (!user.email || user.emailVerified !== true)
          return {
            error: "email_not_verified",
            errorDescription: "The identity provider must verify your email address",
          };
        // Only the deployment's OIDC provider provisions accounts, and only when policy allows it.
        if (
          source.action === "create-user" &&
          (source.oauth?.providerId !== "oidc" ||
            !(await instance.authentication()).ssoAutoProvision)
        )
          return {
            error: "signup_disabled",
            errorDescription: "Ask an administrator to create and link your account",
          };
        return undefined;
      },
    },
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
      emailOTP({
        // Codes reach existing accounts only; they never create one.
        disableSignUp: true,
        expiresIn: codeMinutes * 60,
        allowedAttempts: 3,
        // Asking again mails the same code while it is valid, so a later request, throttled or
        // undelivered, never replaces a code someone already has. Reuse needs the code back, so
        // it is stored encrypted with the server secret rather than hashed.
        resendStrategy: "reuse",
        storeOTP: "encrypted",
        sendVerificationOTP: ({ email, otp, type }, ctx) => {
          // The emailed link opens the page the request started on, such as an invitation. Only a
          // plain path on this instance qualifies; anything else opens the sign-in page.
          const page = ctx?.headers?.get("x-kanvil-return") ?? "";
          void sendCode(
            email,
            otp,
            type,
            /^\/[\w-]+(\/[\w-]+)*$/.test(page) ? page : "/login",
          ).catch(() => console.error("Kanvil email failed"));
          return Promise.resolve();
        },
      }),
      genericOAuth({
        config:
          config.OIDC_DISCOVERY_URL && config.OIDC_CLIENT_ID && config.OIDC_CLIENT_SECRET
            ? [
                {
                  providerId: "oidc",
                  discoveryUrl: config.OIDC_DISCOVERY_URL,
                  requireIdTokenVerification: true,
                  getUserInfo: createOIDCUserInfo(config),
                  clientId: config.OIDC_CLIENT_ID,
                  clientSecret: config.OIDC_CLIENT_SECRET,
                  scopes: ["openid", "profile", "email"],
                  pkce: true,
                  // The persisted policy is checked at the user-creation boundary, including in-flight callbacks.
                  disableSignUp: false,
                },
              ]
            : [],
      }),
    ],
  });
}
export type Auth = ReturnType<typeof createAuth>;
