import { useId, useState } from "react";
import { X, Plus } from "lucide-react";
import { ticketFields, errorMessage } from "@kanvil/contracts";
import { splitTags } from "@kanvil/contracts/drafts";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TicketTag } from "./ticket-tags.tsx";
import { fieldClass } from "../ui.tsx";
import { useProjectLabels } from "./project-label-provider.tsx";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
export function TagInput({
  label,
  value,
  onChange,
  kind = "label",
}: {
  label: string;
  value: string[];
  onChange: (tags: string[]) => void;
  kind?: "label" | "scope";
}) {
  const labels = useProjectLabels();
  const [choosing, setChoosing] = useState(false);
  const id = useId(),
    [text, setText] = useState(""),
    [error, setError] = useState<unknown>();
  function commit(raw = text) {
    if (!raw.trim()) return;
    add(splitTags(raw));
  }
  function add(tags: string[]) {
    try {
      onChange(ticketFields.shape.labels.parse([...new Set([...value, ...tags])]));
      setText("");
      setError(undefined);
    } catch (cause) {
      setError(cause);
    }
  }
  return (
    <Field className={fieldClass}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-input px-2 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        {value.map((tag) => (
          <TicketTag tag={tag} kind={kind} key={tag} className="max-w-full gap-1 pr-0.5">
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
          </TicketTag>
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
        {kind === "label" && !!labels.length && (
          <Popover open={choosing} onOpenChange={setChoosing}>
            <PopoverTrigger
              render={<Button variant="ghost" size="icon" aria-label="Choose labels" />}
            >
              <Plus />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(20rem,calc(100vw-2rem))] p-0">
              <Command>
                <CommandInput placeholder="Search labels…" aria-label="Search project labels" />
                <CommandList>
                  {labels
                    .filter((entry) => !value.includes(entry.name))
                    .map((entry) => (
                      <CommandItem
                        key={entry.id}
                        value={entry.name}
                        onSelect={() => {
                          add([entry.name]);
                          setChoosing(false);
                        }}
                      >
                        <TicketTag tag={entry.name} color={entry.color} />
                      </CommandItem>
                    ))}
                  <CommandEmpty>No matching labels</CommandEmpty>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}
      </div>
      {!!error && <FieldError>{errorMessage(error)}</FieldError>}
    </Field>
  );
}
