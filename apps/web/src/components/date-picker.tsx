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

export const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
// One calendar picker for form fields, property rows, and composer pills.
export function DatePicker({
  label,
  value,
  onChange,
  variant = "field",
  bounds,
  placeholder = "Choose a date",
  mixed = false,
  disabled = false,
  className,
  textClassName,
}: {
  label: string;
  value: Date | null;
  onChange: (date: Date | null) => void;
  variant?: "field" | "pill" | "row";
  bounds?: { from?: Date; to?: Date };
  placeholder?: string;
  // The selection's dates differ (pass a null value): clearing stays available.
  mixed?: boolean;
  disabled?: boolean;
  // Styles the trigger, e.g. to fit a list cell.
  className?: string | undefined;
  // Styles the trigger's text, e.g. to leave only the icon on narrow toolbars.
  textClassName?: string;
}) {
  const id = useId(),
    [open, setOpen] = useState(false);
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
              className,
            )}
          />
        }
        aria-label={label}
      >
        <CalendarDays className={cn(variant !== "field" && "size-3.5 text-muted-foreground")} />
        {(value || placeholder) && (
          <span className={textClassName}>{value ? dayFormat.format(value) : placeholder}</span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <DateCalendar
          label={label}
          value={value}
          bounds={bounds}
          clearable={variant !== "field" && (!!value || mixed)}
          onChange={(date) => {
            onChange(date);
            setOpen(false);
          }}
        />
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
// The calendar and its clear action, shared by the picker popover and menus.
export function DateCalendar({
  label,
  value,
  onChange,
  bounds,
  clearable,
  autoFocus = false,
}: {
  label: string;
  value: Date | null;
  onChange: (date: Date | null) => void;
  bounds?: { from?: Date; to?: Date } | undefined;
  clearable: boolean;
  // Focuses the chosen day, or today, when the calendar opens without its own focus handling.
  autoFocus?: boolean;
}) {
  const [weekStart] = usePreference(preferences.weekStart);
  return (
    <>
      <Calendar
        mode="single"
        weekStartsOn={weekStarts[weekStart]}
        selected={value ?? undefined}
        defaultMonth={value ?? bounds?.from ?? startOfToday()}
        onSelect={(date) => {
          if (date) onChange(date);
        }}
        disabled={[
          ...(bounds?.from ? [{ before: bounds.from }] : []),
          ...(bounds?.to ? [{ after: bounds.to }] : []),
        ]}
        captionLayout="dropdown"
        autoFocus={autoFocus}
        {...(bounds?.from ? { startMonth: bounds.from } : {})}
        {...(bounds?.to ? { endMonth: bounds.to } : {})}
      />
      {clearable && (
        <div className="border-t p-1">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground"
            onClick={() => onChange(null)}
          >
            <X />
            Clear {label.toLowerCase()}
          </Button>
        </div>
      )}
    </>
  );
}
export function credentialExpiry(date: Date, now = Date.now()) {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return Math.min(365 * 86400, Math.floor((end.getTime() - now) / 1000));
}
// Due dates are stored as the end of the chosen day in the user's zone, start dates as its
// beginning, so both name whole days and a start on the due day still precedes it.
export function endOfDay(date: Date) {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end.toISOString();
}
export function startOfDay(date: Date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}
type Schedule = { startAt: string | null; dueAt: string | null };
// A ticket's start and due pickers. Each bounds the other, so the start never follows the due date.
export function ScheduleDates({
  value,
  onChange,
  variant,
  disabled = false,
}: {
  value: Schedule;
  onChange: (change: Partial<Schedule>) => void;
  variant: "pill" | "row";
  disabled?: boolean;
}) {
  const start = value.startAt ? new Date(value.startAt) : null,
    due = value.dueAt ? new Date(value.dueAt) : null;
  return (
    <>
      <DatePicker
        variant={variant}
        label="Start date"
        placeholder={variant === "pill" ? "Start" : "No start date"}
        value={start}
        disabled={disabled}
        {...(due ? { bounds: { to: due } } : {})}
        onChange={(date) => onChange({ startAt: date ? startOfDay(date) : null })}
      />
      <DatePicker
        variant={variant}
        label="Due date"
        placeholder={variant === "pill" ? "Due" : "No due date"}
        value={due}
        disabled={disabled}
        {...(start ? { bounds: { from: start } } : {})}
        onChange={(date) => onChange({ dueAt: date ? endOfDay(date) : null })}
      />
    </>
  );
}
