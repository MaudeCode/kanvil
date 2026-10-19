import { useState } from "react";
import { Archive, X } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { type Ticket } from "@kanvil/contracts";
import { useOperation } from "../data.tsx";
import { IconButton, Confirm, reportError } from "../ui.tsx";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import {
  TagsProperty,
  TicketProperty,
  propertyChange,
  propertyIcons,
  propertyLabels,
  propertyOf,
  propertyOrder,
} from "./ticket-property.tsx";
import { DatePicker, endOfDay } from "./date-picker.tsx";

// The first row's value only when every selected ticket shares it, so a mixed selection never
// shows one row's value as everyone's.
function shared<T>(selected: Ticket[], read: (ticket: Ticket) => T) {
  const [first, ...rest] = selected.map(read),
    key = JSON.stringify(first);
  return { value: first!, mixed: rest.some((value) => JSON.stringify(value) !== key) };
}

// Narrow screens keep only the icons; each control's accessible name still says what it edits.
const wideText = "max-sm:hidden";

// Floats above the list so selecting never shifts rows; every action applies immediately.
export function TicketSelectionToolbar({
  selected,
  onClear,
}: {
  selected: Ticket[];
  onClear: () => void;
}) {
  const bulk = useOperation("bulk_update_tickets"),
    cache = useQueryClient(),
    [recovering, setRecovering] = useState(false),
    busy = bulk.isPending || recovering;
  const projectId = selected[0]?.projectId;
  if (!projectId) return null;
  const write = (changes: Partial<Ticket>) =>
    bulk
      .mutateAsync({
        projectId,
        tickets: selected.map((ticket) => ({
          ticketId: ticket.id,
          expectedVersion: ticket.version,
        })),
        changes,
      })
      .catch(async (error: unknown) => {
        // The server rolled the whole batch back; stay busy until the reload brings the selection
        // current versions, so a retry cannot resend stale ones.
        setRecovering(true);
        try {
          await cache.invalidateQueries({ queryKey: ["kanvil"] });
        } finally {
          setRecovering(false);
        }
        throw error;
      });
  function apply(changes: Partial<Ticket>, label: string) {
    if (busy) return;
    void write(changes)
      .then(() => {
        toast.success(`${label} applied to ${selected.length} tickets`);
        onClear();
      })
      .catch(reportError);
  }
  const labels = shared(selected, (ticket) => ticket.labels.toSorted()),
    due = shared(selected, (ticket) => ticket.dueAt);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-40 w-[100cqw] max-w-none md:right-10">
      <div
        className="pointer-events-auto mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-1 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-4 duration-200"
        role="region"
        aria-label="Selected tickets"
      >
        <div className="flex items-center gap-1 pr-1">
          <IconButton label="Clear selection" size="icon-sm" disabled={busy} onClick={onClear}>
            <X />
          </IconButton>
          <span className="text-xs font-medium whitespace-nowrap tabular-nums" role="status">
            {selected.length} selected
          </span>
          {busy && <Spinner className="size-3.5" />}
        </div>
        <Separator orientation="vertical" className="hidden h-5! sm:block" />
        {propertyOrder.map((name) => {
          const Icon = propertyIcons[name],
            { value, mixed } = shared(selected, (ticket) => propertyOf(ticket, name));
          return (
            <TicketProperty
              key={name}
              property={name}
              projectId={projectId}
              value={value}
              mixed={mixed}
              disabled={busy}
              align="end"
              onChange={(next) => apply(propertyChange(name, next), propertyLabels[name])}
            >
              <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span className={wideText}>{propertyLabels[name]}</span>
            </TicketProperty>
          );
        })}
        <TagsProperty
          replace
          value={labels.value}
          mixed={labels.mixed}
          disabled={busy}
          textClassName={wideText}
          onChange={(next) => apply({ labels: next }, "Labels")}
        />
        <DatePicker
          variant="pill"
          label="Due date"
          placeholder={due.mixed ? "Mixed due dates" : "Due date"}
          value={!due.mixed && due.value ? new Date(due.value) : null}
          mixed={due.mixed}
          disabled={busy}
          textClassName={wideText}
          onChange={(date) => apply({ dueAt: date ? endOfDay(date) : null }, "Due date")}
        />
        <Separator orientation="vertical" className="hidden h-5! sm:block" />
        <Confirm
          label="Archive selected"
          disabled={busy}
          icon={<Archive />}
          description={`Archive ${selected.length} selected tickets?`}
          onConfirm={async () => {
            await write({ archived: true });
            onClear();
          }}
        />
      </div>
    </div>
  );
}
