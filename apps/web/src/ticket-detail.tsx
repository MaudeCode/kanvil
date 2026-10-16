import { TicketContextMenu } from "./components/object-context-menu.tsx";
import { Bell, BellOff, Pencil, ArrowLeft, MoreHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { z } from "zod";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { states, priorities, stateLabels, type Ticket, ApiError } from "@kanvil/contracts";
import { api, date, useProjectAccess, useOperation } from "./data.tsx";
import {
  Button,
  IconButton,
  Check,
  Confirm,
  ErrorNotice,
  Loading,
  EmptyState,
  Markdown,
  Modal,
  TicketIndicator,
  Textarea,
  Select,
  SelectItem,
} from "./ui.tsx";
import { TicketEditor } from "./ticket-editor.tsx";
import { Relations } from "./relations.tsx";
import { Discussion } from "./discussion.tsx";
import { Attachments, Evidence, Activity } from "./ticket-resources.tsx";

export function TicketDetail({ projectId, ticketId }: { projectId: string; ticketId: string }) {
  const access = useProjectAccess(projectId);
  const result = useQuery(api.query("get_ticket", { projectId, ticketId }));
  const update = useOperation("update_ticket"),
    subscribe = useOperation("set_subscription");
  const [editing, setEditing] = useState(false);
  const members = useQuery(api.query("list_members", { projectId }));
  if (result.isPending) return <Loading />;
  if (!result.data)
    return result.error instanceof ApiError && result.error.status === 404 ? (
      <EmptyState title="Ticket unavailable">
        <p>This ticket was deleted or you no longer have access.</p>
        <Button render={<Link to="/projects/$projectId" params={{ projectId }} />}>
          Back to tickets
        </Button>
      </EmptyState>
    ) : (
      <>
        <ErrorNotice error={result.error} />
        <Button
          onClick={() => {
            void result.refetch();
          }}
        >
          Retry
        </Button>
      </>
    );
  const { ticket, readiness, claim, canReleaseClaim, subscribed: following } = result.data;
  return (
    <>
      <header className="page-header">
        <Link to="/projects/$projectId" params={{ projectId }}>
          <ArrowLeft className="inline size-4" /> Tickets
        </Link>
        <div className="actions">
          <IconButton
            label={following ? "Unsubscribe" : "Subscribe"}
            disabled={subscribe.isPending}
            onClick={() => {
              void subscribe
                .mutateAsync({ projectId, ticketId: ticket.id, enabled: !following })

                .catch(() => {});
            }}
          >
            {following ? <BellOff /> : <Bell />}
          </IconButton>
          <Button variant="default" disabled={!access.canWrite} onClick={() => setEditing(true)}>
            <Pencil />
            Edit ticket
          </Button>
          <TicketContextMenu ticket={ticket} variant="dropdown" onEdit={() => setEditing(true)}>
            <Button variant="ghost" size="icon" aria-label="Ticket actions">
              <MoreHorizontal />
            </Button>
          </TicketContextMenu>
        </div>
      </header>
      <article className="ticket-detail">
        <TicketContextMenu ticket={ticket} onEdit={() => setEditing(true)}>
          <header className="ticket-heading">
            <div className="metadata">
              <span className="key">{ticket.key}</span>
              <TicketIndicator property="status" value={ticket.status} />
              <Badge variant="outline">{ticket.kind}</Badge>
              {ticket.archived && <strong>Archived</strong>}
            </div>
            <h1>{ticket.title}</h1>
            <div className="tags">
              {ticket.labels.map((label) => (
                <Badge variant="secondary" key={label}>
                  {label}
                </Badge>
              ))}
              {ticket.scopes.map((scope) => (
                <Badge variant="outline" key={scope}>
                  {scope}
                </Badge>
              ))}
            </div>
          </header>
        </TicketContextMenu>
        <div className="ticket-body">
          <div className="ticket-requirements">
            <section>
              <h2>Description</h2>
              <Markdown>{ticket.description || "_No description_"}</Markdown>
            </section>
            <section>
              <h2>Acceptance criteria</h2>
              <Markdown>{ticket.acceptanceCriteria || "_No acceptance criteria_"}</Markdown>
            </section>
          </div>
          <aside className="ticket-aside" aria-label="Ticket coordination">
            <section aria-label="Properties" className="ticket-properties">
              <Select
                label="Status"
                layout="property"
                disabled={!access.canWrite || update.isPending}
                value={ticket.status}
                onValueChange={(value) =>
                  update.mutate({
                    projectId,
                    ticketId: ticket.id,
                    expectedVersion: ticket.version,
                    changes: { status: z.enum(states).parse(value) },
                  })
                }
              >
                {states.map((status) => (
                  <SelectItem key={status} value={status}>
                    {stateLabels[status]}
                  </SelectItem>
                ))}
              </Select>
              <Select
                label="Priority"
                layout="property"
                disabled={!access.canWrite || update.isPending}
                value={ticket.priority}
                onValueChange={(value) =>
                  update.mutate({
                    projectId,
                    ticketId: ticket.id,
                    expectedVersion: ticket.version,
                    changes: { priority: z.enum(priorities).parse(value) },
                  })
                }
              >
                {priorities.map((priority) => (
                  <SelectItem key={priority} value={priority}>
                    <TicketIndicator property="priority" value={priority} />
                  </SelectItem>
                ))}
              </Select>
              <Select
                label="Assignee"
                layout="property"
                disabled={!access.canWrite || update.isPending}
                value={ticket.assigneeId ?? ""}
                onValueChange={(value) =>
                  update.mutate({
                    projectId,
                    ticketId: ticket.id,
                    expectedVersion: ticket.version,
                    changes: { assigneeId: value || null },
                  })
                }
              >
                <SelectItem value="">Unassigned</SelectItem>
                {members.data?.map((member) => (
                  <SelectItem key={member.userId} value={member.userId}>
                    {member.name}
                  </SelectItem>
                ))}
              </Select>
              <ErrorNotice error={update.error ?? members.error} />
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
              {claim && (
                <ClaimActions
                  ticket={ticket}
                  claim={claim}
                  canRelease={canReleaseClaim}
                  canRecover={
                    access.canAdmin &&
                    readiness.reasons.some((reason) => reason.code === "claim_recovery_required")
                  }
                />
              )}
            </section>
            <Relations key={ticket.id} ticket={ticket} />
            <Attachments ticket={ticket} />
          </aside>
          <Tabs defaultValue="discussion" className="ticket-collaboration mt-8 min-w-0">
            <TabsList variant="line" className="mb-5">
              <TabsTrigger value="discussion">Discussion</TabsTrigger>
              <TabsTrigger value="evidence">Evidence</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
            <TabsContent value="discussion">
              <Discussion ticket={ticket} />
            </TabsContent>
            <TabsContent value="evidence">
              <Evidence ticket={ticket} />
            </TabsContent>
            <TabsContent value="activity">
              <Activity ticket={ticket} />
            </TabsContent>
          </Tabs>
        </div>
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
  canRecover,
}: {
  ticket: Ticket;
  canRelease: boolean;
  canRecover: boolean;
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
      {canRecover && (
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
              onCheckedChange={(checked) => setConfirmed(checked)}
            />
            <ErrorNotice error={recover.error} />
            <Button type="submit" disabled={!confirmed || recover.isPending}>
              Recover ownership
            </Button>
            {recover.isSuccess && <p role="status">Claim recovered</p>}
          </form>
        </Modal>
      )}
    </div>
  );
}
