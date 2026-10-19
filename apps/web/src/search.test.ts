import { describe, expect, it } from "vite-plus/test";
import { filterIdentity } from "./search.ts";

describe("saved view matching", () => {
  it("treats filter values as a set and single values as one-item lists", () => {
    expect(filterIdentity({ status: ["in_progress", "todo"] })).toBe(
      filterIdentity({ status: ["todo", "in_progress"], offset: 25 }),
    );
    expect(filterIdentity({ label: "bug" })).toBe(filterIdentity({ label: ["bug"] }));
    expect(filterIdentity({ status: ["todo"] })).not.toBe(filterIdentity({ statusNot: ["todo"] }));
  });
});
