import { useId, useState } from "react";
import { X } from "lucide-react";
import { ticketFields, errorMessage } from "@kanvil/contracts";
import { splitTags } from "@kanvil/contracts/drafts";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
export function TagInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (tags: string[]) => void;
}) {
  const id = useId(),
    [text, setText] = useState(""),
    [error, setError] = useState<unknown>();
  function commit(raw = text) {
    if (!raw.trim()) return;
    try {
      onChange(ticketFields.shape.labels.parse([...new Set([...value, ...splitTags(raw)])]));
      setText("");
      setError(undefined);
    } catch (cause) {
      setError(cause);
    }
  }
  return (
    <Field className="field">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="tag-input">
        {value.map((tag) => (
          <Badge variant="secondary" key={tag} className="max-w-full gap-1 pr-0.5">
            <span className="break-words whitespace-normal">{tag}</span>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 md:size-5"
              aria-label={`Remove ${label.toLowerCase()} ${tag}`}
              onClick={() => onChange(value.filter((item) => item !== tag))}
            >
              <X className="size-3" />
            </Button>
          </Badge>
        ))}
        <Input
          id={id}
          value={text}
          placeholder={value.length ? "Add another…" : `Add ${label.toLowerCase()}…`}
          className="h-7 min-w-20 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
          onChange={(event) => setText(event.target.value)}
          onBlur={() => commit()}
          onPaste={(event) => {
            const raw = event.clipboardData.getData("text");
            if (raw.includes(",")) {
              event.preventDefault();
              setText(raw);
              commit(raw);
            }
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              commit();
            } else if (event.key === "Backspace" && !text) onChange(value.slice(0, -1));
          }}
        />
      </div>
      {!!error && <FieldError>{errorMessage(error)}</FieldError>}
    </Field>
  );
}
