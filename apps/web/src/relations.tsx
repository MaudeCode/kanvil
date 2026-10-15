import { formText } from "./forms.ts";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { z } from "zod";
import type { Ticket } from "@kanvil/contracts";
import { api, useOperation } from "./data.tsx";
import { Button, ErrorNotice, Input, Modal, Select } from "./ui.tsx";

export function Relations({ ticket }: { ticket: Ticket }) {
  const relations = useQuery(
    api.query("list_relations", { projectId: ticket.projectId, ticketId: ticket.id }),
  );
  const [query, setQuery] = useState("");
  const matches = useQuery(
    api.query("list_tickets", { projectId: ticket.projectId, q: query, limit: 30 }),
  );
  const add = useOperation("add_relation"),
    remove = useOperation("remove_relation");
  return (
    <section>
      <h2>Relationships</h2>
      {relations.data?.map((relation) => {
        const outgoing = relation.sourceId === ticket.id,
          other = outgoing ? relation.targetId : relation.sourceId;
        return (
          <div className="resource-row" key={relation.id}>
            <span>
              {relation.type === "blocks"
                ? outgoing
                  ? "Blocks"
                  : "Blocked by"
                : relation.type === "duplicate"
                  ? outgoing
                    ? "Duplicate of"
                    : "Duplicated by"
                  : "Related"}
            </span>
            <Link
              to="/projects/$projectId/tickets/$ticketId"
              params={{ projectId: ticket.projectId, ticketId: other }}
            >
              {other}
            </Link>
            <Button
              aria-label={`Remove ${relation.type} relationship`}
              onClick={() =>
                remove.mutate({ projectId: ticket.projectId, relationId: relation.id })
              }
            >
              Remove
            </Button>
          </div>
        );
      })}
      <Modal title="Add relationship" trigger="Add relationship">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            add.mutate({
              projectId: ticket.projectId,
              ticketId: ticket.id,
              targetId: formText(form, "target"),
              type: z.enum(["blocks", "related", "duplicate"]).parse(form.get("type")),
            });
          }}
        >
          <Input
            label="Find ticket"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select label="Relationship" name="type">
            <option value="blocks">This ticket blocks</option>
            <option value="related">Related to</option>
            <option value="duplicate">Duplicate of</option>
          </Select>
          <Select label="Ticket" name="target" required>
            <option value="">Choose a ticket</option>
            {matches.data?.items
              .filter((match) => match.id !== ticket.id)
              .map((match) => (
                <option key={match.id} value={match.id}>
                  {match.key} · {match.title}
                </option>
              ))}
          </Select>
          <ErrorNotice error={add.error ?? matches.error} />
          <Button type="submit" disabled={add.isPending}>
            Add relationship
          </Button>
          {add.isSuccess && <p role="status">Relationship added</p>}
        </form>
      </Modal>
      <ErrorNotice error={relations.error ?? remove.error} />
    </section>
  );
}
