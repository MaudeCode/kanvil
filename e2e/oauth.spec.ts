import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "./test.ts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

import { signIn, ownerEmail, ownerPassword, useEmailLogin } from "./auth.ts";
const clientSchema = z.object({ client_id: z.string() });
const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  scope: z.string(),
});
test("interactive MCP authorization uses sign-in, explicit consent, PKCE, and scoped tokens", async ({
  page,
  request,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Expected an isolated test server");
  const origin = baseURL;
  const callbackURL = new URL("/oauth-test/callback", origin);
  callbackURL.hostname = "127.0.0.1";
  const redirect = callbackURL.href;
  await signIn(page);
  const registration = await page.request.post("/api/auth/oauth2/create-client", {
    headers: { Origin: origin },
    data: {
      client_name: "Kanvil MCP test client",
      application_type: "native",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "openid profile offline_access kanvil:read",
      require_pkce: true,
    },
  });
  expect(registration.status(), await registration.text()).toBe(201);
  const client = clientSchema.parse(await registration.json());
  const logout = await page.request.post("/api/auth/sign-out", {
    headers: { Origin: origin },
    data: {},
  });
  expect(logout.status()).toBe(200);
  const verifier = randomBytes(48).toString("base64url");
  const authorization = new URL(`${origin}/api/auth/oauth2/authorize`);
  authorization.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: "code",
    scope: "openid profile offline_access kanvil:read",
    state: "test-client-state",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    resource: `${origin}/mcp`,
  }).toString();
  await page.goto(authorization.toString());
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await useEmailLogin(page);
  await page.getByLabel("Email", { exact: true }).fill(ownerEmail);
  await page.getByLabel("Password", { exact: true }).fill(ownerPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Authorize Kanvil MCP test client", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("kanvil:read", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Allow access", exact: true }).click();
  await page.waitForURL("**/oauth-test/callback?**");
  const callback = new URL(page.url());
  expect(callback.searchParams.get("state")).toBe("test-client-state");
  expect(callback.searchParams.get("error")).toBeNull();
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  const exchange = await request.post(`${origin}/api/auth/oauth2/token`, {
    form: {
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: redirect,
      code: code ?? "",
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    },
  });
  expect(exchange.status(), await exchange.text()).toBe(200);
  const token = tokenSchema.parse(await exchange.json());
  expect(token.scope).toContain("kanvil:read");
  const sdk = new Client({ name: "kanvil-oauth-browser-test", version: "1.0.0" });
  try {
    await sdk.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } },
      }),
    );
    const result = await sdk.callTool({ name: "list_projects", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toHaveProperty("result");
    const denied = await sdk.callTool({
      name: "create_project",
      arguments: { key: "DENIED", name: "No write scope" },
    });
    expect(denied.isError).toBe(true);
  } finally {
    await sdk.close();
  }
});
