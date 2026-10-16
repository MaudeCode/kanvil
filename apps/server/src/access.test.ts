import { describe, expect, it } from "vite-plus/test";
import { createWriteLimiter } from "./access.ts";

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
});
