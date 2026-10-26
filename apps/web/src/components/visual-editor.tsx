import { useEffect, useRef, useState, type ReactNode } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { Extension, type ChainedCommands, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { Suggestion, exitSuggestion, type SuggestionProps } from "@tiptap/suggestion";
import {
  BetweenHorizontalEnd,
  BetweenVerticalEnd,
  Grid2x2X,
  Minus,
  Paperclip,
  Table,
  TableColumnsSplit,
  TableRowsSplit,
  TextQuote,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { t } from "@kanvil/contracts/i18n";
import { InputGroup } from "@/components/ui/input-group";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { IconButton, Input } from "../ui.tsx";
import {
  canEditVisually,
  editorMarkdown,
  markdownLimit,
  richTextExtensions,
} from "../lib/rich-text.ts";
import { formats, markdownFormats, shortcutFormat, type MarkdownFormat } from "../lib/markdown.ts";
import {
  FormatToolbar,
  SuggestionList,
  droppedFiles,
  formatIcon,
  matchMembers,
  memberOption,
  useFileInsert,
  useSuggestions,
  type InlineUpload,
  type Member,
} from "./markdown-field.tsx";
import { submitForm } from "../forms.ts";
import { cn } from "@/lib/utils";

type Props = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  rows: number;
  maxLength: number;
  flush: boolean;
  groupClassName: string | undefined;
  footer: ReactNode;
  members?: Member[];
  onUpload?: InlineUpload;
  // Called when the text uses Markdown this editor cannot keep; the field returns to Write.
  onUnsupported: () => void;
};
// The visual mode of `MarkdownField`. It edits the same canonical Markdown string: loading parses
// it, every edit serializes it back, and switching modes alone never rewrites the text.
export default function VisualEditor(props: Props) {
  const [supported] = useState(() => canEditVisually(props.value));
  const { onUnsupported } = props;
  useEffect(() => {
    if (!supported) onUnsupported();
  }, [supported, onUnsupported]);
  return supported ? <VisualEditorBody {...props} /> : null;
}

const toggles: Record<MarkdownFormat, (chain: ChainedCommands) => ChainedCommands> = {
  heading: (chain) => chain.toggleHeading({ level: 3 }),
  bold: (chain) => chain.toggleBold(),
  italic: (chain) => chain.toggleItalic(),
  link: (chain) => chain,
  bullets: (chain) => chain.toggleBulletList(),
  numbers: (chain) => chain.toggleOrderedList(),
  tasks: (chain) => chain.toggleTaskList(),
  code: (chain) => chain.toggleCodeBlock(),
};
const activeNames: Record<MarkdownFormat, string> = {
  heading: "heading",
  bold: "bold",
  italic: "italic",
  link: "link",
  bullets: "bulletList",
  numbers: "orderedList",
  tasks: "taskList",
  code: "codeBlock",
};
// Blocks the `/` menu inserts: the toolbar's block formats, then the ones only this editor has.
// Labels are getters, so they read the interface language when shown.
type Block = { key: string; label: string; icon: LucideIcon; run: (editor: Editor) => void };
const extraBlocks: Block[] = [
  {
    key: "quote",
    get label() {
      return t("detail.markdown.block.quote");
    },
    icon: TextQuote,
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    key: "table",
    get label() {
      return t("detail.markdown.block.table");
    },
    icon: Table,
    run: (editor) =>
      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    key: "diagram",
    get label() {
      return t("detail.markdown.block.diagram");
    },
    icon: Workflow,
    run: (editor) =>
      editor
        .chain()
        .focus()
        .insertContent({
          type: "codeBlock",
          attrs: { language: "mermaid" },
          content: [{ type: "text", text: "flowchart LR\n  A --> B" }],
        })
        .run(),
  },
  {
    key: "divider",
    get label() {
      return t("detail.markdown.block.divider");
    },
    icon: Minus,
    run: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
];
const tableActions = [
  {
    key: "addRow",
    icon: BetweenHorizontalEnd,
    run: (chain: ChainedCommands) => chain.addRowAfter(),
  },
  {
    key: "addColumn",
    icon: BetweenVerticalEnd,
    run: (chain: ChainedCommands) => chain.addColumnAfter(),
  },
  { key: "deleteRow", icon: TableRowsSplit, run: (chain: ChainedCommands) => chain.deleteRow() },
  {
    key: "deleteColumn",
    icon: TableColumnsSplit,
    run: (chain: ChainedCommands) => chain.deleteColumn(),
  },
  { key: "deleteTable", icon: Grid2x2X, run: (chain: ChainedCommands) => chain.deleteTable() },
] as const;
type Menu = { kind: "slash" | "mention"; query: string; range: Range; rect: () => DOMRect | null };
const menuKeys = { slash: new PluginKey("slash-menu"), mention: new PluginKey("mention-menu") };

function VisualEditorBody({
  id,
  label,
  value,
  onChange,
  placeholder,
  rows,
  maxLength,
  flush,
  groupClassName,
  footer,
  members,
  onUpload,
  onUnsupported,
}: Props) {
  // Distinct from the Write textarea's ID, which may still be mounted while the tabs switch.
  const editorId = `${id}-visual`;
  const [menu, setMenu] = useState<Menu | null>(null),
    [linking, setLinking] = useState<{ href: string; rect: DOMRect } | null>(null);
  // The latest props and handlers for editor callbacks, which the editor captures once.
  const latest = useRef<{
    onChange: (value: string) => void;
    keyDown: (event: KeyboardEvent) => boolean;
    files: (files: File[]) => boolean;
  }>({ onChange, keyDown: () => false, files: () => false });
  // The text this editor last produced, so a parent echo of it is not loaded back in.
  const emitted = useRef(value);
  // Created once: the editor keeps the extensions it starts with.
  const [extensions] = useState(() => {
    const suggestions = Extension.create({
      name: "suggestionMenus",
      addProseMirrorPlugins() {
        return (["slash", "mention"] as const).map((kind) => {
          const show = (next: SuggestionProps) =>
            setMenu({
              kind,
              query: next.query,
              range: next.range,
              rect: () => next.clientRect?.() ?? null,
            });
          return Suggestion({
            editor: this.editor,
            pluginKey: menuKeys[kind],
            char: kind === "slash" ? "/" : "@",
            // Code keeps `/` and `@` as typed.
            allow: ({ state }) => !state.selection.$from.parent.type.spec.code,
            render: () => ({ onStart: show, onUpdate: show, onExit: () => setMenu(null) }),
          });
        });
      },
    });
    return richTextExtensions({ placeholder, extra: [suggestions, markdownLimit(maxLength)] });
  });
  const editor = useEditor({
    extensions,
    content: value,
    contentType: "markdown",
    editorProps: {
      attributes: {
        id: editorId,
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
        "data-slot": "input-group-control",
        class: cn(
          "markdown min-h-[var(--rows)] w-full max-w-none px-3 py-2.5 outline-none caret-primary",
          flush && "px-1 py-3 text-base leading-7",
        ),
        style: `--rows: ${rows * (flush ? 1.75 : 1.5)}rem`,
      },
      handleKeyDown: (_view, event) => latest.current.keyDown(event),
      handlePaste: (_view, event) => latest.current.files(droppedFiles(event.clipboardData)),
      handleDrop: (_view, event) => latest.current.files(droppedFiles(event.dataTransfer)),
    },
    onUpdate: ({ editor: current }) => {
      const markdown = editorMarkdown(current);
      emitted.current = markdown;
      latest.current.onChange(markdown);
    },
  });
  // A parent change, such as discarding a draft or clearing a posted comment, loads the new text.
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    if (!canEditVisually(value)) onUnsupported();
    else editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
  }, [editor, value, onUnsupported]);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      active: markdownFormats.filter((format) => current.isActive(activeNames[format])),
      table: current.isActive("table"),
      empty: current.state.selection.empty,
    }),
  });
  const upload = useFileInsert(label, onUpload, (markdown) => {
    editor.chain().focus().insertContent(markdown, { contentType: "markdown" }).run();
  });
  const blocks: Block[] = [
    ...(["heading", "bullets", "numbers", "tasks", "code"] as const).map((format) => ({
      key: format,
      label: formats[format].label,
      icon: formatIcon(format),
      run: (current: Editor) => {
        toggles[format](current.chain().focus()).run();
      },
    })),
    ...extraBlocks,
    ...(onUpload
      ? [
          {
            key: "file",
            label: t("detail.markdown.block.file"),
            icon: Paperclip,
            run: upload.pick,
          },
        ]
      : []),
  ];
  const query = menu?.query.toLowerCase() ?? "";
  const options =
    menu?.kind === "mention"
      ? matchMembers(members ?? [], query).map(memberOption)
      : menu?.kind === "slash"
        ? blocks
            .filter((block) => block.label.toLowerCase().includes(query))
            .map((block) => ({
              key: block.key,
              content: (
                <span className="flex items-center gap-2">
                  <block.icon className="size-4 text-muted-foreground" aria-hidden="true" />
                  {block.label}
                </span>
              ),
            }))
        : [];
  const list = useSuggestions(options.map((option) => option.key)),
    listId = `${id}-suggestions`,
    open = !!menu && options.length > 0 && (menu.kind === "slash" || !!members);
  const dismiss = () => {
    if (menu) exitSuggestion(editor.view, menuKeys[menu.kind]);
    setMenu(null);
  };
  // The list belongs to the editable element, which keeps focus while it is open.
  useEffect(() => {
    // By ID: the editor view mounts after this component's first effects run.
    const element = document.getElementById(editorId);
    if (!element) return;
    const attributes = {
      "aria-autocomplete": "list",
      "aria-controls": open ? listId : null,
      "aria-activedescendant": open && list.active ? `${listId}-${list.active}` : null,
    };
    for (const [name, next] of Object.entries(attributes))
      if (next) element.setAttribute(name, next);
      else element.removeAttribute(name);
  }, [editorId, open, listId, list.active]);
  const choose = (key: string) => {
    if (!menu) return;
    const range = menu.range;
    setMenu(null);
    if (menu.kind === "mention") {
      const person = members?.find((item) => item.userId === key);
      if (!person) return;
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: "text",
            text: `@${person.name}`,
            marks: [{ type: "link", attrs: { href: `mention:${person.userId}` } }],
          },
          { type: "text", text: " " },
        ])
        .run();
      return;
    }
    editor.chain().focus().deleteRange(range).run();
    blocks.find((block) => block.key === key)?.run(editor);
  };
  const openLink = () => {
    const { from } = editor.state.selection,
      at = editor.view.coordsAtPos(from);
    setLinking({
      href: String(editor.getAttributes("link").href ?? ""),
      rect: new DOMRect(at.left, at.top, 0, at.bottom - at.top),
    });
  };
  const apply = (format: MarkdownFormat) => {
    if (format === "link") openLink();
    else toggles[format](editor.chain().focus()).run();
  };
  useEffect(() => {
    latest.current = {
      onChange,
      // Takes a paste or drop only when it carries files and this field accepts them.
      files: (files) => {
        if (!files.length || !onUpload) return false;
        void upload.send(files);
        return true;
      },
      keyDown: (event) => {
        if (open && list.handleKey(event, choose, dismiss)) {
          // Keeps Escape from also closing a surrounding sheet or dialog.
          event.stopPropagation();
          return true;
        }
        // The editor claims every Enter, so ⌘↵ submits the surrounding form from here.
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
          submitForm(editor.view.dom.closest("form"));
          return true;
        }
        const format = shortcutFormat(event);
        // ⌘K with nothing selected stays the command palette.
        if (!format || (format === "link" && editor.state.selection.empty)) return false;
        // Keeps ⌘B and ⌘K from also reaching the sidebar and palette shortcuts.
        event.stopPropagation();
        apply(format);
        return true;
      },
    };
  });
  return (
    <InputGroup className={groupClassName}>
      <FormatToolbar
        label={label}
        flush={flush}
        onApply={apply}
        pressed={(format) => state.active.includes(format)}
        {...(onUpload ? { upload } : {})}
      >
        {state.table &&
          tableActions.map((action) => (
            <IconButton
              key={action.key}
              label={t(`detail.markdown.table.${action.key}`)}
              size="icon-sm"
              tabIndex={-1}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => action.run(editor.chain().focus()).run()}
            >
              <action.icon />
            </IconButton>
          ))}
      </FormatToolbar>
      <EditorContent editor={editor} className="w-full" />
      <SuggestionList
        id={listId}
        label={
          menu?.kind === "mention" ? t("detail.markdown.mention") : t("detail.markdown.insertBlock")
        }
        open={open}
        anchor={{ getBoundingClientRect: () => menu?.rect() ?? new DOMRect() }}
        options={options}
        active={list.active}
        onHighlight={list.setHighlight}
        onChoose={choose}
        onDismiss={dismiss}
      />
      <Popover
        open={!!linking}
        onOpenChange={(next) => {
          if (!next) setLinking(null);
        }}
      >
        <PopoverContent
          anchor={{ getBoundingClientRect: () => linking?.rect ?? new DOMRect() }}
          align="start"
          className="w-[min(22rem,calc(100vw-2rem))] p-3"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              // The popover's form must not submit the ticket or comment around the editor.
              event.stopPropagation();
              const href = linking?.href.trim() ?? "";
              const chain = editor.chain().focus().extendMarkRange("link");
              if (!href) chain.unsetLink().run();
              else if (state.empty && !editor.isActive("link"))
                chain
                  .insertContent({
                    type: "text",
                    text: href,
                    marks: [{ type: "link", attrs: { href } }],
                  })
                  .run();
              else chain.setLink({ href }).run();
              setLinking(null);
            }}
          >
            <Input
              label={t("detail.markdown.linkAddress")}
              labelHidden
              placeholder="https://"
              value={linking?.href ?? ""}
              onChange={(event) => linking && setLinking({ ...linking, href: event.target.value })}
              autoFocus
            />
          </form>
        </PopoverContent>
      </Popover>
      {footer}
    </InputGroup>
  );
}
