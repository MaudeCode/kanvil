// Plain-text Markdown edits shared by the formatting toolbar, its shortcuts, and interactive
// checklists. The text stays canonical Markdown; nothing here keeps a separate document model.

const listMarker = /^(?:[-*+] (?:\[[ xX]\] )?|\d+[.)] )/;
// Toolbar order. `key` matches a letter on any layout; `code` matches a digit row key under Shift.
export const formats = {
  heading: { label: "Heading", prefix: "### ", pattern: /^#{1,6} /, replaces: /^#{1,6} / },
  bold: { label: "Bold", shortcut: "⌘ B", key: "b", wrap: "**" },
  italic: { label: "Italic", shortcut: "⌘ I", key: "i", wrap: "_" },
  link: { label: "Link", help: "Link the selected text", shortcut: "⌘ K", key: "k" },
  bullets: {
    label: "Bulleted list",
    shortcut: "⌘ ⇧ 8",
    code: "Digit8",
    prefix: "- ",
    pattern: /^[-*+] (?!\[[ xX]\] )/,
    replaces: listMarker,
  },
  numbers: {
    label: "Numbered list",
    shortcut: "⌘ ⇧ 7",
    code: "Digit7",
    prefix: "1. ",
    pattern: /^\d+[.)] /,
    replaces: listMarker,
  },
  tasks: {
    label: "Checklist",
    shortcut: "⌘ ⇧ 9",
    code: "Digit9",
    prefix: "- [ ] ",
    pattern: /^[-*+] \[[ xX]\] /,
    replaces: listMarker,
  },
  code: { label: "Code block", shortcut: "⌘ E", key: "e", fence: "```" },
} as const;
export type MarkdownFormat = keyof typeof formats;
export const markdownFormats = Object.keys(formats).filter(
  (format): format is MarkdownFormat => format in formats,
);

export function shortcutFormat(event: {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return undefined;
  return markdownFormats.find((format) => {
    const spec = formats[format];
    if ("key" in spec) return !event.shiftKey && event.key.toLowerCase() === spec.key;
    return "code" in spec && event.shiftKey && event.code === spec.code;
  });
}

// The text replacing `from`..`to` and the selection to restore afterwards.
export type MarkdownEdit = { from: number; to: number; text: string; start: number; end: number };

export function formatMarkdown(
  value: string,
  start: number,
  end: number,
  format: MarkdownFormat,
): MarkdownEdit {
  const selected = value.slice(start, end);
  const spec = formats[format];
  if (format === "link") {
    // The selection becomes the link text; the placeholder address is selected for typing over.
    return { from: start, to: end, text: `[${selected}](url)`, start: end + 3, end: end + 6 };
  }
  if ("wrap" in spec) {
    const mark = spec.wrap,
      size = mark.length;
    if (value.slice(start - size, start) === mark && value.slice(end, end + size) === mark)
      return {
        from: start - size,
        to: end + size,
        text: selected,
        start: start - size,
        end: end - size,
      };
    if (selected.length >= 2 * size && selected.startsWith(mark) && selected.endsWith(mark)) {
      const text = selected.slice(size, -size);
      return { from: start, to: end, text, start, end: start + text.length };
    }
    return {
      from: start,
      to: end,
      text: mark + selected + mark,
      start: start + size,
      end: end + size,
    };
  }
  // Line formats act on every line the selection touches.
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = value.indexOf("\n", end > start && value[end - 1] === "\n" ? end - 1 : end);
  const to = lineEnd < 0 ? value.length : lineEnd;
  const block = value.slice(from, to),
    lines = block.split("\n");
  if ("fence" in spec) {
    if (lines.length > 1 && lines[0]?.startsWith(spec.fence) && lines.at(-1) === spec.fence) {
      const text = lines.slice(1, -1).join("\n");
      return { from, to, text, start: from, end: from + text.length };
    }
    const inner = from + spec.fence.length + 1;
    return {
      from,
      to,
      text: `${spec.fence}\n${block}\n${spec.fence}`,
      start: inner,
      end: inner + block.length,
    };
  }
  if (!("prefix" in spec)) return { from: start, to: end, text: selected, start, end };
  const parts = lines.map((line) => {
    const rest = line.trimStart();
    return { indent: line.slice(0, line.length - rest.length), rest };
  });
  const content = parts.filter(({ rest }) => rest);
  const remove = content.length > 0 && content.every(({ rest }) => spec.pattern.test(rest));
  let number = 0;
  const text = parts
    .map(({ indent, rest }) => {
      if (remove) return indent + rest.replace(spec.pattern, "");
      if (!rest && content.length) return indent;
      number += 1;
      const prefix = format === "numbers" ? `${number}. ` : spec.prefix;
      return indent + prefix + rest.replace(spec.replaces, "");
    })
    .join("\n");
  if (start === end && lines.length === 1) {
    const caret = Math.max(from, start + text.length - block.length);
    return { from, to, text, start: caret, end: caret };
  }
  return { from, to, text, start: from, end: from + text.length };
}

// The checklist item whose list marker starts at `offset`, checked or cleared. Resolving by source
// offset keeps duplicate labels and nested lists apart.
export function toggleTask(source: string, offset: number, checked: boolean) {
  const match = /^(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\]/.exec(source.slice(offset));
  if (!match) return source;
  const box = offset + match[0].length - 2;
  return source.slice(0, box) + (checked ? "x" : " ") + source.slice(box + 1);
}
