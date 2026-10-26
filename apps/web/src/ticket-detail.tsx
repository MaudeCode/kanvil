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
} from "lucide-react";
import { toast } from "sonner";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useRouterState } from "@tanstack/react-router";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import { SheetTitle } from "@/components/ui/sheet";
import { Trans } from "react-i18next";
import { type Ticket, ApiError, readinessReasonText } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
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
import {
  PreviewActions,
  type PreviewTarget,
  type TicketPreview,
} from "./components/ticket-preview.tsx";

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
  // A refetch that finds the ticket deleted or out of reach drops its cached content too.
  const gone = result.error instanceof ApiError && result.error.status === 404;
  // A link from before a move follows the ticket when the reader can still reach it.
  const moved = useQuery({
    ...api.query("resolve_ticket", { ticketId }),
    enabled: gone,
    retry: false,
  });
  // While a preview is open, the URL's anchor belongs to the previewed ticket.
  const anchor = useRouterState({
    select: (state) => (preview || !state.location.search.peek ? state.location.hash : ""),
  });
  if (result.isPending || (gone && moved.isFetching)) return <Loading />;
  if (gone && moved.data && moved.data.project.id !== projectId)
    return preview ? (
      <Follow
        preview={preview}
        target={{ projectId: moved.data.project.id, ticketId: moved.data.ticket.id }}
      />
    ) : (
      <Navigate
        to="/projects/$projectId/tickets/$ticketId"
        params={{ projectId: moved.data.project.id, ticketId: moved.data.ticket.id }}
        replace
      />
    );
  if (!result.data || !ticket || gone)
    return gone ? (
      <EmptyState title={t("detail.page.unavailable")}>
        <p>{t("detail.page.gone")}</p>
        {preview ? (
          <Button onClick={preview.close}>{t("detail.page.closePreview")}</Button>
        ) : (
          <Button render={<Link to="/projects/$projectId" params={{ projectId }} />}>
            {t("detail.page.backToTickets")}
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
          {t("common.action.retry")}
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
                  {t("detail.page.tickets")}
                </Button>
              )
            }
          >
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {position >= 0 && (
                <div className="mr-1 flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums">
                  <IconButton
                    label={t("detail.page.previousTicket")}
                    title={t("detail.page.previousTicketShortcut")}
                    disabled={position === 0}
                    onClick={() => step(-1)}
                  >
                    <ChevronUp />
                  </IconButton>
                  <span>
                    {t("detail.page.position", { position: position + 1, total: order.length })}
                  </span>
                  <IconButton
                    label={t("detail.page.nextTicket")}
                    title={t("detail.page.nextTicketShortcut")}
                    disabled={position === order.length - 1}
                    onClick={() => step(1)}
                  >
                    <ChevronDown />
                  </IconButton>
                </div>
              )}
              <IconButton
                label={following ? t("detail.page.unsubscribe") : t("detail.page.subscribe")}
                disabled={subscribe.isPending}
                onClick={() => {
                  void subscribe
                    .mutateAsync({ projectId, ticketId: ticket.id, enabled: !following })
                    .then(() =>
                      toast.success(
                        following ? t("detail.page.unsubscribed") : t("detail.page.subscribed"),
                      ),
                    )
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
                label={ticket.archived ? t("detail.page.unarchive") : t("detail.page.archive")}
                disabled={!editable}
                onClick={() => {
                  void change({ archived: !ticket.archived }).then((saved) => {
                    if (saved)
                      toast.success(
                        ticket.archived
                          ? t("detail.page.unarchivedToast")
                          : t("detail.page.archivedToast"),
                      );
                  });
                }}
              >
                {ticket.archived ? <ArchiveRestore /> : <Archive />}
              </IconButton>
              <IconButton
                label={t("detail.page.edit")}
                title={t("detail.page.editShortcut")}
                disabled={!access.canWrite}
                onClick={() => setEditing(true)}
              >
                <Pencil />
              </IconButton>
              <TicketContextMenu ticket={ticket} variant="dropdown" onEdit={() => setEditing(true)}>
                <Button variant="ghost" size="icon" aria-label={t("detail.page.actions")}>
                  <MoreHorizontal />
                </Button>
              </TicketContextMenu>
              {preview && (
                <PreviewActions projectId={projectId} ticketId={ticket.id} preview={preview} />
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
                  title={t("detail.page.copyKey")}
                  onClick={() => {
                    void copyText(ticket.key)
                      .then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                        toast.success(t("detail.page.keyCopied", { key: ticket.key }));
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
                {ticket.archived && <strong>{t("detail.page.archived")}</strong>}
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
              <h2>{t("detail.field.description")}</h2>
              <Markdown
                {...(editable
                  ? { onChange: (description: string) => change({ description }) }
                  : {})}
              >
                {ticket.description || t("detail.page.noDescription")}
              </Markdown>
            </section>
            <section>
              <h2>{t("detail.field.acceptanceCriteria")}</h2>
              <Markdown
                {...(editable
                  ? { onChange: (acceptanceCriteria: string) => change({ acceptanceCriteria }) }
                  : {})}
              >
                {ticket.acceptanceCriteria || t("detail.page.noAcceptanceCriteria")}
              </Markdown>
            </section>
          </div>
          <Tabs
            defaultValue="discussion"
            className="mt-8 min-w-0 [&_[data-slot=tabs-content]>section]:border-0 [&_[data-slot=tabs-content]>section]:pt-0"
          >
            <TabsList variant="line" className="mb-5">
              <TabsTrigger value="discussion">{t("detail.section.discussion")}</TabsTrigger>
              <TabsTrigger value="evidence">{t("detail.section.evidence")}</TabsTrigger>
              <TabsTrigger value="activity">{t("detail.section.activity")}</TabsTrigger>
            </TabsList>
            <TabsContent value="discussion" className="animate-in fade-in-0 duration-150">
              <Discussion ticket={ticket} anchor={anchor} />
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
          aria-label={t("detail.page.coordination")}
        >
          <section aria-label={t("detail.page.properties")} className="ticket-properties">
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
              <dt>{t("detail.page.created")}</dt>
              <dd>
                <ActorName projectId={projectId} actorId={ticket.createdBy} />
                {" · "}
                <RelativeTime value={ticket.createdAt} />
              </dd>
              <dt>{t("detail.page.updated")}</dt>
              <dd>
                <RelativeTime value={ticket.updatedAt} />
              </dd>
            </dl>
          </section>
          <section>
            <h2>{t("detail.readiness.heading")}</h2>
            <p className={readiness.ready ? "text-[var(--success)]" : "text-muted-foreground"}>
              {readiness.ready ? t("detail.readiness.ready") : t("detail.readiness.notReady")}
            </p>
            <ul>
              {readiness.reasons.map((reason, index) => (
                <li key={`${reason.code}:${index}`}>
                  {readinessReasonText(reason, claim?.workerId)}
                </li>
              ))}
            </ul>
            {ticket.holdReason && (
              <p>{t("detail.readiness.hold", { reason: ticket.holdReason })}</p>
            )}
            {claim && (
              <p>
                <Trans
                  i18nKey="detail.readiness.claimedUntil"
                  values={{ worker: claim.workerId, date: date(claim.expiresAt) }}
                  components={{ strong: <strong /> }}
                />
              </p>
            )}
            {claim && (
              <ClaimActions
                ticket={ticket}
                claim={claim}
                canRelease={canReleaseClaim}
                canRecover={
                  access.canWrite &&
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
      <Modal
        size="composer"
        title={t("detail.page.editTitle", { key: ticket.key })}
        open={editing}
        onOpenChange={setEditing}
      >
        {editing && (
          <TicketEditor projectId={projectId} ticket={ticket} onSaved={() => setEditing(false)} />
        )}
      </Modal>
    </>
  );
}
// A preview follows a moved ticket in place, as the full page redirects to it.
function Follow({ preview, target }: { preview: TicketPreview; target: PreviewTarget }) {
  useEffect(() => preview.follow(target), [preview, target]);
  return <Loading />;
}
// Reasons the server names by code read in the interface language. A hold is the ticket's own
// text, and a dependency's message names its blocker, so those keep the server's wording.
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
          label={t("detail.claim.release")}
          description={t("detail.claim.releaseDescription")}
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
        <Modal title={t("detail.claim.recover")} trigger={t("detail.claim.recover")}>
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
            <p>{t("detail.claim.recoverHelp")}</p>
            <Textarea
              label={t("detail.claim.reason")}
              required
              minLength={10}
              maxLength={2000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <Check
              label={t("detail.claim.confirmed")}
              checked={confirmed}
              onCheckedChange={(checked) => setConfirmed(checked)}
            />
            <FormActions
              error={recover.error}
              pending={!confirmed}
              submitLabel={t("detail.claim.submit")}
              submitDisabled={recover.isPending}
            />
          </form>
        </Modal>
      )}
    </div>
  );
}
