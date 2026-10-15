import { useId, useState, type ReactNode } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupTextarea, InputGroupAddon } from "@/components/ui/input-group";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Markdown } from "../ui.tsx";
export function MarkdownField({
  label,
  value,
  onChange,
  placeholder,
  rows = 5,
  maxLength = 100000,
  required = false,
  footer,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  maxLength?: number;
  required?: boolean;
  footer?: ReactNode;
}) {
  const id = useId(),
    [mode, setMode] = useState("write");
  return (
    <Field className="markdown-field" aria-label={`${label} editor`}>
      <Tabs value={mode} onValueChange={(next) => setMode(String(next))}>
        <div className="flex items-center justify-between gap-3">
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <TabsList aria-label={`${label} editor`} variant="line">
            <TabsTrigger value="write">Write</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="write">
          <InputGroup>
            <InputGroupTextarea
              id={id}
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
          <div className="markdown-preview">
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
