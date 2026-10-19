// The visual editor's document model. Markdown stays canonical: the editor reads and writes the same
// string, and `canEditVisually` keeps text the model cannot represent in the raw editor.
import type { AnyExtension } from "@tiptap/core";
import { MarkdownManager, Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { HardBreak } from "@tiptap/extension-hard-break";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { Image } from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extensions";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { mentionScheme } from "@kanvil/contracts";
import { lowlight } from "./highlight.ts";

export function richTextExtensions({
  placeholder = "",
  extra = [],
}: { placeholder?: string; extra?: AnyExtension[] } = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      codeBlock: false,
      hardBreak: false,
      link: {
        openOnClick: false,
        // Mentions are links to `mention:<user id>`; everything else follows the default rules.
        isAllowedUri: (url, { defaultValidate }) =>
          url.startsWith(mentionScheme) || defaultValidate(url),
      },
    }),
    // ⌘↵ submits the surrounding form, so only ⇧↵ inserts a line break.
    HardBreak.extend({
      addKeyboardShortcuts() {
        return { "Shift-Enter": () => this.editor.commands.setHardBreak() };
      },
    }),
    CodeBlockLowlight.configure({ lowlight }),
    TaskList,
    // The checkbox is named after its item, like the rendered checklist's.
    TaskItem.configure({ nested: true, a11y: { checkboxLabel: (node) => node.textContent } }),
    TableKit.configure({ table: { resizable: false } }),
    Image.configure({ allowBase64: false }),
    Placeholder.configure({ placeholder }),
    Markdown,
    ...extra,
  ];
}

const manager = new MarkdownManager({ extensions: richTextExtensions() }),
  parser = unified().use(remarkParse).use(remarkGfm);
// The Markdown syntax tree without source positions: two texts with equal trees render the same.
const tree = (markdown: string) =>
  JSON.stringify(parser.parse(markdown), (key, value: unknown) =>
    key === "position" ? undefined : value,
  );
const verdicts = new Map<string, boolean>();
// Whether the visual editor can load and save this text without changing what it renders. Raw HTML,
// footnotes, and other syntax it has no node for make this false.
export function canEditVisually(markdown: string) {
  const known = verdicts.get(markdown);
  if (known !== undefined) return known;
  let verdict = false;
  try {
    verdict = tree(markdown) === tree(manager.serialize(manager.parse(markdown)));
  } catch {
    /* Text the model cannot parse stays in the raw editor. */
  }
  if (verdicts.size > 50) verdicts.clear();
  verdicts.set(markdown, verdict);
  return verdict;
}
// The editor's Markdown without the blank lines its trailing empty paragraph and leading tables add.
export const editorMarkdown = (editor: { getMarkdown: () => string }) =>
  editor.getMarkdown().replace(/^\n+/, "").replace(/\n+$/, "");
