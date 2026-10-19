// Syntax highlighting shared by the Markdown renderer and the visual editor's code blocks. Loaded on
// demand: the grammars are only needed once a fenced block names its language.
import { common, createLowlight } from "lowlight";

export const lowlight = createLowlight(common);

export type HighlightNode =
  | { type: "text"; value: string }
  | { type: "element"; className: string[]; children: HighlightNode[] };
// Highlighted spans for `code`, or null for a language without a grammar.
export function highlight(code: string, language: string): HighlightNode[] | null {
  if (!lowlight.registered(language)) return null;
  const visit = (
    node: ReturnType<typeof lowlight.highlight>["children"][number],
  ): HighlightNode[] =>
    node.type === "text"
      ? [{ type: "text", value: node.value }]
      : node.type === "element"
        ? [
            {
              type: "element",
              className: node.properties.className ?? [],
              children: node.children.flatMap(visit),
            },
          ]
        : [];
  return lowlight.highlight(language, code).children.flatMap(visit);
}
