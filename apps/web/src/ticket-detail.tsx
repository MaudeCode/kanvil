import { TicketContextMenu, copyTicket } from "./components/object-context-menu.tsx";
import {
  Bell,
  BellOff,
  Pencil,
  ArrowLeft,
  MoreHorizontal,
  Check as CheckIcon,
  ChevronUp,
  ChevronDown,
  Archive,
  ArchiveRestore,
  Maximize2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
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
  Textarea,
  FormActions,
  reportError,
  ticketTitleClass,
} from "./ui.tsx";
import { TicketEditor } from "./ticket-editor.tsx";
import { Relations } from "./relations.tsx";
import { Discussion } from "./discussion.tsx";
import { Attachments, Evidence, Activity, Links } from "./ticket-resources.tsx";
import {
  CustomFieldProperties,
  PropertyValue,
  TagsProperty,
  TicketProperty,
  statusValue,
  useTicketChange,
} from "./components/ticket-property.tsx";
import { useShortcut } from "./hooks/use-shortcut.ts";
import { ScheduleDates } from "./components/date-picker.tsx";
import { copyText } from "./lib/browser.ts";
import { readListOrder } from "./lib/list-order.ts";
import { copyLink } from "./lib/actions.ts";

// The detail as a sheet over a ticket list: the list supplies the order and owns the URL.
export interface TicketPreview {
  order: string[];
  open: (ticketId: string) => void;
  close: () => void;
}
// The preview sheet over a list that stays mounted. `ticket` is the last one shown, so it stays
// rendered while the sheet closes; `returnFocus` names the list row focus goes back to.
export function TicketPreviewSheet({
  open,
  ticket,
  order,
  onOpen,
  onClose,
  returnFocus,
}: {
  open: boolean;
  ticket: { id: string; projectId?: string | undefined } | undefined;
  order: string[];
  onOpen: (ticketId: string) => void;
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        aria-label="Ticket preview"
        showCloseButton={false}
        // The list stays readable beside the preview, so the backdrop only dims it.
        overlayClassName="supports-backdrop-filter:backdrop-blur-none"
        className="w-full! gap-0 outline-none sm:max-w-[960px]!"
        finalFocus={() => returnFocus() ?? true}
      >
        <div className="@container min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-3 pb-8 max-[650px]:px-4">
          {ticket &&
            (ticket.projectId ? (
              <TicketDetail
                key={ticket.id}
                projectId={ticket.projectId}
                ticketId={ticket.id}
                preview={{ order, open: onOpen, close: onClose }}
              />
            ) : (
              <EmptyState title="Ticket unavailable">
                <p>The link does not name the ticket's project.</p>
                <Button onClick={onClose}>Close preview</Button>
              </EmptyState>
            ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
export function TicketDetail({
  projectId,
  ticketId,
  preview,
}: {
  projectId: string;
  ticketId: string;
  preview?: TicketPreview;
}) {
  const access = useProjectAccess(projectId);
  const result = useQuery(api.query("get_ticket", { projectId, ticketId }));
  const subscribe = useOperation("set_subscription");
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  // The list the reader came from, so previous and next walk it in the order they saw.
  const [storedOrder] = useState(() => (preview ? [] : readListOrder(projectId)));
  const order = preview?.order ?? storedOrder;
  const position = order.indexOf(ticketId);
  const step = (delta: number) => {
    const target = position < 0 ? undefined : order[position + delta];
    if (!target) return;
    if (preview) preview.open(target);
    else
      void navigate({
        to: "/projects/$projectId/tickets/$ticketId",
        params: { projectId, ticketId: target },
      });
  };
  // A preview's shortcuts fire inside the sheet that hosts it.
  const scope = preview ? '[data-slot="sheet-content"]' : undefined;
  useShortcut("j", () => step(1), { enabled: !editing, scope });
  useShortcut("k", () => step(-1), { enabled: !editing, scope });
  const ticket = result.data?.ticket;
  const { change, pending } = useTicketChange(ticket ?? { id: ticketId, projectId, version: 1 });
  useShortcut(
    "e",
    () => {
      if (access.canWrite) setEditing(true);
    },
    { enabled: !!ticket && !editing, scope },
  );
  if (result.isPending) return <Loading />;
  // A refetch that finds the ticket deleted or out of reach drops its cached content too.
  const gone = result.error instanceof ApiError && result.error.status === 404;
  if (!result.data || !ticket || gone)
    return gone ? (
      <EmptyState title="Ticket unavailable">
        <p>This ticket was deleted or you no longer have access.</p>
        {preview ? (
          <Button onClick={preview.close}>Close preview</Button>
        ) : (
          <Button render={<Link to="/projects/$projectId" params={{ projectId }} />}>
            Back to tickets
          </Button>
        )}
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
              !preview && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-2 text-muted-foreground"
                  render={<Link to="/projects/$projectId" params={{ projectId }} />}
                >
                  <ArrowLeft />
                  Tickets
                </Button>
              )
            }
          >
            <div className="ml-auto flex flex-wrap items-center gap-2">
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
                label={copyLink.label}
                onClick={() => {
                  void copyTicket(copyLink, ticket);
                }}
              >
                <copyLink.icon />
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
              {preview && (
                <>
                  <IconButton
                    label="Open in full page"
                    render={
                      <Link
                        to="/projects/$projectId/tickets/$ticketId"
                        params={{ projectId, ticketId: ticket.id }}
                      />
                    }
                  >
                    <Maximize2 />
                  </IconButton>
                  <IconButton label="Close preview" shortcut="Esc" onClick={preview.close}>
                    <X />
                  </IconButton>
                </>
              )}
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
                <PropertyValue
                  property="status"
                  value={statusValue(ticket)}
                  projectId={projectId}
                />
                {ticket.archived && <strong>Archived</strong>}
                {pending && <Spinner className="size-3.5 text-muted-foreground" />}
              </div>
              {preview ? (
                <SheetTitle render={<h1 />} className={ticketTitleClass}>
                  {ticket.title}
                </SheetTitle>
              ) : (
                <h1 className={ticketTitleClass}>{ticket.title}</h1>
              )}
            </header>
          </TicketContextMenu>
          <div className="min-w-0 [&>section:first-child]:border-0 [&>section:first-child]:pt-0">
            <section>
              <h2>Description</h2>
              <Markdown
                {...(editable
                  ? { onChange: (description: string) => change({ description }) }
                  : {})}
              >
                {ticket.description || "_No description_"}
              </Markdown>
            </section>
            <section>
              <h2>Acceptance criteria</h2>
              <Markdown
                {...(editable
                  ? { onChange: (acceptanceCriteria: string) => change({ acceptanceCriteria }) }
                  : {})}
              >
                {ticket.acceptanceCriteria || "_No acceptance criteria_"}
              </Markdown>
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
              value={statusValue(ticket)}
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
            <ScheduleDates
              variant="row"
              value={ticket}
              disabled={!editable}
              onChange={(dates) => void change(dates)}
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
            <CustomFieldProperties
              variant="row"
              projectId={projectId}
              values={ticket.customFields}
              disabled={!editable}
              onChange={(fieldId, value) => void change({ customFields: { [fieldId]: value } })}
            />
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
          <Links ticket={ticket} />
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
