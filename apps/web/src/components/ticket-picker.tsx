import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, CornerLeftUp } from "lucide-react";
import { z } from "zod";
import { api } from "../data.tsx";
import { Button, ErrorNotice, fieldClass } from "../ui.tsx";
import { Field, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandGroup,
} from "@/components/ui/command";
export function TicketPicker({
  projectId,
  label,
  value,
  onChange,
  exclude = [],
  allowClear = true,
  variant = "field",
  placeholder = "Choose a ticket",
}: {
  projectId: string;
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  exclude?: string[];
  allowClear?: boolean;
  variant?: "field" | "pill";
  placeholder?: string;
}) {
  const id = useId(),
    [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const matches = useQuery({
    ...api.query("list_tickets", { projectId, q: query, archived: "include", limit: 30 }),
    enabled: open,
  });
  const selected = useQuery({
    ...api.query("get_ticket", { projectId, ticketId: value ?? "" }),
    enabled: !!value && z.uuid().safeParse(value).success,
  });
  const items = matches.data?.items.filter((ticket) => !exclude.includes(ticket.id)) ?? [],
    ticket = selected.data?.ticket ?? matches.data?.items.find((item) => item.id === value);
  const picker = (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery("");
      }}
    >
      <PopoverTrigger
        id={id}
        render={
          <Button
            variant={variant === "pill" ? "ghost" : "outline"}
            size={variant === "pill" ? "sm" : "default"}
            role="combobox"
            aria-label={label}
            className={
              variant === "pill"
                ? "h-7 max-w-64 min-w-0 border border-transparent px-2 font-normal hover:border-border"
                : "h-auto min-h-8 w-full justify-between whitespace-normal text-left font-normal"
            }
          />
        }
      >
        {variant === "pill" && (
          <CornerLeftUp className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className={variant === "pill" ? "min-w-0 truncate" : "min-w-0 break-words"}>
          {ticket
            ? variant === "pill"
              ? ticket.key
              : `${ticket.key} · ${ticket.title}`
            : value
              ? "Loading ticket…"
              : placeholder}
        </span>
        {variant !== "pill" && (
          <ChevronsUpDown className="ml-2 size-3.5 shrink-0 text-muted-foreground" />
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(420px,var(--available-width))] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            aria-label={`Search ${label.toLowerCase()}`}
            placeholder="Search by title or key…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {allowClear && (
              <CommandGroup>
                <CommandItem
                  value="none"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                >
                  No parent{!value && <Check className="ml-auto" />}
                </CommandItem>
              </CommandGroup>
            )}
            {matches.isPending ? (
              <div role="status" className="px-4 py-6 text-sm text-muted-foreground">
                Searching…
              </div>
            ) : !items.length ? (
              <div role="status" className="px-4 py-6 text-center text-sm text-muted-foreground">
                No tickets found
              </div>
            ) : (
              <CommandGroup>
                {items.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    className="items-start py-2"
                    onSelect={() => {
                      onChange(item.id);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="mb-1 block font-mono text-[11px] text-muted-foreground">
                        {item.key}
                      </span>
                      <span className="block break-words whitespace-normal">{item.title}</span>
                    </span>
                    {value === item.id && <Check className="ml-auto shrink-0" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <ErrorNotice error={matches.error} />
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
  if (variant === "pill")
    return (
      <>
        {picker}
        <ErrorNotice error={selected.error} />
      </>
    );
  return (
    <Field className={fieldClass}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {picker}
      <ErrorNotice error={selected.error} />
    </Field>
  );
}
