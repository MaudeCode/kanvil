import { markdownIcons } from "@kanvil/contracts/icons";
import {
  lazy,
  Suspense,
  useCallback,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { mentionLink, type Output } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import {
  Bold,
  Heading,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Paperclip,
  SquareCode,
  type LucideIcon,
} from "lucide-react";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupTextarea, InputGroupAddon } from "@/components/ui/input-group";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { commandItemClass } from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import { IconButton, Loading, Markdown, reportError } from "../ui.tsx";
import { api } from "../data.tsx";
import { preferences, usePreference } from "../hooks/use-preference.ts";
import { UserIdentity } from "./user-avatar.tsx";
import {
  fileMarkdown,
  formatMarkdown,
  formats,
  markdownFormats,
  shortcutFormat,
  type MarkdownFormat,
} from "../lib/markdown.ts";
import { cn } from "@/lib/utils";

// The visual editor and its grammars load the first time someone opens the Visual tab.
const VisualEditor = lazy(() => import("./visual-editor.tsx"));

const markdownGlyphs = {
  heading: Heading,
  bold: Bold,
  italic: Italic,
  link: Link,
  list: List,
  "list-ordered": ListOrdered,
  "list-checks": ListChecks,
  "square-code": SquareCode,
};
export const formatIcon = (format: MarkdownFormat): LucideIcon =>
  markdownGlyphs[markdownIcons[format]];
// Stores a file the person dropped, pasted, or picked, and returns the address Markdown embeds.
export type InlineUpload = (
  file: File,
) => Promise<{ url: string; name: string; contentType: string }>;
export type Member = Output<"list_members">[number];

