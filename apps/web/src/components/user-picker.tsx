import { useId, useState } from "react";
import { z } from "zod";
import { Check, ChevronsUpDown } from "lucide-react";
import type { memberSchema } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { Button } from "../ui.tsx";
import { Field, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
export function UserPicker({
  people,
  value,
  onChange,
  disabled,
  label = t("ticket.userPicker.label"),
  anyAccount = true,
}: {
  people: z.output<typeof memberSchema>[];
  value: string;
  onChange: (email: string) => void;
  disabled?: boolean;
  label?: string;
  // Offers any account by email, not only the listed people.
  anyAccount?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    id = useId();
  const matches = people.filter((person) =>
      `${person.name} ${person.email}`.toLowerCase().includes(query.toLowerCase()),
    ),
    selected = people.find((person) => person.email === value);
  function choose(email: string) {
    onChange(email);
    setOpen(false);
  }
  return (
    <Field className="mb-4">
      <FieldLabel id={id}>{label}</FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              role="combobox"
              aria-labelledby={id}
              aria-expanded={open}
              disabled={disabled}
              className="h-auto min-h-10 w-full justify-between text-left"
            />
          }
        >
          {selected?.name ?? (value || t("ticket.userPicker.placeholder"))}
          <ChevronsUpDown className="ml-3 size-4 shrink-0" />
        </PopoverTrigger>
        <PopoverContent className="w-[min(24rem,calc(100vw-3rem))] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={t("ticket.userPicker.searchPlaceholder")}
              value={query}
              onValueChange={setQuery}
              aria-label={t("ticket.userPicker.searchLabel")}
            />
            <CommandList>
              {matches.slice(0, 50).map((person) => (
                <CommandItem
                  key={person.userId}
                  value={person.email}
                  onSelect={() => choose(person.email)}
                >
                  <div className="min-w-0">
                    <span dir="auto" className="block truncate">
                      {person.name}
                    </span>
                    <small className="break-all">{person.email}</small>
                  </div>
                  {value === person.email && <Check className="ml-auto" />}
                </CommandItem>
              ))}
              {anyAccount &&
                z.email().safeParse(query.trim()).success &&
                !matches.some((person) => person.email === query.trim()) && (
                  <CommandItem value={query.trim()} onSelect={() => choose(query.trim())}>
                    {t("ticket.userPicker.useEmail", { email: query.trim() })}
                  </CommandItem>
                )}
              <CommandEmpty>
                {anyAccount ? t("ticket.userPicker.emptyAnyAccount") : t("ticket.userPicker.empty")}
              </CommandEmpty>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </Field>
  );
}
