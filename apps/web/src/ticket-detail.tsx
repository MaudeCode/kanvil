import { TicketContextMenu } from "./components/object-context-menu.tsx";
import {
  Bell,
  BellOff,
  Pencil,
  ArrowLeft,
  MoreHorizontal,
  Check as CheckIcon,
  ChevronUp,
  ChevronDown,
  Link2,
  Archive,
  ArchiveRestore,
} from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import { type Ticket, ApiError } from "@kanvil/contracts";
import { api, date, ActorName, useProjectAccess, useOperation } from "./data.tsx";
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
  PageHeader,
  RelativeTime,
  TicketIndicator,
  Textarea,
  FormActions,
  reportError,
} from "./ui.tsx";
import { TicketEditor } from "./ticket-editor.tsx";
import { Relations } from "./relations.tsx";
import { Discussion } from "./discussion.tsx";
import { Attachments, Evidence, Activity } from "./ticket-resources.tsx";
import { TagsProperty, TicketProperty, useTicketChange } from "./components/ticket-property.tsx";
import { useShortcut } from "./hooks/use-shortcut.ts";
import { DatePicker, endOfDay } from "./components/date-picker.tsx";
import { copyText } from "./lib/browser.ts";
import { readListOrder } from "./lib/list-order.ts";

export function TicketDetail({ projectId, ticketId }: { projectId: string; ticketId: string }) {
  const access = useProjectAccess(projectId);
  const result = useQuery(api.query("get_ticket", { projectId, ticketId }));
  const subscribe = useOperation("set_subscription");
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  // The list the reader came from, so previous and next walk it in the order they saw.
  const [order] = useState(() => readListOrder(projectId));
  const position = order.indexOf(ticketId);
  const step = (delta: number) => {
    const target = position < 0 ? undefined : order[position + delta];
    if (target)
      void navigate({
        to: "/projects/$projectId/tickets/$ticketId",
        params: { projectId, ticketId: target },
      });
  };
  useShortcut("j", () => step(1), { enabled: !editing });
  useShortcut("k", () => step(-1), { enabled: !editing });
  const ticket = result.data?.ticket;
  const { change, pending } = useTicketChange(ticket ?? { id: ticketId, projectId, version: 1 });
  useShortcut(
    "e",
    () => {
      if (access.canWrite) setEditing(true);
    },
    { enabled: !!ticket && !editing },
  );
  if (result.isPending) return <Loading />;
  if (!result.data || !ticket)
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
  const { readiness, claim, canReleaseClaim, subscribed: following } = result.data;
  const editable = access.canWrite && !pending;
  return (
    <>
      <article className="ticket-detail grid w-full grid-cols-[minmax(0,1fr)_280px] gap-x-10 animate-in fade-in-0 duration-200 @max-[850px]:flex @max-[850px]:flex-col [&_section]:border-t [&_section]:py-5">
        <div className="min-w-0">
          <PageHeader
            title={
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 text-muted-foreground"
                render={<Link to="/projects/$projectId" params={{ projectId }} />}
              >
                <ArrowLeft />
                Tickets
              </Button>
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              {position >= 0 && (
                <div className="mr-1 flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums">
                  <IconButton
                    label="Previous ticket"
                    title="Previous ticket (K)"
                    disabled={position === 0}
                    onClick={() => step(-1)}
                  >
                    <ChevronUp />
                  </IconButton>
                  <span>
                    {position + 1} / {order.length}
                  </span>
                  <IconButton
                    label="Next ticket"
                    title="Next ticket (J)"
                    disabled={position === order.length - 1}
                    onClick={() => step(1)}
                  >
                    <ChevronDown />
                  </IconButton>
                </div>
              )}
              <IconButton
                label={following ? "Unsubscribe" : "Subscribe"}
                disabled={subscribe.isPending}
                onClick={() => {
                  void subscribe
                    .mutateAsync({ projectId, ticketId: ticket.id, enabled: !following })
                    .then(() => toast.success(following ? "Unsubscribed" : "Subscribed to updates"))
                    .catch(reportError);
                }}
              >
                {following ? <BellOff /> : <Bell />}
              </IconButton>
              <IconButton
                label="Copy link"
                onClick={() => {
                  void copyText(
                    new URL(`/projects/${projectId}/tickets/${ticket.id}`, location.origin).href,
                  )
                    .then(() => toast.success("Link copied"))
                    .catch(reportError);
                }}
              >
                <Link2 />
              </IconButton>
              <IconButton
                label={ticket.archived ? "Unarchive ticket" : "Archive ticket"}
                disabled={!editable}
                onClick={() => {
                  void change({ archived: !ticket.archived }).then((saved) => {
                    if (saved)
                      toast.success(ticket.archived ? "Ticket unarchived" : "Ticket archived");
                  });
                }}
              >
                {ticket.archived ? <ArchiveRestore /> : <Archive />}
              </IconButton>
              <IconButton
                label="Edit ticket"
                title="Edit ticket (E)"
                disabled={!access.canWrite}
                onClick={() => setEditing(true)}
              >
                <Pencil />
              </IconButton>
              <TicketContextMenu ticket={ticket} variant="dropdown" onEdit={() => setEditing(true)}>
                <Button variant="ghost" size="icon" aria-label="Ticket actions">
                  <MoreHorizontal />
                </Button>
              </TicketContextMenu>
            </div>
          </PageHeader>
          <TicketContextMenu ticket={ticket} onEdit={() => setEditing(true)}>
            <header className="ticket-heading">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                <Button
                  variant="ghost"
                  size="xs"
                  className="-ml-2 gap-1.5 font-mono text-xs text-muted-foreground"
                  title="Copy ticket key"
                  onClick={() => {
                    void copyText(ticket.key)
                      .then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                        toast.success(`${ticket.key} copied`);
                      })
                      .catch(reportError);
                  }}
                >
                  {ticket.key}
                  {copied && <CheckIcon className="size-3 text-[var(--success)]" />}
                </Button>
                <TicketIndicator property="status" value={ticket.status} />
                {ticket.archived && <strong>Archived</strong>}
                {pending && <Spinner className="size-3.5 text-muted-foreground" />}
              </div>
              <h1 className="mt-4 mb-6 max-w-4xl text-2xl leading-snug font-semibold tracking-tight">
                {ticket.title}
              </h1>
            </header>
          </TicketContextMenu>
          <div className="min-w-0 [&>section:first-child]:border-0 [&>section:first-child]:pt-0">
            <section>
              <h2>Description</h2>
              <Markdown>{ticket.description || "_No description_"}</Markdown>
            </section>
            <section>
              <h2>Acceptance criteria</h2>
              <Markdown>{ticket.acceptanceCriteria || "_No acceptance criteria_"}</Markdown>
            </section>
          </div>
          <Tabs
            defaultValue="discussion"
            className="mt-8 min-w-0 [&_[data-slot=tabs-content]>section]:border-0 [&_[data-slot=tabs-content]>section]:pt-0"
          >
            <TabsList variant="line" className="mb-5">
              <TabsTrigger value="discussion">Discussion</TabsTrigger>
              <TabsTrigger value="evidence">Evidence</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
            <TabsContent value="discussion" className="animate-in fade-in-0 duration-150">
              <Discussion ticket={ticket} />
            </TabsContent>
            <TabsContent value="evidence" className="animate-in fade-in-0 duration-150">
              <Evidence ticket={ticket} />
            </TabsContent>
            <TabsContent value="activity" className="animate-in fade-in-0 duration-150">
              <Activity ticket={ticket} />
            </TabsContent>
          </Tabs>
          <ErrorNotice error={result.error} />
        </div>
        <aside
          className="min-w-0 border-l pl-5 @max-[850px]:border-l-0 @max-[850px]:pl-0 [&>section:first-child]:border-0 [&>section:first-child]:pt-0 @max-[850px]:[&>section:first-child]:border-t @max-[850px]:[&>section:first-child]:pt-6 [&_h2]:text-xs [&_h2]:font-medium [&_h2]:text-muted-foreground [&_p]:text-xs [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:text-xs [&_ul]:leading-relaxed [&_ul]:text-muted-foreground"
          aria-label="Ticket coordination"
        >
          <section aria-label="Properties" className="ticket-properties">
            <TicketProperty
              variant="row"
              property="status"
              projectId={projectId}
              value={ticket.status}
              disabled={!editable}
              onChange={(status) => void change({ status })}
            />
            <TicketProperty
              variant="row"
              property="priority"
              projectId={projectId}
              value={ticket.priority}
              disabled={!editable}
              onChange={(priority) => void change({ priority })}
            />
            <TicketProperty
              variant="row"
              property="assignee"
              projectId={projectId}
              value={ticket.assigneeId}
              disabled={!editable}
              onChange={(assignee) => void change({ assignee })}
            />
            <TicketProperty
              variant="row"
              property="kind"
              projectId={projectId}
              value={ticket.kind}
              disabled={!editable}
              onChange={(kind) => void change({ kind })}
            />
            <TicketProperty
              variant="row"
              property="difficulty"
              projectId={projectId}
              value={ticket.difficulty}
              disabled={!editable}
              onChange={(difficulty) => void change({ difficulty })}
            />
            <DatePicker
              variant="row"
              label="Due date"
              placeholder="No due date"
              value={ticket.dueAt ? new Date(ticket.dueAt) : null}
              disabled={!editable}
              onChange={(chosen) => void change({ dueAt: chosen ? endOfDay(chosen) : null })}
            />
            <TagsProperty
              variant="row"
              value={ticket.labels}
              disabled={!editable}
              onChange={(labels) => void change({ labels })}
            />
            {(ticket.scopes.length > 0 || access.canWrite) && (
              <TagsProperty
                variant="row"
                kind="scope"
                value={ticket.scopes}
                disabled={!editable}
                onChange={(scopes) => void change({ scopes })}
              />
            )}
            <dl className="mt-4 grid grid-cols-[80px_minmax(0,1fr)] gap-x-2 gap-y-1.5 border-t pt-4 text-xs [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:wrap-anywhere [&_dt]:text-muted-foreground">
              <dt>Created</dt>
              <dd>
                <ActorName projectId={projectId} actorId={ticket.createdBy} />
                {" · "}
                <RelativeTime value={ticket.createdAt} />
              </dd>
              <dt>Updated</dt>
              <dd>
                <RelativeTime value={ticket.updatedAt} />
              </dd>
            </dl>
          </section>
          <section>
            <h2>Agent readiness</h2>
            <p className={readiness.ready ? "text-[var(--success)]" : "text-muted-foreground"}>
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
      </article>
      <Modal size="composer" title={`Edit ${ticket.key}`} open={editing} onOpenChange={setEditing}>
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
    <div className="flex flex-wrap items-center gap-2">
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
            <FormActions
              error={recover.error}
              pending={!confirmed}
              submitLabel="Recover ownership"
              submitDisabled={recover.isPending}
            />
          </form>
        </Modal>
      )}
    </div>
  );
}