// The `@name` being typed at the caret: an `@` that starts a word, then no spaces or brackets.
function typedMention(text: string, caret: number) {
  const match = /(?:^|[\s([{])@([^\s@[\]()]{0,40})$/.exec(text.slice(0, caret));
  return match?.[1] === undefined ? null : { from: caret - match[1].length - 1, query: match[1] };
}
export const matchMembers = (members: Member[], query: string) =>
  members
    .filter((person) =>
      `${person.name} ${person.email}`.toLowerCase().includes(query.toLowerCase()),
    )
    .slice(0, 8);
export const memberOption = (person: Member) => ({
  key: person.userId,
  content: <UserIdentity name={person.name} email={person.email} image={person.image} />,
});
export const mentionText = (person: Member) => mentionLink(person.name, person.userId);

// The highlighted option of an open suggestion list and its keyboard handling. Both editors call
// `handleKey` first, so arrows, ↵, ⇥, and Esc act on the list while it is open.
export function useSuggestions(keys: string[]) {
  const [highlight, setHighlight] = useState("");
  const active = keys.includes(highlight) ? highlight : keys[0];
  const handleKey = (
    event: Pick<globalThis.KeyboardEvent, "key" | "isComposing" | "preventDefault">,
    choose: (key: string) => void,
    dismiss: () => void,
  ) => {
    if (!active || event.isComposing) return false;
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (!step && !["Enter", "Tab", "Escape"].includes(event.key)) return false;
    event.preventDefault();
    const at = keys.indexOf(active);
    if (step) setHighlight(keys[(at + step + keys.length) % keys.length] ?? "");
    else if (event.key === "Escape") dismiss();
    else choose(active);
    return true;
  };
  return { active, setHighlight, handleKey };
}
// A listbox under the caret for mentions and block commands. Focus stays in the editor, which
// points `aria-activedescendant` at the highlighted option.
export function SuggestionList({
  id,
  label,
  open,
  anchor,
  options,
  active,
  onHighlight,
  onChoose,
  onDismiss,
}: {
  id: string;
  label: string;
  open: boolean;
  anchor: RefObject<Element | null> | { getBoundingClientRect: () => DOMRect };
  options: { key: string; content: ReactNode }[];
  active: string | undefined;
  onHighlight: (key: string) => void;
  onChoose: (key: string) => void;
  onDismiss: () => void;
}) {
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <PopoverContent
        anchor={anchor}
        align="start"
        initialFocus={false}
        finalFocus={false}
        className="w-[min(20rem,calc(100vw-2rem))] p-1"
      >
        <div role="listbox" id={id} aria-label={label}>
          {options.map((option) => (
            <div
              key={option.key}
              role="option"
              id={`${id}-${option.key}`}
              aria-selected={option.key === active}
              data-selected={option.key === active || undefined}
              className={commandItemClass}
              // Keeps focus, and so the caret, in the editor.
              onMouseDown={(event) => event.preventDefault()}
              onPointerMove={() => onHighlight(option.key)}
              onClick={() => onChoose(option.key)}
            >
              {option.content}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
// Uploads files one at a time and inserts each one's Markdown where the caret is when it finishes.
// A failed file is reported and skipped; the rest still upload. `input` is the hidden file picker
// that `pick` opens.
export function useFileInsert(
  label: string,
  onUpload: InlineUpload | undefined,
  insert: (markdown: string) => void,
) {
  const [pending, setPending] = useState(0),
    picker = useRef<HTMLInputElement>(null);
  const send = async (files: File[]) => {
    if (!onUpload || !files.length) return;
    setPending((count) => count + files.length);
    for (const file of files)
      try {
        insert(fileMarkdown(await onUpload(file)));
      } catch (error) {
        reportError(error);
      } finally {
        setPending((count) => count - 1);
      }
  };
  const input = (
    <input
      ref={picker}
      type="file"
      multiple
      hidden
      aria-label={t("detail.markdown.insertFileInto", { label })}
      onChange={(event) => {
        const files = [...(event.target.files ?? [])];
        event.target.value = "";
        void send(files);
      }}
    />
  );
  return { uploading: pending > 0, send, pick: () => picker.current?.click(), input };
}
// The formatting toolbar both editors share; `pressed` reports formats active at the caret.
export function FormatToolbar({
  label,
  flush,
  onApply,
  pressed,
  upload,
  children,
}: {
  label: string;
  // Document fields drop the toolbar's side padding to line up with their text.
  flush: boolean;
  onApply: (format: MarkdownFormat) => void;
  pressed?: (format: MarkdownFormat) => boolean;
  upload?: ReturnType<typeof useFileInsert>;
  children?: ReactNode;
}) {
  return (
    <InputGroupAddon
      align="block-start"
      role="toolbar"
      aria-label={t("detail.markdown.formatting", { label })}
      className={cn(
        "gap-0.5 overflow-x-auto border-b py-1 pl-1 text-foreground [scrollbar-width:none] max-md:gap-0 max-md:px-0",
        flush && "px-0",
      )}
      onKeyDown={(event) => {
        // Arrow keys move between the buttons, so the toolbar is one tab stop.
        const buttons = [...event.currentTarget.querySelectorAll("button")],
          index = buttons.findIndex((button) => button === document.activeElement),
          step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
        const target =
          event.key === "Home"
            ? buttons[0]
            : event.key === "End"
              ? buttons.at(-1)
              : step && buttons.at((index + step) % buttons.length);
        if (!target) return;
        event.preventDefault();
        target.focus();
      }}
    >
      {markdownFormats.map((format, index) => {
        const spec = formats[format],
          Icon = formatIcon(format);
        return (
          <IconButton
            key={format}
            label={spec.label}
            {...("shortcut" in spec ? { shortcut: spec.shortcut } : {})}
            {...(pressed ? { "aria-pressed": pressed(format) } : {})}
            size="icon-sm"
            tabIndex={index === 0 ? 0 : -1}
            className="text-muted-foreground hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
            onClick={() => onApply(format)}
          >
            <Icon />
          </IconButton>
        );
      })}
      {upload && (
        <>
          <IconButton
            label={
              upload.uploading ? t("detail.resource.uploading") : t("detail.markdown.insertFile")
            }
            size="icon-sm"
            tabIndex={-1}
            disabled={upload.uploading}
            className="text-muted-foreground hover:text-foreground"
            onClick={upload.pick}
          >
            {upload.uploading ? <Spinner /> : <Paperclip />}
          </IconButton>
          {upload.input}
        </>
      )}
      {children}
    </InputGroupAddon>
  );
}
// Files from a paste or drop, when it carries files rather than text.
export function droppedFiles(data: DataTransfer | null) {
  return data?.files.length ? [...data.files] : [];
}

export function MarkdownField({
  label,
  value,
  onChange,
  placeholder,
  rows = 5,
  variant = "compact",
  maxLength = 100000,
  required = false,
  footer,
  mentions,
  onUpload,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  variant?: "compact" | "document";
  maxLength?: number;
  required?: boolean;
  footer?: ReactNode;
  // Typing `@` offers this project's members and inserts a mention link.
  mentions?: string;
  // Pasting, dropping, or picking files uploads them and embeds them in the text.
  onUpload?: InlineUpload;
}) {
  const id = useId(),
    field = useRef<HTMLTextAreaElement>(null);
  const [preferred, setPreferred] = usePreference(preferences.editor),
    [previewing, setPreviewing] = useState(false),
    // Set when the visual editor cannot keep this text; the field stays in Write until the person
    // picks Visual again.
    [unsupported, setUnsupported] = useState(false);
  const mode = previewing ? "preview" : preferred === "visual" && !unsupported ? "visual" : "write";
  const members = useQuery({
    ...api.query("list_members", { projectId: mentions ?? "" }),
    enabled: !!mentions,
  });
  const [caret, setCaret] = useState(0),
    [dismissed, setDismissed] = useState<number | null>(null);
  const typed = mentions ? typedMention(value, caret) : null;
  const matches = matchMembers(members.data ?? [], typed?.query ?? "");
  const suggestions = useSuggestions(matches.map((person) => person.userId));
  const suggesting = !!typed && typed.from !== dismissed && matches.length > 0,
    listId = `${id}-mentions`;
  const insert = (edit: { from: number; to: number; text: string; start: number; end: number }) => {
    const element = field.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(edit.from, edit.to);
    // insertText keeps the edit on the browser's own undo stack; the fallback cannot.
    if (!document.execCommand("insertText", false, edit.text)) {
      element.setRangeText(edit.text);
      onChange(element.value);
    }
    element.setSelectionRange(edit.start, edit.end);
    setCaret(edit.end);
  };
  const apply = (format: MarkdownFormat) => {
    const element = field.current;
    if (element)
      insert(formatMarkdown(element.value, element.selectionStart, element.selectionEnd, format));
  };
  const mention = (userId: string) => {
    const person = matches.find((item) => item.userId === userId);
    if (!typed || !person) return;
    const text = `${mentionText(person)} `,
      end = typed.from + text.length;
    insert({ from: typed.from, to: caret, text, start: end, end });
  };
  const upload = useFileInsert(label, onUpload, (markdown) => {
    const element = field.current;
    if (!element) return;
    const end = element.selectionEnd + markdown.length;
    insert({
      from: element.selectionStart,
      to: element.selectionEnd,
      text: markdown,
      start: end,
      end,
    });
  });
  const takeFiles = (event: ClipboardEvent | DragEvent, data: DataTransfer | null) => {
    const files = onUpload ? droppedFiles(data) : [];
    if (!files.length) return;
    event.preventDefault();
    void upload.send(files);
  };
  const fallBack = useCallback(() => setUnsupported(true), []);
  const groupClass =
    variant === "document"
      ? "rounded-none border-0 bg-transparent dark:bg-transparent has-[[data-slot=input-group-control]:focus-visible]:ring-0"
      : undefined;
  const footerAddon = footer && (
    <InputGroupAddon align="block-end" className="justify-end border-t py-2">
      {footer}
    </InputGroupAddon>
  );
  return (
    <Field
      className={cn(
        "mb-6 [&_[data-slot=tabs-list]]:shrink-0 [&_[data-slot=tabs-trigger]]:text-xs",
        variant === "compact" &&
          "[&_textarea]:field-sizing-fixed [&_textarea]:max-h-[28rem] [&_.ProseMirror]:max-h-[28rem] [&_.ProseMirror]:overflow-y-auto",
        variant === "document" &&
          "border-t pt-5 has-[[data-slot=input-group-control]:focus]:border-t-primary has-[[data-slot=input-group-control]:focus]:[&_[data-slot=field-label]]:text-primary",
      )}
      data-variant={variant}
      aria-label={t("detail.markdown.editor", { label })}
    >
      <Tabs
        value={mode}
        onValueChange={(next) => {
          setPreviewing(next === "preview");
          if (next === "write" || next === "visual") {
            setPreferred(next);
            setUnsupported(false);
          }
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <TabsList aria-label={t("detail.markdown.editor", { label })} variant="line">
            <TabsTrigger value="write">{t("detail.markdown.write")}</TabsTrigger>
            <TabsTrigger value="visual">{t("detail.markdown.visual")}</TabsTrigger>
            <TabsTrigger value="preview">{t("detail.markdown.preview")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="write">
          {unsupported && preferred === "visual" && (
            <p role="status" className="mb-2 text-xs text-muted-foreground">
              {t("detail.markdown.unsupported")}
            </p>
          )}
          <InputGroup className={groupClass}>
            <FormatToolbar
              label={label}
              flush={variant === "document"}
              onApply={apply}
              {...(onUpload ? { upload } : {})}
            />
            <InputGroupTextarea
              ref={field}
              id={id}
              className={
                variant === "document"
                  ? "field-sizing-content max-h-none resize-y px-1 py-3 text-base md:text-base leading-7 caret-primary"
                  : undefined
              }
              style={variant === "document" ? { minHeight: `${rows}lh` } : undefined}
              value={value}
              onChange={(event) => {
                setCaret(event.target.selectionStart);
                onChange(event.target.value);
              }}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
              onPaste={(event) => takeFiles(event, event.clipboardData)}
              onDragOver={(event) => {
                if (onUpload && event.dataTransfer.types.includes("Files")) event.preventDefault();
              }}
              onDrop={(event) => takeFiles(event, event.dataTransfer)}
              {...(mentions && {
                "aria-autocomplete": "list" as const,
                "aria-controls": suggesting ? listId : undefined,
                "aria-activedescendant":
                  suggesting && suggestions.active ? `${listId}-${suggestions.active}` : undefined,
              })}
              onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                if (
                  suggesting &&
                  suggestions.handleKey(event.nativeEvent, mention, () => setDismissed(typed.from))
                ) {
                  // Keeps Escape from also closing a surrounding sheet or dialog.
                  event.stopPropagation();
                  return;
                }
                const format = shortcutFormat(event);
                // ⌘K with nothing selected stays the command palette.
                if (
                  !format ||
                  (format === "link" &&
                    event.currentTarget.selectionStart === event.currentTarget.selectionEnd)
                )
                  return;
                event.preventDefault();
                // Keeps ⌘B and ⌘K from also reaching the sidebar and palette shortcuts.
                event.stopPropagation();
                apply(format);
              }}
              placeholder={placeholder}
              rows={rows}
              maxLength={maxLength}
              required={required}
            />
            {mentions && (
              <SuggestionList
                id={listId}
                label={t("detail.markdown.mention")}
                open={suggesting}
                anchor={field}
                options={matches.map(memberOption)}
                active={suggestions.active}
                onHighlight={suggestions.setHighlight}
                onChoose={mention}
                onDismiss={() => {
                  if (typed) setDismissed(typed.from);
                }}
              />
            )}
            {footerAddon}
          </InputGroup>
        </TabsContent>
        <TabsContent value="visual">
          <Suspense fallback={<Loading />}>
            <VisualEditor
              id={id}
              label={label}
              value={value}
              onChange={onChange}
              placeholder={placeholder ?? ""}
              rows={rows}
              maxLength={maxLength}
              flush={variant === "document"}
              groupClassName={groupClass}
              footer={footerAddon}
              {...(mentions ? { members: members.data ?? [] } : {})}
              {...(onUpload ? { onUpload } : {})}
              onUnsupported={fallBack}
            />
          </Suspense>
        </TabsContent>
        <TabsContent value="preview">
          <div
            className={cn(
              "min-h-28 rounded-lg border bg-muted/20 p-4",
              variant === "document" &&
                "rounded-none border-0 bg-transparent px-1 py-3 text-base leading-7",
            )}
          >
            {value ? (
              <Markdown>{value}</Markdown>
            ) : (
              <p className="m-0 text-sm text-muted-foreground">
                {t("detail.markdown.nothingToPreview")}
              </p>
            )}
          </div>
          {footer && <div className="mt-2 flex justify-end">{footer}</div>}
        </TabsContent>
      </Tabs>
    </Field>
  );
}
