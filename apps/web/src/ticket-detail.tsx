import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { Ticket } from "@kanvil/contracts";
import { api, date, useProjectAccess, useOperation } from "./data.tsx";
import {
  Button,
  Check,
  Confirm,
  ErrorNotice,
  Loading,
  Markdown,
  Modal,
  Status,
  Textarea,
} from "./ui.tsx";
import { TicketEditor } from "./ticket-editor.tsx";
import { Relations } from "./relations.tsx";
import { Discussion } from "./discussion.tsx";
import { Attachments, Evidence, Activity } from "./ticket-resources.tsx";

export function TicketDetail({ projectId, ticketId }: { projectId: string; ticketId: string }) {
  const access = useProjectAccess(projectId);
  const result = useQuery(api.query("get_ticket", { projectId, ticketId }));
  const update = useOperation("update_ticket"),
    remove = useOperation("delete_ticket"),
    subscribe = useOperation("set_subscription");
  const [editing, setEditing] = useState(false);
  const navigate = useNavigate();
  if (result.isPending) return <Loading />;
  if (!result.data) return <ErrorNotice error={result.error} />;
  const { ticket, readiness, claim, canReleaseClaim, subscribed: following } = result.data;
  return (
    <>
      <header className="page-header">
        <Link to="/projects/$projectId" params={{ projectId }}>
          ← Tickets
        </Link>
        <div className="actions">
          <Button
            disabled={subscribe.isPending}
            onClick={() => {
              void subscribe
                .mutateAsync({ projectId, ticketId: ticket.id, enabled: !following })

                .catch(() => {});
            }}
          >
            {following ? "Unsubscribe" : "Subscribe"}
          </Button>
          <Button className="primary" disabled={!access.canWrite} onClick={() => setEditing(true)}>
            Edit ticket
          </Button>
        </div>
      </header>
      <article className="ticket-detail">
        <div className="metadata">
          <span className="key">{ticket.key}</span>
          <Status value={ticket.status} />
          <span>{ticket.priority} priority</span>
          <span>{ticket.kind}</span>
          <span>difficulty: {ticket.difficulty ?? "unspecified"}</span>
          <span>v{ticket.version}</span>
          {ticket.archived && <strong>Archived</strong>}
        </div>
        <h1>{ticket.title}</h1>
        <div className="tags">
          {ticket.labels.map((label) => (
            <span key={label}>#{label}</span>
          ))}
          {ticket.scopes.map((scope) => (
            <span key={scope}>scope: {scope}</span>
          ))}
        </div>
        <section>
          <h2>Description</h2>
          <Markdown>{ticket.description || "_No description_"}</Markdown>
        </section>
        <section>
          <h2>Acceptance criteria</h2>
          <Markdown>{ticket.acceptanceCriteria || "_No acceptance criteria_"}</Markdown>
        </section>
        <section>
          <h2>Agent readiness</h2>
          <p className={readiness.ready ? "success" : "muted"}>
            {readiness.ready ? "Ready to claim" : "Not ready to claim"}
          </p>
          <ul>
            {readiness.reasons.map((reason, index) => (
              <li key={`${reason.code}:${index}`}>{reason.message}</li>
            ))}
          </ul>
          {ticket.holdReason && <p>Hold: {ticket.holdReason}</p>}
          {claim && (
            <p>
              Claimed by <strong>{claim.workerId}</strong> until {date(claim.expiresAt)}.
            </p>
          )}
          {claim && <ClaimActions ticket={ticket} claim={claim} canRelease={canReleaseClaim} />}
        </section>
        <Relations key={ticket.id} ticket={ticket} />
        <Discussion ticket={ticket} />
        <Attachments ticket={ticket} />
        <Evidence ticket={ticket} />
        <Activity ticket={ticket} />
        <section className="actions">
          <Confirm
            label={ticket.archived ? "Unarchive ticket" : "Archive ticket"}
            description={
              ticket.archived
                ? "Restore this ticket to active lists?"
                : "Archive this ticket and remove it from agent eligibility?"
            }
            onConfirm={() =>
              update.mutateAsync({
                projectId,
                ticketId: ticket.id,
                expectedVersion: ticket.version,
                changes: { archived: !ticket.archived },
              })
            }
          />
          <Confirm
            label="Delete ticket"
            danger
            description="Permanently delete this ticket, comments, relationships, and attachments?"
            onConfirm={async () => {
              await remove.mutateAsync({
                projectId,
                ticketId: ticket.id,
                expectedVersion: ticket.version,
              });
              await navigate({ to: "/projects/$projectId", params: { projectId } });
            }}
          />
        </section>
        <ErrorNotice error={result.error ?? subscribe.error} />
      </article>
      <Modal title={`Edit ${ticket.key}`} open={editing} onOpenChange={setEditing}>
        {editing && (
          <TicketEditor projectId={projectId} ticket={ticket} onSaved={() => setEditing(false)} />
        )}
      </Modal>
    </>
  );
}
function ClaimActions({
  ticket,
  claim,
  canRelease,
}: {
  ticket: Ticket;
  canRelease: boolean;
  claim: NonNullable<Awaited<ReturnType<typeof api.call<"get_ticket">>>["claim"]>;
}) {
  const release = useOperation("release_claim"),
    recover = useOperation("recover_claim");
  const [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  return (
    <div className="actions">
      {canRelease && (
        <Confirm
          label="Release my claim"
          description="Release ownership after your worker has stopped writing?"
          onConfirm={() =>
            release.mutateAsync({
              projectId: ticket.projectId,
              ticketId: ticket.id,
              claimId: claim.id,
            })
          }
        />
      )}
      <Modal title="Recover expired claim" trigger="Recover expired claim">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (confirmed)
              recover.mutate({
                projectId: ticket.projectId,
                ticketId: ticket.id,
                claimId: claim.id,
                reason,
                confirmedStopped: true,
              });
          }}
        >
          <p>
            Recovery requires project administrator access and an expired claim. Stop the worker
            first.
          </p>
          <Textarea
            label="Recovery reason"
            required
            minLength={10}
            maxLength={2000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Check
            label="I have confirmed the worker has stopped"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <ErrorNotice error={recover.error} />
          <Button type="submit" disabled={!confirmed || recover.isPending}>
            Recover ownership
          </Button>
          {recover.isSuccess && <p role="status">Claim recovered</p>}
        </form>
      </Modal>
    </div>
  );
}
