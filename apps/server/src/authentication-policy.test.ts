import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { z } from "zod";
import { createFixture } from "./test-fixture.ts";
import { createApplication } from "./app.ts";

let fixture: Awaited<ReturnType<typeof createFixture>>;
let application: Awaited<ReturnType<typeof createApplication>>;
let cookie = "";
const password = "Isolated-owner-password-234";
const request = (path: string, method = "GET", body?: unknown, session = cookie) =>
  application.app.fetch(
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
const settings = async () =>
  z
    .object({ version: z.number() })
    .passthrough()
    .parse(await (await request("/api/v1/admin/instance")).json());
const update = async (authentication: unknown, expectedVersion?: number) => {
  const current = await settings();
  return request("/api/v1/admin/instance", "PATCH", {
    expectedVersion: expectedVersion ?? current.version,
    name: "Kanvil",
    description: "",
    storage: { provider: "local" },
    search: { provider: "postgres" },
    authentication,
  });
};
beforeAll(async () => {
  fixture = await createFixture();
  application = await createApplication(fixture.database, fixture.config);
  await request("/api/v1/setup", "POST", {
    token: fixture.config.KANVIL_SETUP_TOKEN,
    name: "Owner",
    email: "policy-owner@example.test",
    password,
  });
  const login = await request("/api/auth/sign-in/email", "POST", {
    email: "policy-owner@example.test",
    password,
  });
  cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
});
afterAll(async () => {
  await application?.close();
  await fixture?.close();
});
it("publishes backward-compatible authentication defaults and persists independent provisioning policy", async () => {
  expect(await (await request("/api/v1/info", "GET", undefined, "")).json()).toMatchObject({
    authentication: { emailPasswordEnabled: true, ssoAutoProvision: false },
  });
  expect((await update({ emailPasswordEnabled: true, ssoAutoProvision: true })).status).toBe(200);
  expect(await settings()).toMatchObject({
    authentication: { emailPasswordEnabled: true, ssoAutoProvision: true },
  });
});
it("rejects disabling passwords without a configured provider and preserves the prior policy", async () => {
  const response = await update({ emailPasswordEnabled: false, ssoAutoProvision: false });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "oidc_required" } });
});

it("retains the prior policy for stale, invalid, and non-admin updates", async () => {
  const prior = await settings();
  expect(
    (await update({ emailPasswordEnabled: true, ssoAutoProvision: false }, prior.version - 1))
      .status,
  ).toBe(409);
  expect((await update({ emailPasswordEnabled: "false", ssoAutoProvision: false })).status).toBe(
    400,
  );
  const person = await application.auth.api.createUser({
    body: {
      name: "Reader",
      email: "policy-reader@example.test",
      password,
      role: "user",
    },
  });
  const login = await request("/api/auth/sign-in/email", "POST", {
    email: person.user.email,
    password,
  });
  const reader = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  expect(
    (
      await request(
        "/api/v1/admin/instance",
        "PATCH",
        {
          expectedVersion: prior.version,
          name: "Kanvil",
          description: "",
          storage: { provider: "local" },
          search: { provider: "postgres" },
          authentication: { emailPasswordEnabled: true, ssoAutoProvision: false },
        },
        reader,
      )
    ).status,
  ).toBe(403);
  expect(await settings()).toEqual(prior);
});
