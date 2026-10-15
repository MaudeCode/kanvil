import { z } from "zod";

const endpoint = z
  .url({ protocol: /^https?$/ })
  .refine(
    (value) => !/^https?:\/\/[^/]*@/.test(value) && !/[?#]/.test(value),
    "Use an HTTP(S) endpoint without embedded credentials",
  );
export const s3SettingsSchema = z
  .object({
    endpoint: z.union([endpoint, z.literal("")]).default(""),
    region: z.string().min(1).max(100).default("us-east-1"),
    bucket: z.string().min(3).max(255),
    prefix: z
      .string()
      .max(200)
      .regex(/^[a-zA-Z0-9/_-]*$/)
      .default("kanvil/"),
    forcePathStyle: z.boolean().default(true),
    accessKeyId: z.string().max(500).default(""),
    secretAccessKey: z.string().max(2000).optional(),
  })
  .strict();
export const searchSettingsSchema = z
  .object({
    url: endpoint,
    index: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,100}$/),
    apiKey: z.string().max(4000).optional(),
    username: z.string().max(500).default(""),
    password: z.string().max(2000).optional(),
  })
  .strict();
export const storageSettingsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("local") }).strict(),
  s3SettingsSchema.extend({ provider: z.literal("s3") }),
]);
export const externalSearchSettingsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("postgres") }).strict(),
  searchSettingsSchema.extend({ provider: z.literal("elasticsearch") }),
]);
export const brokerSettingsSchema = z
  .object({
    url: z
      .url({ protocol: /^amqps?$/ })
      .max(4000)
      .optional(),
    exchange: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .refine((value) => !value.startsWith("amq."), "Use an application exchange")
      .default("kanvil.events"),
  })
  .strict();
export const eventDeliverySettingsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("postgres") }).strict(),
  brokerSettingsSchema.extend({ provider: z.literal("rabbitmq") }),
]);
export const instanceUpdateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(100),
    description: z.string().max(500),
    storage: storageSettingsSchema,
    search: externalSearchSettingsSchema,
    broker: eventDeliverySettingsSchema.optional(),
  })
  .strict();
export const publicInstanceSchema = z.object({ name: z.string(), description: z.string() });
export const adminInstanceSchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  name: z.string(),
  description: z.string(),
  storage: z.object({
    provider: z.enum(["local", "s3"]),
    source: z.enum(["deployment", "admin"]),
    settings: s3SettingsSchema.omit({ secretAccessKey: true }).nullable(),
    secretConfigured: z.boolean(),
    pending: z.number().int(),
    status: z.enum(["ready", "transferring", "unavailable"]),
    error: z.string().nullable(),
  }),
  search: z.object({
    provider: z.enum(["postgres", "elasticsearch"]),
    source: z.enum(["deployment", "admin"]),
    settings: searchSettingsSchema.omit({ apiKey: true, password: true }).nullable(),
    secretConfigured: z.boolean(),
    status: z.enum(["builtin", "indexing", "ready", "unavailable"]),
    cursor: z.string(),
    error: z.string().nullable(),
  }),
  broker: z.object({
    provider: z.enum(["postgres", "rabbitmq"]),
    source: z.enum(["deployment", "admin"]),
    settings: z.object({ endpoint: z.string(), exchange: z.string() }).nullable(),
    secretConfigured: z.boolean(),
    status: z.enum(["builtin", "connecting", "ready", "unavailable"]),
    error: z.string().nullable(),
  }),
  deployment: z.object({
    url: z.string(),
    oidc: z.object({ name: z.string(), discoveryUrl: z.string(), clientId: z.string() }).nullable(),
    push: z.boolean(),
    version: z.string(),
  }),
  locations: z.array(
    z.object({
      id: z.uuid(),
      bucket: z.string(),
      endpoint: z.string(),
      prefix: z.string(),
      objects: z.number().int(),
    }),
  ),
});
export const photoInputSchema = z
  .object({
    data: z.string().max(700_000),
    contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  })
  .strict();
export const photoResultSchema = z.object({ image: z.string().nullable() });
export type S3Settings = z.infer<typeof s3SettingsSchema>;
export type SearchSettings = z.infer<typeof searchSettingsSchema>;
export type AdminInstance = z.infer<typeof adminInstanceSchema>;

export type BrokerSettings = z.infer<typeof brokerSettingsSchema>;
