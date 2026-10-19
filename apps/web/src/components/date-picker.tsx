import { useId, useState } from "react";
import { CalendarDays, X } from "lucide-react";
import { startOfToday } from "date-fns";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Field, FieldLabel } from "@/components/ui/field";
import { fieldClass } from "../ui.tsx";
import { preferences, usePreference, weekStarts } from "../hooks/use-preference.ts";
import { cn } from "@/lib/utils";

const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
// One calendar picker for form fields, property rows, and composer pills.
export function DatePicker({
  label,
  value,
  onChange,
  variant = "field",
  bounds,
  placeholder = "Choose a date",
  disabled = false,
}: {
  label: string;
  value: Date | null;
  onChange: (date: Date | null) => void;
  variant?: "field" | "pill" | "row";
  bounds?: { from?: Date; to?: Date };
  placeholder?: string;
  disabled?: boolean;
}) {
  const id = useId(),
    [open, setOpen] = useState(false),
    [weekStart] = usePreference(preferences.weekStart);
  const clearable = variant !== "field" && !!value;
  const trigger = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={id}
        disabled={disabled}
        render={
          <Button
            variant={variant === "field" ? "outline" : "ghost"}
            size={variant === "field" ? "default" : "sm"}
            className={cn(
              "justify-start font-normal",
              variant === "field" && "w-full",
              variant === "pill" &&
                "h-7 max-w-64 min-w-0 border border-transparent px-2 hover:border-border",
              variant === "row" && "h-7 w-full px-2",
              !value && variant !== "field" && "text-muted-foreground",
            )}
          />
        }
        aria-label={label}
      >
        <CalendarDays className={cn(variant !== "field" && "size-3.5 text-muted-foreground")} />
        {value ? format.format(value) : placeholder}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          weekStartsOn={weekStarts[weekStart]}
          selected={value ?? undefined}
          defaultMonth={value ?? bounds?.from ?? startOfToday()}
          onSelect={(date) => {
            if (date) {
              onChange(date);
              setOpen(false);
            }
          }}
          disabled={[
            ...(bounds?.from ? [{ before: bounds.from }] : []),
            ...(bounds?.to ? [{ after: bounds.to }] : []),
          ]}
          captionLayout="dropdown"
          {...(bounds?.from ? { startMonth: bounds.from } : {})}
          {...(bounds?.to ? { endMonth: bounds.to } : {})}
        />
        {clearable && (
          <div className="border-t p-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-muted-foreground"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              <X />
              Clear {label.toLowerCase()}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
  if (variant === "pill") return trigger;
  if (variant === "row")
    return (
      <div className="grid grid-cols-[80px_minmax(0,1fr)] items-center gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        {trigger}
      </div>
    );
  return (
    <Field className={fieldClass}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {trigger}
    </Field>
  );
}
export function credentialExpiry(date: Date, now = Date.now()) {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return Math.min(365 * 86400, Math.floor((end.getTime() - now) / 1000));
}
// Due dates are stored as the end of the chosen day in the user's zone.
export function endOfDay(date: Date) {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end.toISOString();
}
