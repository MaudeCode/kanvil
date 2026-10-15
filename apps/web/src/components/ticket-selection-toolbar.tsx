import { useState } from "react";
import { Archive, X } from "lucide-react";
import { z } from "zod";
import { states, stateLabels, type Ticket } from "@kanvil/contracts";
import { useOperation } from "../data.tsx";
import { Button, IconButton, Confirm, ErrorNotice, Select, SelectItem } from "../ui.tsx";
import { Separator } from "@/components/ui/separator";

// Moves the existing bulk controls out of document flow; selecting never moves rows.
export function TicketSelectionToolbar({
  selected,
  onClear,
}: {
  selected: Ticket[];
  onClear: () => void;
}) {
  const bulk = useOperation("bulk_update_tickets");
  const [status, setStatus] = useState<Ticket["status"]>("todo");
  const projectId = selected[0]?.projectId;
  if (!projectId) return null;
  async function apply(changes: { status?: Ticket["status"]; archived?: boolean }) {
    await bulk.mutateAsync({
      projectId: projectId!,
      tickets: selected.map((ticket) => ({ ticketId: ticket.id, expectedVersion: ticket.version })),
      changes,
    });
    onClear();
  }
  return (
    <div className="selection-dock">
      <div className="selection-toolbar" role="region" aria-label="Selected tickets">
        <div className="flex items-center gap-1">
          <IconButton label="Clear selection" disabled={bulk.isPending} onClick={onClear}>
            <X />
          </IconButton>
          <span className="whitespace-nowrap text-xs font-medium" role="status">
            {selected.length} selected
          </span>
        </div>
        <Separator orientation="vertical" className="hidden sm:block" />
        <Select
          label="New status"
          className="w-36 shrink-0"
          value={status}
          disabled={bulk.isPending}
          onValueChange={(value) => setStatus(z.enum(states).parse(value))}
        >
          {states.map((value) => (
            <SelectItem key={value} value={value}>
              {stateLabels[value]}
            </SelectItem>
          ))}
        </Select>
        <Button
          variant="default"
          disabled={bulk.isPending}
          onClick={() => {
            void apply({ status }).catch(() => {});
          }}
        >
          {bulk.isPending ? "Updating…" : "Apply status"}
        </Button>
        <Confirm
          label="Archive selected"
          disabled={bulk.isPending}
          icon={<Archive />}
          description={`Archive ${selected.length} selected tickets?`}
          onConfirm={() => apply({ archived: true })}
        />
        <ErrorNotice error={bulk.error} />
      </div>
    </div>
  );
}
