import { fromMarkdown } from "mdast-util-from-markdown";
import { mentionScheme } from "@kanvil/contracts";

type MarkdownNode = { type: string; url?: string; children?: MarkdownNode[] };
// The users a comment mentions, once each. Parsing the Markdown leaves code, escaped brackets, and
// lookalike text out, exactly as the renderers do. IDs are unverified; recipients are filtered later.
export function mentionedUserIds(markdown: string): string[] {
  const found = new Set<string>();
  const visit = (node: MarkdownNode) => {
    if (node.type === "link" && node.url?.startsWith(mentionScheme))
      found.add(node.url.slice(mentionScheme.length));
    node.children?.forEach(visit);
  };
  visit(fromMarkdown(markdown));
  return [...found];
}
