import { z } from "zod";

const optionalEnv = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
const envSchema = z
  .object({
    DATABASE_URL: z.url(),
    KANVIL_STORAGE_PROVIDER: optionalEnv(z.enum(["local", "s3"])),
    S3_ENDPOINT: optionalEnv(z.url()),
    S3_REGION: z.string().default("us-east-1"),
    S3_BUCKET: optionalEnv(z.string().min(3)),
    S3_PREFIX: z.string().default("kanvil/"),
    S3_ACCESS_KEY_ID: optionalEnv(z.string()),
    S3_SECRET_ACCESS_KEY: optionalEnv(z.string()),
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    KANVIL_SEARCH_PROVIDER: optionalEnv(z.enum(["postgres", "elasticsearch"])),
    ELASTICSEARCH_URL: optionalEnv(z.url()),
    ELASTICSEARCH_INDEX: optionalEnv(z.string()),
    ELASTICSEARCH_API_KEY: optionalEnv(z.string()),
    ELASTICSEARCH_USERNAME: z.string().default(""),
    ELASTICSEARCH_PASSWORD: optionalEnv(z.string()),
    KANVIL_BROKER_PROVIDER: optionalEnv(z.enum(["postgres", "rabbitmq"])),
    RABBITMQ_URL: optionalEnv(z.url({ protocol: /^amqps?$/ })),
    RABBITMQ_EXCHANGE: z.string().default("kanvil.events"),
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
    KANVIL_PUSH_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    EXPO_ACCESS_TOKEN: optionalEnv(z.string().min(1)),
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
