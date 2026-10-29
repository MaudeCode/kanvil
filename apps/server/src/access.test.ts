import { describe, expect, it } from "vite-plus/test";
import { createWriteLimiter } from "./access.ts";
import { hasScope, type Actor } from "./domain.ts";
import { isOperation, operations, scopes } from "@kanvil/contracts";

it("limits intake to creating tickets and their attachments while preserving ordinary scope access", () => {
  const actor: Actor = {
    id: "owner",
    ownerId: "key",
    machine: true,
    admin: true,
    scopes: ["intake"],
  };
  for (const name of Object.keys(operations).filter(isOperation))
    expect(hasScope(actor, operations[name].scope, name), name).toBe(
      ["create_ticket", "upload_attachment", "list_attachments"].includes(name),
    );
  for (const scope of scopes) expect(hasScope(actor, scope)).toBe(false);
  for (const scope of ["write", "claim", "admin"] as const)
    expect(hasScope({ ...actor, scopes: [scope] }, "read")).toBe(true);
  expect(hasScope({ ...actor, scopes: [] }, "read")).toBe(false);
});

describe("session write limiter", () => {
  it("allows a burst up to the limit, then rejects with a retry hint until the window slides", () => {
    const limiter = createWriteLimiter(3, 1000);
    limiter.consume("alice", 0);
    limiter.consume("alice", 100);
    limiter.consume("alice", 200);
    expect(() => limiter.consume("alice", 300)).toThrowError(
      expect.objectContaining({ status: 429, code: "rate_limited" }),
    );
    expect(() => limiter.consume("bob", 300)).not.toThrow();
    expect(() => limiter.consume("alice", 1001)).not.toThrow();
  });
  it("holds at most its capacity of keys, dropping the least recently used", () => {
    const limiter = createWriteLimiter(1, 60_000, 2);
    limiter.consume("a", 0);
    limiter.consume("b", 1);
    limiter.consume("c", 2);
    expect(() => limiter.consume("a", 3)).not.toThrow();
    expect(() => limiter.consume("a", 4)).toThrowError(expect.objectContaining({ status: 429 }));
  });
});
