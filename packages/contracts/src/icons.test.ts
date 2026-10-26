import { expect, it } from "vite-plus/test";
import { loadProjectIcons, ticketSymbols, markdownIcons } from "./icons.ts";

it("resolves every shared ticket and formatting symbol to geometry in the installed library", async () => {
  const library = await loadProjectIcons();
  const names = [
    ...Object.values(ticketSymbols).flatMap((group) =>
      Object.values(group).map((entry) => entry.icon),
    ),
    ...Object.values(markdownIcons),
  ];
  for (const name of names)
    expect(library.icons[name]?.body, name).toMatch(/<(?:path|circle|rect|g|line)/);
});
