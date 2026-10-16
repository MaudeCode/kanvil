import { useId, useState, type ReactNode } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupTextarea, InputGroupAddon } from "@/components/ui/input-group";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Markdown } from "../ui.tsx";
import { cn } from "@/lib/utils";
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
    [mode, setMode] = useState("write");
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
            <InputGroupTextarea
              id={id}
              className={
                variant === "document"
                  ? "field-sizing-content max-h-none resize-y px-1 py-3 text-base md:text-base leading-7 caret-primary"
                  : undefined
              }
              style={variant === "document" ? { minHeight: `${rows}lh` } : undefined}
              value={value}
              onChange={(event) => onChange(event.target.value)}
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
