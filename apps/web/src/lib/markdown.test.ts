import { expect, it } from "vite-plus/test";
import { formatMarkdown, shortcutFormat, toggleTask, type MarkdownFormat } from "./markdown.ts";

// Applies a format to `value` where `«` and `»` mark the selection, and marks the result the same way.
function format(marked: string, name: MarkdownFormat) {
  const start = marked.indexOf("«"),
    end = marked.indexOf("»") - 1,
    value = marked.replace("«", "").replace("»", "");
  const edit = formatMarkdown(value, start, end, name);
  const next = value.slice(0, edit.from) + edit.text + value.slice(edit.to);
  return `${next.slice(0, edit.start)}«${next.slice(edit.start, edit.end)}»${next.slice(edit.end)}`;
}

it("wraps and unwraps inline formats while keeping the selected text selected", () => {
  expect(format("say «word» now", "bold")).toBe("say **«word»** now");
  expect(format("say **«word»** now", "bold")).toBe("say «word» now");
  expect(format("say «**word**» now", "bold")).toBe("say «word» now");
  expect(format("say «word» now", "italic")).toBe("say _«word»_ now");
  expect(format("a «»b", "bold")).toBe("a **«»**b");
  expect(format("see «docs»", "link")).toBe("see [docs](«url»)");
  expect(format("see «»", "link")).toBe("see [](«url»)");
});

it("prefixes, replaces, and removes line formats across the selected lines", () => {
  expect(format("«one\ntwo»", "bullets")).toBe("«- one\n- two»");
  expect(format("«- one\n- two»", "bullets")).toBe("«one\ntwo»");
  expect(format("«one\n\ntwo»", "numbers")).toBe("«1. one\n\n2. two»");
  expect(format("«- one\n  - two»", "tasks")).toBe("«- [ ] one\n  - [ ] two»");
  expect(format("«- [x] one»", "tasks")).toBe("«one»");
  expect(format("«- [x] one»", "bullets")).toBe("«- one»");
  expect(format("## Ti«»tle", "heading")).toBe("Ti«»tle");
  expect(format("Ti«»tle", "heading")).toBe("### Ti«»tle");
  expect(format("«»", "tasks")).toBe("- [ ] «»");
  expect(format("keep\n«line\n»next", "bullets")).toBe("keep\n«- line»\nnext");
});

it("fences and unfences whole lines as a code block", () => {
  expect(format("a\nb«c»d\ne", "code")).toBe("a\n```\n«bcd»\n```\ne");
  expect(format("«```\nbcd\n```»", "code")).toBe("«bcd»");
  expect(format("«»", "code")).toBe("```\n«»\n```");
});

it("maps documented shortcuts to formats", () => {
  const key = { key: "", code: "", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
  expect(shortcutFormat({ ...key, key: "B" })).toBe("bold");
  expect(shortcutFormat({ ...key, key: "k", metaKey: false, ctrlKey: true })).toBe("link");
  expect(shortcutFormat({ ...key, key: "*", code: "Digit8", shiftKey: true })).toBe("bullets");
  expect(shortcutFormat({ ...key, key: "(", code: "Digit9", shiftKey: true })).toBe("tasks");
  expect(shortcutFormat({ ...key, key: "b", metaKey: false })).toBeUndefined();
  expect(shortcutFormat({ ...key, key: "b", shiftKey: true })).toBeUndefined();
});

it("toggles the checklist item at a source offset, not the first matching label", () => {
  const source = "- [ ] Ship it\n  - [ ] Ship it\n1. [X] Done\n* [ ] [ ] Literal";
  expect(toggleTask(source, source.indexOf("  - ") + 2, true)).toBe(
    "- [ ] Ship it\n  - [x] Ship it\n1. [X] Done\n* [ ] [ ] Literal",
  );
  expect(toggleTask(source, source.indexOf("1."), false)).toContain("1. [ ] Done");
  expect(toggleTask(source, source.indexOf("* "), true)).toContain("* [x] [ ] Literal");
  expect(toggleTask(source, 3, true)).toBe(source);
});
