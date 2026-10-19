import { useId, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { mentionLink } from "@kanvil/contracts";
import {
  Bold,
  Heading,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  SquareCode,
  type LucideIcon,
} from "lucide-react";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupTextarea, InputGroupAddon } from "@/components/ui/input-group";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { commandItemClass } from "@/components/ui/command";
import { IconButton, Markdown } from "../ui.tsx";
import { api } from "../data.tsx";
import { UserIdentity } from "./user-avatar.tsx";
import {
  formatMarkdown,
  formats,
  markdownFormats,
  shortcutFormat,
  type MarkdownFormat,
} from "../lib/markdown.ts";
import { cn } from "@/lib/utils";

const formatIcons: Record<MarkdownFormat, LucideIcon> = {
  heading: Heading,
  bold: Bold,
  italic: Italic,
  link: Link,
  bullets: List,
  numbers: ListOrdered,
  tasks: ListChecks,
  code: SquareCode,
};
// The `@name` being typed at the caret: an `@` that starts a word, then no spaces or brackets.
function typedMention(text: string, caret: number) {
  const match = /(?:^|[\s([{])@([^\s@[\]()]{0,40})$/.exec(text.slice(0, caret));
  return match?.[1] === undefined ? null : { from: caret - match[1].length - 1, query: match[1] };
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
}) {
  const id = useId(),
    [mode, setMode] = useState("write"),
    field = useRef<HTMLTextAreaElement>(null);
  const members = useQuery({
    ...api.query("list_members", { projectId: mentions ?? "" }),
    enabled: !!mentions,
  });
  const [caret, setCaret] = useState(0),
    [dismissed, setDismissed] = useState<number | null>(null),
    [highlight, setHighlight] = useState("");
  const typed = mentions ? typedMention(value, caret) : null,
    query = typed?.query.toLowerCase() ?? "";
  const matches = (members.data ?? [])
    .filter((person) => `${person.name} ${person.email}`.toLowerCase().includes(query))
    .slice(0, 8);
  const suggesting = !!typed && typed.from !== dismissed && matches.length > 0,
    active = matches.find((person) => person.userId === highlight) ?? matches[0],
    optionId = (userId: string) => `${id}-mention-${userId}`;
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
  const mention = (person: { name: string; userId: string }) => {
    if (!typed) return;
    const text = `${mentionLink(person.name, person.userId)} `,
      end = typed.from + text.length;
    insert({ from: typed.from, to: caret, text, start: end, end });
  };
  return (
    <Field
      className={cn(
        "mb-6 [&_[data-slot=tabs-list]]:shrink-0 [&_[data-slot=tabs-trigger]]:text-xs",
        variant === "compact" && "[&_textarea]:field-sizing-fixed [&_textarea]:max-h-[28rem]",
        variant === "document" &&
          "border-t pt-5 has-[textarea:focus]:border-t-primary has-[textarea:focus]:[&_[data-slot=field-label]]:text-primary",
      )}
      data-variant={variant}
      aria-label={`${label} editor`}
    >
      <Tabs value={mode} onValueChange={(next) => setMode(String(next))}>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <TabsList aria-label={`${label} editor`} variant="line">
            <TabsTrigger value="write">Write</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="write">
          <InputGroup
            className={
              variant === "document"
                ? "rounded-none border-0 bg-transparent dark:bg-transparent has-[[data-slot=input-group-control]:focus-visible]:ring-0"
                : undefined
            }
          >
            <InputGroupAddon
              align="block-start"
              role="toolbar"
              aria-label={`${label} formatting`}
              className={cn(
                "gap-0.5 overflow-x-auto border-b py-1 pl-1 text-foreground [scrollbar-width:none] max-md:gap-0 max-md:px-0",
                variant === "document" && "px-0",
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
                  Icon = formatIcons[format];
                return (
                  <IconButton
                    key={format}
                    label={spec.label}
                    {...("shortcut" in spec ? { shortcut: spec.shortcut } : {})}
                    size="icon-sm"
                    tabIndex={index === 0 ? 0 : -1}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => apply(format)}
                  >
                    <Icon />
                  </IconButton>
                );
              })}
            </InputGroupAddon>
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
              {...(mentions && {
                "aria-autocomplete": "list" as const,
                "aria-controls": suggesting ? `${id}-mentions` : undefined,
                "aria-activedescendant": suggesting && active ? optionId(active.userId) : undefined,
              })}
              onKeyDown={(event) => {
                if (suggesting && active && !event.nativeEvent.isComposing) {
                  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
                  if (step || ["Enter", "Tab", "Escape"].includes(event.key)) {
                    event.preventDefault();
                    // Keeps Escape from also closing a surrounding sheet or dialog.
                    event.stopPropagation();
                    const at = matches.indexOf(active);
                    if (step)
                      setHighlight(
                        matches[(at + step + matches.length) % matches.length]?.userId ?? "",
                      );
                    else if (event.key === "Escape") setDismissed(typed.from);
                    else mention(active);
                    return;
                  }
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
              <Popover
                open={suggesting}
                onOpenChange={(open) => {
                  if (!open && typed) setDismissed(typed.from);
                }}
              >
                <PopoverContent
                  anchor={field}
                  align="start"
                  initialFocus={false}
                  finalFocus={false}
                  className="w-[min(20rem,calc(100vw-2rem))] p-1"
                >
                  <div role="listbox" id={`${id}-mentions`} aria-label="Mention a member">
                    {matches.map((person) => (
                      <div
                        key={person.userId}
                        role="option"
                        id={optionId(person.userId)}
                        aria-selected={person === active}
                        data-selected={person === active || undefined}
                        className={commandItemClass}
                        // Keeps focus, and so the caret, in the field.
                        onMouseDown={(event) => event.preventDefault()}
                        onPointerMove={() => setHighlight(person.userId)}
                        onClick={() => mention(person)}
                      >
                        <UserIdentity
                          name={person.name}
                          email={person.email}
                          image={person.image}
                        />
                      </div>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}
            {footer && (
              <InputGroupAddon align="block-end" className="justify-end border-t py-2">
                {footer}
              </InputGroupAddon>
            )}
          </InputGroup>
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
              <p className="m-0 text-sm text-muted-foreground">Nothing to preview</p>
            )}
          </div>
          {footer && <div className="mt-2 flex justify-end">{footer}</div>}
        </TabsContent>
      </Tabs>
    </Field>
  );
}
