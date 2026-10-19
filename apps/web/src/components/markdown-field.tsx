import { useId, useRef, useState, type ReactNode } from "react";
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
import { IconButton, Markdown } from "../ui.tsx";
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
}) {
  const id = useId(),
    [mode, setMode] = useState("write"),
    field = useRef<HTMLTextAreaElement>(null);
  const apply = (format: MarkdownFormat) => {
    const element = field.current;
    if (!element) return;
    const edit = formatMarkdown(
      element.value,
      element.selectionStart,
      element.selectionEnd,
      format,
    );
    element.focus();
    element.setSelectionRange(edit.from, edit.to);
    // insertText keeps the edit on the browser's own undo stack; the fallback cannot.
    if (!document.execCommand("insertText", false, edit.text)) {
      element.setRangeText(edit.text);
      onChange(element.value);
    }
    element.setSelectionRange(edit.start, edit.end);
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
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
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
