import { Archive, X } from "lucide-react";
import { toast } from "sonner";
import { type Ticket } from "@kanvil/contracts";
import { useOperation } from "../data.tsx";
import { IconButton, Confirm, reportError } from "../ui.tsx";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import {
  TicketProperty,
  propertyLabels,
  type PropertyName,
  type PropertyValues,
} from "./ticket-property.tsx";

// Floats above the list so selecting never shifts rows; every action applies immediately.
export function TicketSelectionToolbar({
  selected,
  onClear,
}: {
  selected: Ticket[];
  onClear: () => void;
}) {
  const bulk = useOperation("bulk_update_tickets");
  const projectId = selected[0]?.projectId;
  if (!projectId) return null;
  function apply(changes: Partial<Ticket>, label: string) {
    void bulk
      .mutateAsync({
        projectId: projectId!,
        tickets: selected.map((ticket) => ({
          ticketId: ticket.id,
          expectedVersion: ticket.version,
        })),
        changes,
      })
      .then(() => {
        toast.success(`${label} applied to ${selected.length} tickets`);
        onClear();
      })
      .catch(reportError);
  }
  const property = <P extends PropertyName>(
    name: P,
    read: (ticket: Ticket) => PropertyValues[P],
    change: (value: PropertyValues[P]) => Partial<Ticket>,
  ) => (
    <TicketProperty
      property={name}
      projectId={projectId}
      value={read(selected[0]!)}
      disabled={bulk.isPending}
      align="end"
      onChange={(value) => apply(change(value), propertyLabels[name])}
    >
      {propertyLabels[name]}
    </TicketProperty>
  );
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-40 w-[100cqw] max-w-none md:right-10">
      <div
        className="pointer-events-auto mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-1 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-4 duration-200"
        role="region"
        aria-label="Selected tickets"
      >
        <div className="flex items-center gap-1 pr-1">
          <IconButton
            label="Clear selection"
            size="icon-sm"
            disabled={bulk.isPending}
            onClick={onClear}
          >
            <X />
          </IconButton>
          <span className="text-xs font-medium whitespace-nowrap tabular-nums" role="status">
            {selected.length} selected
          </span>
          {bulk.isPending && <Spinner className="size-3.5" />}
        </div>
        <Separator orientation="vertical" className="hidden h-5! sm:block" />
        {property(
          "status",
          (ticket) => ticket.status,
          (status) => ({ status }),
        )}
        {property(
          "priority",
          (ticket) => ticket.priority,
          (priority) => ({ priority }),
        )}
        {property(
          "assignee",
          (ticket) => ticket.assigneeId,
          (assigneeId) => ({ assigneeId }),
        )}
        {property(
          "kind",
          (ticket) => ticket.kind,
          (kind) => ({ kind }),
        )}
        <Separator orientation="vertical" className="hidden h-5! sm:block" />
        <Confirm
          label="Archive selected"
          disabled={bulk.isPending}
          icon={<Archive />}
          description={`Archive ${selected.length} selected tickets?`}
          onConfirm={async () => {
            await bulk.mutateAsync({
              projectId,
              tickets: selected.map((ticket) => ({
                ticketId: ticket.id,
                expectedVersion: ticket.version,
              })),
              changes: { archived: true },
            });
            onClear();
          }}
        />
      </div>
    </div>
  );
}
