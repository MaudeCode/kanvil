import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown } from "lucide-react";
import { z } from "zod";
import { api } from "../data.tsx";
import { Button, ErrorNotice } from "../ui.tsx";
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
}: {
  projectId: string;
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  exclude?: string[];
  allowClear?: boolean;
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
  return (
    <Field className="field">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
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
              variant="outline"
              role="combobox"
              aria-label={label}
              className="h-auto min-h-8 w-full justify-between whitespace-normal text-left font-normal"
            />
          }
        >
          <span className="min-w-0 break-words">
            {ticket
              ? `${ticket.key} · ${ticket.title}`
              : value
                ? "Loading ticket…"
                : "Choose a ticket"}
          </span>
          <ChevronsUpDown className="ml-2 size-3.5 shrink-0 text-muted-foreground" />
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
      <ErrorNotice error={selected.error} />
    </Field>
  );
}
