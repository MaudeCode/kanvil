import { expect, it } from "vite-plus/test";
import { readConfig } from "./config.ts";
const base = {
  DATABASE_URL: "postgres://kanvil:fixture@localhost/fixture",
  BETTER_AUTH_SECRET: "isolated-configuration-test-secret-234",
};
it.each([
  ["ELASTICSEARCH_INDEX", "Uppercase Index"],
  ["ELASTICSEARCH_URL", "https://user:secret@example.test"],
  ["S3_PREFIX", "../outside"],
  ["S3_ENDPOINT", "ftp://example.test"],
  ["RABBITMQ_EXCHANGE", "amq.reserved"],
  ["RABBITMQ_URL", "https://example.test"],
  ["KANVIL_API_KEY_RATE_LIMIT_ENABLED", "off"],
  ...["29", "1.5", "invalid", "Infinity", "2147483648", ""].map((value) => [
    "KANVIL_CLAIM_MAX_LEASE_SECONDS",
    value,
  ]),
])("rejects invalid deployment %s at startup", (key, value) => {
  expect(() => readConfig({ ...base, [key]: value })).toThrow();
});
it("keeps API-key rate limits enabled unless explicitly disabled", () => {
  expect(readConfig(base).KANVIL_API_KEY_RATE_LIMIT_ENABLED).toBe(true);
  expect(
    readConfig({ ...base, KANVIL_API_KEY_RATE_LIMIT_ENABLED: "true" })
      .KANVIL_API_KEY_RATE_LIMIT_ENABLED,
  ).toBe(true);
  expect(
    readConfig({ ...base, KANVIL_API_KEY_RATE_LIMIT_ENABLED: "false" })
      .KANVIL_API_KEY_RATE_LIMIT_ENABLED,
  ).toBe(false);
});
it("validates provider requirements and accepts compatible optional services", () => {
  expect(() =>
    readConfig({
      ...base,
      KANVIL_SEARCH_PROVIDER: "elasticsearch",
      ELASTICSEARCH_URL: "http://localhost:9200",
      ELASTICSEARCH_AUTH: "basic",
    }),
  ).toThrow("ELASTICSEARCH_USERNAME");
  expect(() => readConfig({ ...base, KANVIL_BROKER_PROVIDER: "rabbitmq" })).toThrow("RABBITMQ_URL");
  expect(
    readConfig({
      ...base,
      KANVIL_STORAGE_PROVIDER: "s3",
      S3_BUCKET: "fixture-bucket",
      S3_ENDPOINT: "http://localhost:9000",
      KANVIL_BROKER_PROVIDER: "rabbitmq",
      RABBITMQ_URL: "amqp://fixture:fixture@localhost/fixture",
      KANVIL_SEARCH_PROVIDER: "elasticsearch",
      ELASTICSEARCH_URL: "http://localhost:9200",
      ELASTICSEARCH_AUTH: "none",
    }),
  ).toMatchObject({
    S3_PREFIX: "kanvil/",
    RABBITMQ_EXCHANGE: "kanvil.events",
    ELASTICSEARCH_AUTH: "none",
  });
});
it("requires each OAuth app's client ID and secret together", () => {
  expect(() => readConfig({ ...base, GITHUB_CLIENT_ID: "fixture-client" })).toThrow(
    "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET",
  );
  expect(() => readConfig({ ...base, DISCORD_CLIENT_SECRET: "fixture-secret" })).toThrow(
    "DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET",
  );
  expect(
    readConfig({ ...base, GOOGLE_CLIENT_ID: "fixture-client", GOOGLE_CLIENT_SECRET: "fixture" }),
  ).toMatchObject({ GOOGLE_CLIENT_ID: "fixture-client" });
});

it("defaults the configurable claim lease cap to 24 hours", () => {
  expect(readConfig(base).KANVIL_CLAIM_MAX_LEASE_SECONDS).toBe(86400);
  for (const seconds of [30, 1800, 172800])
    expect(
      readConfig({ ...base, KANVIL_CLAIM_MAX_LEASE_SECONDS: String(seconds) })
        .KANVIL_CLAIM_MAX_LEASE_SECONDS,
    ).toBe(seconds);
});
