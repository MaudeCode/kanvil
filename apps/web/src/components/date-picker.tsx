import { useId, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Field, FieldLabel } from "@/components/ui/field";

export function DatePicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Date;
  onChange: (date: Date) => void;
}) {
  const id = useId(),
    [open, setOpen] = useState(false);
  const [{ today, last }] = useState(() => {
    const earliest = new Date();
    earliest.setHours(0, 0, 0, 0);
    earliest.setDate(earliest.getDate() + 1);
    const latest = new Date();
    latest.setDate(latest.getDate() + 365);
    return { today: earliest, last: latest };
  });
  return (
    <Field className="field">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          id={id}
          render={<Button variant="outline" className="w-full justify-start font-normal" />}
          aria-label={label}
        >
          <CalendarDays />
          {new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(value)}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            mode="single"
            selected={value}
            defaultMonth={value}
            onSelect={(date) => {
              if (date) {
                onChange(date);
                setOpen(false);
              }
            }}
            disabled={[{ before: today }, { after: last }]}
            captionLayout="dropdown"
            startMonth={today}
            endMonth={last}
          />
        </PopoverContent>
      </Popover>
    </Field>
  );
}
export function credentialExpiry(date: Date, now = Date.now()) {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return Math.min(365 * 86400, Math.floor((end.getTime() - now) / 1000));
}
