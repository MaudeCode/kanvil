import { TicketPicker } from "./components/ticket-picker.tsx";
import { Unlink, Plus } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { z } from "zod";
import { relationReference, type Ticket } from "@kanvil/contracts";
import { api, useOperation, useProjectAccess } from "./data.tsx";
import {
  Button,
  IconButton,
  ErrorNotice,
  Modal,
  Select,
  SelectItem,
  Status,
  SectionHeading,
} from "./ui.tsx";

export function Relations({ ticket }: { ticket: Ticket }) {
  const access = useProjectAccess(ticket.projectId);
  const relations = useQuery(
    api.query("list_relations", { projectId: ticket.projectId, ticketId: ticket.id }),
  );
  const [open, setOpen] = useState(false),
    [target, setTarget] = useState<string | null>(null),
    [offset, setOffset] = useState(0),
    [validationError, setValidationError] = useState<unknown>();
  const parent = useQuery({
    ...api.query("get_ticket", {
      projectId: ticket.projectId,
      ticketId: ticket.parentId ?? ticket.id,
    }),
    enabled: !!ticket.parentId,
  });
  const children = useQuery(
    api.query("list_tickets", {
      projectId: ticket.projectId,
      parentId: ticket.id,
      archived: "include",
      limit: 20,
      offset,
    }),
  );
  const add = useOperation("add_relation"),
    remove = useOperation("remove_relation");
  return (
    <section>
      <SectionHeading
        title="Relationships"
        action={
          access.canWrite && (
            <IconButton
              label="Add relationship"
              onClick={() => {
                add.reset();
                setValidationError(undefined);
                setTarget(null);
                setOpen(true);
              }}
            >
              <Plus />
            </IconButton>
          )
        }
      />
      {ticket.parentId && (
        <p>
          Parent:{" "}
          <Link
            to="/projects/$projectId/tickets/$ticketId"
            params={{ projectId: ticket.projectId, ticketId: ticket.parentId }}
          >
            {parent.data
              ? `${parent.data.ticket.key} · ${parent.data.ticket.title}`
              : ticket.parentId}
          </Link>
        </p>
      )}
      {children.data && (children.data.total > 0 || offset > 0) && (
        <>
          <h3>Child tickets</h3>
          {children.data.items.map((child) => (
            <div className="resource-row" key={child.id}>
              <Link
                to="/projects/$projectId/tickets/$ticketId"
                params={{ projectId: ticket.projectId, ticketId: child.id }}
              >
                {child.key} · {child.title}
              </Link>
              <Status value={child.status} />
            </div>
          ))}
          {(children.data.total > 20 || offset > 0) && (
            <div className="actions">
              <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>
                Previous children
              </Button>
              <Button
                disabled={offset + 20 >= children.data.total}
                onClick={() => setOffset(offset + 20)}
              >
                Next children
              </Button>
            </div>
          )}
        </>
      )}
      {relations.data?.map((relation) => {
        const reference = relationReference(relation, ticket.id);
        return (
          <div className="resource-row" key={relation.id}>
            <span>{reference.label}</span>
            <Link
              to="/projects/$projectId/tickets/$ticketId"
              params={{ projectId: ticket.projectId, ticketId: reference.id }}
            >
              {reference.title}
            </Link>
            {access.canWrite && (
              <IconButton
                label={`Remove ${relation.type} relationship`}
                onClick={() =>
                  remove.mutate({ projectId: ticket.projectId, relationId: relation.id })
                }
              >
                <Unlink />
              </IconButton>
            )}
          </div>
        );
      })}
      <Modal title="Add relationship" open={open} onOpenChange={setOpen} busy={add.isPending}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            if (!target) return;
            setValidationError(undefined);
            void add
              .mutateAsync({
                projectId: ticket.projectId,
                ticketId: ticket.id,
                targetId: target,
                type: z.enum(["blocks", "related", "duplicate"]).parse(form.get("type")),
              })
              .then(() => setOpen(false))
              .catch(setValidationError);
          }}
        >
          <Select label="Relationship" name="type">
            <SelectItem value="blocks">This ticket blocks</SelectItem>
            <SelectItem value="related">Related to</SelectItem>
            <SelectItem value="duplicate">Duplicate of</SelectItem>
          </Select>
          <TicketPicker
            projectId={ticket.projectId}
            label="Ticket"
            value={target}
            onChange={setTarget}
            exclude={[ticket.id]}
            allowClear={false}
          />

          <ErrorNotice error={validationError ?? add.error} />
          <Button type="submit" disabled={add.isPending || !target}>
            Add relationship
          </Button>
        </form>
      </Modal>
      <ErrorNotice error={relations.error ?? remove.error ?? parent.error ?? children.error} />
    </section>
  );
}
