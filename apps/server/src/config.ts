import { z } from "zod";

const envSchema = z
  .object({
    DATABASE_URL: z.url(),
    KANVIL_URL: z.url().default("http://localhost:5180"),
    BETTER_AUTH_SECRET: z.string().min(32),
    KANVIL_SETUP_TOKEN: z.string().min(24).optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(5180),
    HOST: z.string().default("127.0.0.1"),
    KANVIL_TRUSTED_ORIGINS: z.string().default(""),
    OIDC_DISCOVERY_URL: z.url().optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_NAME: z.string().default("PocketID"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  })
  .superRefine((value, ctx) => {
    const supplied = [
      value.OIDC_DISCOVERY_URL,
      value.OIDC_CLIENT_ID,
      value.OIDC_CLIENT_SECRET,
    ].filter(Boolean).length;
    if (supplied !== 0 && supplied !== 3)
      ctx.addIssue({ code: "custom", message: "Configure all three OIDC settings together" });
    if (!new URL(value.DATABASE_URL).protocol.startsWith("postgres"))
      ctx.addIssue({ code: "custom", message: "DATABASE_URL must be PostgreSQL" });
    if (value.NODE_ENV === "production" && !value.KANVIL_URL.startsWith("https://"))
      ctx.addIssue({ code: "custom", message: "Production KANVIL_URL must use HTTPS" });
  });
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const values = envSchema.parse(env);
  return {
    ...values,
    trustedOrigins: [
      new URL(values.KANVIL_URL).origin,
      ...values.KANVIL_TRUSTED_ORIGINS.split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      "kanvil://",
    ],
  };
}
export type Config = ReturnType<typeof readConfig>;
