import { expect, it } from "vite-plus/test";
import { ticketBranch, ticketMarkdown } from "./ticket-copy.ts";
const ticket = {
  key: "KAN-7",
  title: "Add useful ticket copy actions",
  description: "Copy **title** and `code`.\n\n- [ ] keep Markdown\n",
  acceptanceCriteria: "1. Branch is safe\n2. Empty sections are omitted",
};
it("copies the key, title and original Markdown sections", () => {
  expect(ticketMarkdown(ticket)).toBe(
    [
      "# KAN-7: Add useful ticket copy actions",
      "## Description",
      "Copy **title** and `code`.\n\n- [ ] keep Markdown",
      "## Acceptance criteria",
      "1. Branch is safe\n2. Empty sections are omitted",
    ].join("\n\n") + "\n",
  );
  expect(ticketMarkdown({ ...ticket, description: " \n", acceptanceCriteria: "" })).toBe(
    "# KAN-7: Add useful ticket copy actions\n",
  );
});
it("derives a deterministic, bounded, git-safe branch name", () => {
  expect(ticketBranch(ticket)).toBe("KAN-7-add-useful-ticket-copy-actions");
  expect(ticketBranch({ key: "KAN-7", title: "Héllo wörld: a/b..c ~^:?*[\\ @{x}.lock" })).toBe(
    "KAN-7-hello-world-a-b-c-x-lock",
  );
  expect(ticketBranch({ key: "KAN-7", title: "🔥 ✨" })).toBe("KAN-7");
  const long = ticketBranch({ key: "KAN-7", title: "word ".repeat(40) });
  expect(long.length).toBeLessThanOrEqual(60);
  expect(long).toMatch(/^KAN-7-word(-word)*$/u);
  expect(ticketBranch({ key: "KAN-7", title: "word ".repeat(40) })).toBe(long);
  expect(ticketBranch({ key: "KAN-7", title: "a".repeat(100) })).toBe(`KAN-7-${"a".repeat(54)}`);
});
