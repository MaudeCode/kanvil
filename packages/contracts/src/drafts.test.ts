import { expect, it } from "vite-plus/test";
import { parseCustomFieldDraft } from "./drafts.ts";

it("accepts completed numeric drafts and refuses incomplete numbers without changing the value contract", () => {
  const field = { type: "number" as const, options: [] };
  expect(parseCustomFieldDraft(field, "-12.5")).toBe(-12.5);
  expect(parseCustomFieldDraft(field, "0")).toBe(0);
  expect(parseCustomFieldDraft(field, "")).toBeNull();
  expect(() => parseCustomFieldDraft(field, "-")).toThrow();
  expect(() => parseCustomFieldDraft(field, "1.2.3")).toThrow();
});
