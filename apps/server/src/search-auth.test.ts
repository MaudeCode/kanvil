import { expect, it, vi } from "vite-plus/test";
import { createFixture } from "./test-fixture.ts";
import { createInstance } from "./instance.ts";
import { createElasticsearchIndex } from "./adapters/elasticsearch.ts";
it("switches saved search authentication without retaining an old API key", async () => {
  const fixture = await createFixture(),
    instance = createInstance(fixture.database, fixture.config);
  try {
    const root = await instance.read(),
      endpoint = { url: "http://search.fixture.test", index: "kanvil-auth", username: "" };
    await instance.update({
      expectedVersion: root.version,
      name: root.name,
      description: root.description,
      storage: { provider: "local" },
      search: { provider: "elasticsearch", ...endpoint, apiKey: "old-key" },
    });
    const basic = await instance.resolveSearch({
      ...endpoint,
      auth: "basic",
      apiKey: "",
      username: "new-user",
      password: "new-password",
    });
    expect(basic.apiKey).toBeUndefined();
    expect(basic.auth).toBe("basic");
    const authorizations: string[] = [];
    let document: unknown;
    vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit = {}) => {
      authorizations.push(new Headers(init.headers).get("Authorization") ?? "");
      if (init.method === "PUT") {
        if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
        document = JSON.parse(init.body);
      }
      return Response.json(init.method ? {} : { _source: document });
    });
    await createElasticsearchIndex(basic).probe(root.identity);
    expect(authorizations).toEqual(
      Array(3).fill(`Basic ${Buffer.from("new-user:new-password").toString("base64")}`),
    );
    const latest = await instance.read();
    await instance.update({
      expectedVersion: latest.version,
      name: root.name,
      description: root.description,
      storage: { provider: "local" },
      search: { provider: "elasticsearch", ...basic },
    });
    expect(await instance.search()).toMatchObject({
      auth: "basic",
      username: "new-user",
      password: "new-password",
    });
    const anonymous = await instance.resolveSearch({
      ...endpoint,
      auth: "none",
      apiKey: "",
      password: "",
    });
    expect(anonymous.apiKey).toBeUndefined();
    expect(anonymous.password).toBeUndefined();
    authorizations.length = 0;
    await createElasticsearchIndex(anonymous).probe(root.identity);
    expect(authorizations).toEqual(["", "", ""]);
  } finally {
    vi.unstubAllGlobals();
    await fixture.close();
  }
});
