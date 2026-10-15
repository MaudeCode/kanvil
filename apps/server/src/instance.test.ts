import { adminInstanceSchema } from "@kanvil/contracts/instance";
import { infoSchema, projectSchema, ticketSchema, attachmentSchema } from "@kanvil/contracts";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import S3rver from "s3rver";
import { z } from "zod";
import { createFixture } from "./test-fixture.ts";
import { createApplication } from "./app.ts";

let fixture: Awaited<ReturnType<typeof createFixture>>,
  app: Awaited<ReturnType<typeof createApplication>>,
  cookie: string,
  server: S3rver,
  directory: string,
  endpoint: string;
const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
const request = (path: string, method = "GET", body?: unknown, session = cookie) =>
  app.app.fetch(
    new Request(`http://localhost:5180${path}`, {
      method,
      headers: {
        Cookie: session,
        Origin: "http://localhost:5180",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
async function readJson<T>(schema: z.ZodType<T>, path: string, method = "GET", body?: unknown) {
  const result = await request(path, method, body);
  expect(result.ok, await result.clone().text()).toBe(true);
  return schema.parse(await result.json());
}
beforeAll(async () => {
  fixture = await createFixture();
  app = await createApplication(fixture.database, fixture.config);
  directory = await mkdtemp(join(tmpdir(), "kanvil-s3-"));
  server = new S3rver({
    address: "127.0.0.1",
    port: 0,
    directory,
    silent: true,
    configureBuckets: [{ name: "kanvil-tests", configs: [] }],
  });
  const address = await server.run();
  endpoint = `http://127.0.0.1:${address.port}`;
  await request(
    "/api/v1/setup",
    "POST",
    {
      token: fixture.config.KANVIL_SETUP_TOKEN,
      name: "Test admin",
      email: "owner@example.test",
      password: "Test-only-owner-password-234",
    },
    "",
  );
  cookie = cookieOf(
    await request(
      "/api/auth/sign-in/email",
      "POST",
      { email: "owner@example.test", password: "Test-only-owner-password-234" },
      "",
    ),
  );
});
afterAll(async () => {
  await app?.close();
  await fixture?.close();
  await server?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it("protects instance settings and never returns integration secrets", async () => {
  expect((await request("/api/v1/admin/instance", "GET", undefined, "")).status).toBe(401);
  const created = await app.auth.api.createUser({
    body: {
      name: "Reader",
      email: "reader@example.test",
      password: "Test-only-reader-password-234",
      role: "user",
    },
  });
  const reader = cookieOf(
    await request(
      "/api/auth/sign-in/email",
      "POST",
      { email: "reader@example.test", password: "Test-only-reader-password-234" },
      "",
    ),
  );
  expect((await request("/api/v1/admin/instance", "GET", undefined, reader)).status).toBe(403);
  const settings = await readJson(adminInstanceSchema, "/api/v1/admin/instance");
  expect(
    (
      await request("/api/v1/admin/instance", "PATCH", {
        expectedVersion: settings.version,
        name: "Test instance",
        description: "Private ticketing",
        storage: { provider: "local" },
        search: { provider: "postgres" },
      })
    ).status,
  ).toBe(200);
  expect(
    infoSchema.parse(await (await request("/api/v1/info", "GET", undefined, "")).json()).name,
  ).toBe("Test instance");
  expect(
    (
      await request("/api/v1/admin/instance", "PATCH", {
        expectedVersion: settings.version,
        name: "Stale",
        description: "",
        storage: { provider: "local" },
        search: { provider: "postgres" },
      })
    ).status,
  ).toBe(409);
  expect(created.user.id).toBeTruthy();
});
it("stores attachments and photos in S3, preserves previous locations, and cleans abandoned uploads", async () => {
  const s3 = {
    endpoint,
    region: "us-east-1",
    bucket: "kanvil-tests",
    prefix: "test/",
    forcePathStyle: true,
    accessKeyId: "S3RVER",
    secretAccessKey: "S3RVER",
  };
  expect((await request("/api/v1/admin/storage/test", "POST", s3)).status).toBe(200);
  let settings = await readJson(adminInstanceSchema, "/api/v1/admin/instance");
  const saved = await request("/api/v1/admin/instance", "PATCH", {
    expectedVersion: settings.version,
    name: settings.name,
    description: settings.description,
    storage: { provider: "s3", ...s3 },
    search: { provider: "postgres" },
  });
  expect(saved.status, await saved.text()).toBe(200);
  const output = await request("/api/v1/admin/instance");
  expect(await output.text()).not.toContain('"secretAccessKey"');
  const encrypted = await fixture.database.pool.query("SELECT config FROM storage_backends");
  expect(JSON.stringify(encrypted.rows)).not.toContain("S3RVER");
  const project = await readJson(projectSchema, "/api/v1/projects", "POST", {
    key: "BLOB",
    name: "Blob project",
  });
  const ticket = await readJson(ticketSchema, `/api/v1/projects/${project.id}/tickets`, "POST", {
    title: "Storage test",
  });
  const content = Buffer.from("S3 attachment bytes"),
    uploaded = await readJson(
      attachmentSchema,
      `/api/v1/projects/${project.id}/tickets/${ticket.id}/attachments`,
      "POST",
      { name: "proof.txt", contentType: "text/plain", data: content.toString("base64") },
    );
  const url = `/api/v1/projects/${project.id}/attachments/${uploaded.id}/content`;
  expect(Buffer.from(await (await request(url)).arrayBuffer())).toEqual(content);
  const photo = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8NsAAAAASUVORK5CYII=",
    "base64",
  );
  const response = await request("/api/v1/profile/photo", "POST", {
    contentType: "image/png",
    data: photo.toString("base64"),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const image = z.object({ image: z.string() }).parse(await response.json()).image;
  expect(Buffer.from(await (await request(image)).arrayBuffer())).toEqual(photo);
  await app.blobs.sync();
  expect(
    (
      await fixture.database.pool.query(
        "SELECT id FROM blob_objects WHERE backend_id IS NOT NULL AND data IS NOT NULL",
      )
    ).rowCount,
  ).toBe(0);

  expect(
    (
      await request("/api/v1/profile/photo", "POST", {
        contentType: "image/png",
        data: Buffer.from("<svg>not a photo</svg>").toString("base64"),
      })
    ).status,
  ).toBe(400);
  settings = await readJson(adminInstanceSchema, "/api/v1/admin/instance");
  expect(
    (
      await request("/api/v1/admin/instance", "PATCH", {
        expectedVersion: settings.version,
        name: settings.name,
        description: settings.description,
        storage: { provider: "local" },
        search: { provider: "postgres" },
      })
    ).status,
  ).toBe(200);
  expect(Buffer.from(await (await request(url)).arrayBuffer())).toEqual(content);
  expect(Buffer.from(await (await request(image)).arrayBuffer())).toEqual(photo);
  const abandoned = crypto.randomUUID();
  await expect(
    fixture.database.db.transaction(async (tx) => {
      await app.blobs.put(tx, abandoned, Buffer.from("abandoned upload"), "text/plain");
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect(
    (await fixture.database.pool.query("SELECT id FROM blob_objects WHERE id=$1", [abandoned]))
      .rowCount,
  ).toBe(0);
  expect((await request("/api/v1/profile/photo", "DELETE")).status).toBe(200);
  expect((await request(image)).status).toBe(404);
});

it("honors deployment providers and tests their effective credentials without revealing secrets", async () => {
  const deployed = await createApplication(fixture.database, {
    ...fixture.config,
    KANVIL_STORAGE_PROVIDER: "s3",
    S3_ENDPOINT: endpoint,
    S3_BUCKET: "kanvil-tests",
    S3_ACCESS_KEY_ID: "S3RVER",
    S3_SECRET_ACCESS_KEY: "S3RVER",
    KANVIL_SEARCH_PROVIDER: "postgres",
    KANVIL_BROKER_PROVIDER: "postgres",
  });
  const call = (path: string, method = "GET", body?: unknown) =>
    deployed.app.fetch(
      new Request(`http://localhost:5180${path}`, {
        method,
        headers: {
          Cookie: cookie,
          Origin: "http://localhost:5180",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  try {
    const settings = adminInstanceSchema.parse(await (await call("/api/v1/admin/instance")).json());
    expect(settings.storage).toMatchObject({
      source: "deployment",
      provider: "s3",
      secretConfigured: true,
    });
    expect(settings.broker).toMatchObject({ source: "deployment", provider: "postgres" });
    expect((await call("/api/v1/admin/storage/test", "POST", {})).status).toBe(200);
    expect(
      (
        await call("/api/v1/admin/instance", "PATCH", {
          expectedVersion: settings.version,
          name: settings.name,
          description: settings.description,
          storage: { provider: "local" },
          search: {
            provider: "elasticsearch",
            url: "http://unused.example.test",
            index: "ignored",
          },
          broker: { provider: "rabbitmq", url: "amqp://unused.example.test", exchange: "ignored" },
        })
      ).status,
    ).toBe(200);
    const after = adminInstanceSchema.parse(await (await call("/api/v1/admin/instance")).json());
    expect(after.storage.provider).toBe("s3");
    expect(after.search.provider).toBe("postgres");
    expect(after.broker.provider).toBe("postgres");
    expect(await (await call("/api/v1/admin/instance")).text()).not.toContain('"secretAccessKey"');
  } finally {
    await deployed.close();
  }
});
