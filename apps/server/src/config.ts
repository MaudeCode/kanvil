import { z } from "zod";
import {
  s3SettingsSchema,
  searchSettingsSchema,
  brokerSettingsSchema,
} from "@kanvil/contracts/instance";

const optionalEnv = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
const envSchema = z
  .object({
    DATABASE_URL: z.url(),
    KANVIL_STORAGE_PROVIDER: optionalEnv(z.enum(["local", "s3"])),
    S3_ENDPOINT: optionalEnv(s3SettingsSchema.shape.endpoint),
    S3_REGION: s3SettingsSchema.shape.region,
    S3_BUCKET: optionalEnv(s3SettingsSchema.shape.bucket),
    S3_PREFIX: s3SettingsSchema.shape.prefix,
    S3_ACCESS_KEY_ID: optionalEnv(s3SettingsSchema.shape.accessKeyId),
    S3_SECRET_ACCESS_KEY: optionalEnv(s3SettingsSchema.shape.secretAccessKey),
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    KANVIL_SEARCH_PROVIDER: optionalEnv(z.enum(["postgres", "elasticsearch"])),
    ELASTICSEARCH_URL: optionalEnv(searchSettingsSchema.shape.url),
    ELASTICSEARCH_INDEX: optionalEnv(searchSettingsSchema.shape.index),
    ELASTICSEARCH_AUTH: optionalEnv(searchSettingsSchema.shape.auth),
    ELASTICSEARCH_API_KEY: optionalEnv(searchSettingsSchema.shape.apiKey),
    ELASTICSEARCH_USERNAME: searchSettingsSchema.shape.username,
    ELASTICSEARCH_PASSWORD: optionalEnv(searchSettingsSchema.shape.password),
    KANVIL_BROKER_PROVIDER: optionalEnv(z.enum(["postgres", "rabbitmq"])),
    RABBITMQ_URL: optionalEnv(brokerSettingsSchema.shape.url),
    RABBITMQ_EXCHANGE: brokerSettingsSchema.shape.exchange,
    KANVIL_URL: z.url().default("http://localhost:5180"),
    BETTER_AUTH_SECRET: z.string().min(32),
    KANVIL_SETUP_TOKEN: optionalEnv(z.string().min(24)),
    PORT: z.coerce.number().int().min(1).max(65535).default(5180),
    HOST: z.string().default("127.0.0.1"),
    KANVIL_TRUSTED_ORIGINS: z.string().default(""),
    OIDC_DISCOVERY_URL: optionalEnv(z.url()),
    OIDC_CLIENT_ID: optionalEnv(z.string().min(1)),
    OIDC_CLIENT_SECRET: optionalEnv(z.string().min(1)),
    OIDC_NAME: z.string().default("PocketID"),
    KANVIL_SESSION_WRITE_LIMIT: z.coerce.number().int().min(1).max(100_000).default(120),
    KANVIL_PUSH_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    EXPO_ACCESS_TOKEN: optionalEnv(z.string().min(1)),
    // SMTP relay for email notification channels, such as smtp://user:pass@mail.example.com:587.
    SMTP_URL: optionalEnv(z.url({ protocol: /^smtps?$/ })),
    SMTP_FROM: optionalEnv(z.string().min(3)),
    // Lets channels, destinations, and import sources reach loopback and private networks, such as
    // a LAN ntfy or a Jira Data Center site.
    KANVIL_DELIVERY_ALLOW_PRIVATE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // The GitHub REST API that repository connections call; GitHub Enterprise Server uses its own.
    KANVIL_GITHUB_API_URL: z.url({ protocol: /^https?$/ }).default("https://api.github.com"),
    // The Linear GraphQL API that imports read.
    KANVIL_LINEAR_API_URL: z
      .url({ protocol: /^https?$/ })
      .default("https://api.linear.app/graphql"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  })
  .superRefine((value, ctx) => {
    if (value.KANVIL_STORAGE_PROVIDER === "s3" && !value.S3_BUCKET)
      ctx.addIssue({ code: "custom", message: "S3_BUCKET is required for S3 storage" });
    if (value.KANVIL_SEARCH_PROVIDER === "elasticsearch" && !value.ELASTICSEARCH_URL)
      ctx.addIssue({
        code: "custom",
        message: "ELASTICSEARCH_URL is required for external search",
      });
    if (value.KANVIL_BROKER_PROVIDER === "rabbitmq" && !value.RABBITMQ_URL)
      ctx.addIssue({ code: "custom", message: "RABBITMQ_URL is required for RabbitMQ delivery" });
    if (value.KANVIL_SEARCH_PROVIDER === "elasticsearch") {
      if (value.ELASTICSEARCH_AUTH === "apiKey" && !value.ELASTICSEARCH_API_KEY)
        ctx.addIssue({
          code: "custom",
          message: "ELASTICSEARCH_API_KEY is required for API-key authentication",
        });
      if (
        value.ELASTICSEARCH_AUTH === "basic" &&
        (!value.ELASTICSEARCH_USERNAME || !value.ELASTICSEARCH_PASSWORD)
      )
        ctx.addIssue({
          code: "custom",
          message:
            "ELASTICSEARCH_USERNAME and ELASTICSEARCH_PASSWORD are required for basic authentication",
        });
    }
    const supplied = [
      value.OIDC_DISCOVERY_URL,
      value.OIDC_CLIENT_ID,
      value.OIDC_CLIENT_SECRET,
    ].filter(Boolean).length;
    if (supplied !== 0 && supplied !== 3)
      ctx.addIssue({ code: "custom", message: "Configure all three OIDC settings together" });
    if (value.SMTP_URL && !value.SMTP_FROM)
      ctx.addIssue({ code: "custom", message: "SMTP_FROM is required with SMTP_URL" });
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
