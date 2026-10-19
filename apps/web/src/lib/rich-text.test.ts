import { describe, expect, it } from "vite-plus/test";
import { canEditVisually } from "./rich-text.ts";

describe("canEditVisually", () => {
  it("accepts the Markdown the visual editor represents", () => {
    for (const text of [
      "",
      "# Title\n\nSome **bold**, _italic_, `code`, ~~gone~~ and [a link](https://example.test).",
      "- one\n- two\n  - nested\n\n1. first\n2. second",
      "- [ ] open\n- [x] done\n  - [ ] nested task",
      "```ts\nconst answer = 42;\n```\n\n```mermaid\nflowchart LR\n  A --> B\n```",
      "> quoted\n\n---\n\n| Name | Count |\n| --- | --- |\n| a | 1 |",
      "![diagram.png](/api/v1/projects/p/attachments/a/content)",
      "Ping [@Ada Lovelace](mention:user-1) about https://example.test",
      "line one  \nline two",
    ])
      expect(canEditVisually(text), text).toBe(true);
  });
  it("keeps text it would change in the raw editor", () => {
    for (const text of [
      "<details><summary>Logs</summary>kept</details>",
      "A claim[^1]\n\n[^1]: The source.",
      "Inline <kbd>Ctrl</kbd> HTML",
      "[reference link][ref]\n\n[ref]: https://example.test",
    ])
      expect(canEditVisually(text), text).toBe(false);
  });
});
