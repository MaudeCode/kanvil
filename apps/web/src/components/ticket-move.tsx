import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Ticket } from "@kanvil/contracts";
import { api, useOperation } from "../data.tsx";
import { FormActions, Loading } from "../ui.tsx";
import {
  ProjectProperty,
  TicketProperty,
  parseStatus,
  stateValue,
  type StatusValue,
} from "./ticket-property.tsx";

// Moves a ticket to another writable project of its workspace. The server's preflight lists the
// destination's states and anything that keeps the ticket where it is; the move checks it all again.
export function TicketMoveForm({
  ticket,
  onMoved,
  onCancel,
}: {
  ticket: Ticket;
  onMoved: (moved: Ticket) => void;
  onCancel: () => void;
}) {
  const [destination, setDestination] = useState(""),
    [status, setStatus] = useState<StatusValue | null>(null),
    move = useOperation("relocate_ticket");
  const check = useQuery({
    ...api.query("check_ticket_relocation", {
      projectId: ticket.projectId,
      ticketId: ticket.id,
      destinationProjectId: destination,
    }),
    enabled: !!destination,
  });
  const fallback = check.data?.states.find((state) => state.id === check.data.stateId),
    chosen = status ?? (fallback ? stateValue(fallback) : null),
    blockers = check.data?.blockers ?? [];
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!chosen) return;
        const { status: category, stateId } = parseStatus(chosen);
        void move
          .mutateAsync({
            projectId: ticket.projectId,
            ticketId: ticket.id,
            expectedVersion: ticket.version,
            destinationProjectId: destination,
            status: category,
            ...(stateId ? { stateId } : {}),
          })
          .then(onMoved)
          .catch(() => {});
      }}
    >
      <div className="flex flex-wrap items-center gap-1" aria-label="Destination">
        <ProjectProperty
          value={destination}
          exclude={ticket.projectId}
          placeholder="Move to project…"
          disabled={move.isPending}
          onChange={(projectId) => {
            setDestination(projectId);
            setStatus(null);
          }}
        />
        {chosen && (
          <TicketProperty
            property="status"
            projectId={destination}
            value={chosen}
            disabled={move.isPending}
            onChange={setStatus}
          />
        )}
      </div>
      {destination && check.isPending && <Loading />}
      {blockers.length > 0 && (
        <div className="mt-4 text-sm">
          <p className="font-medium">Resolve before moving</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
            {blockers.map((blocker) => (
              <li key={blocker.code}>{blocker.message}</li>
            ))}
          </ul>
        </div>
      )}
      <FormActions
        error={check.error ?? move.error}
        pending={move.isPending}
        submitLabel="Move ticket"
        pendingLabel="Moving…"
        submitDisabled={!chosen || blockers.length > 0}
        onCancel={onCancel}
      />
    </form>
  );
}
