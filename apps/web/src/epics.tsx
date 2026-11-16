import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useNavigate } from "@tanstack/react-router";
import { Archive, ArrowLeft, Layers, Pencil, Plus } from "lucide-react";
import type { Epic, Input, Output } from "@kanvil/contracts";
import { formatNumber, t } from "@kanvil/contracts/i18n";
import { api, useOperation, useWorkspaceAccess } from "./data.tsx";
import { Discussion } from "./discussion.tsx";
import { submitOnModEnter } from "./forms.ts";
import { MarkdownField } from "./components/markdown-field.tsx";
import { usePreviewCollection, useTicketPreview } from "./components/ticket-preview.tsx";
import { TicketLink } from "./components/ticket-link.tsx";
import {
  PropertyValue,
  TicketProperty,
  parseStatus,
  statusValue,
  useWorkspaceEpics,
} from "./components/ticket-property.tsx";
import {
  EmptyState,
  ErrorNotice,
  FormActions,
  IconButton,
  Input as TextInput,
  Loading,
  Markdown,
  Modal,
  PageHeader,
  SectionHeading,
  reportError,
} from "./ui.tsx";

// TicketDetail owns project workflows and claims. Epics use workspace authorization and reuse
// its property, Markdown, discussion and ticket-reference components instead of fabricating a ticket.
export function Epics() {
  const { workspaceId = "" } = useParams({ strict: false });
  const epics = useWorkspaceEpics(workspaceId);
  const access = useWorkspaceAccess(workspaceId);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title={t("settings.lifecycle.row.epics")}>
        {access.canWrite && (
          <IconButton label={t("detail.epic.create")} onClick={() => setCreating(true)}>
            <Plus />
          </IconButton>
        )}
      </PageHeader>
      <ErrorNotice error={epics.error} />
      {epics.isPending ? (
        <Loading />
      ) : epics.data?.length ? (
        <ul className="m-0 list-none divide-y border-y p-0">
          {epics.data.map((epic) => (
            <li key={epic.id} className="flex flex-wrap items-center gap-3 py-3">
              <PropertyValue property="status" value={epic.status} projectId="" />
              <Link
                to="/workspaces/$workspaceId/epics/$epicId"
                params={{ workspaceId, epicId: epic.id }}
                className="min-w-0 flex-1 break-words font-medium hover:text-primary"
              >
                {epic.title}
              </Link>
              {epic.archived && (
                <span className="text-xs text-muted-foreground">{t("detail.page.archived")}</span>
              )}
              <span className="text-xs text-muted-foreground tabular-nums">
                {t("detail.epic.progress", {
                  closed: epic.closedTickets,
                  total: epic.openTickets + epic.closedTickets,
                })}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        !epics.error && <EmptyState title={t("detail.epic.empty")} icon={Layers} />
      )}
      {creating && <EpicEditor workspaceId={workspaceId} onClose={() => setCreating(false)} />}
    </>
  );
}

export function EpicDetail() {
  const { workspaceId = "", epicId = "" } = useParams({ strict: false });
  const result = useQuery(api.query("get_epic", { workspaceId, epicId }));
  const access = useWorkspaceAccess(workspaceId),
    update = useOperation("update_epic");
  const [editing, setEditing] = useState(false);
  const members = useQuery({
    ...api.query("list_epic_tickets", { workspaceId, epicId }),
    queryFn: async ({ signal }) => {
      const items: Output<"list_epic_tickets">["items"] = [];
      let total = Infinity,
        restrictedCount = 0;
      while (items.length < total) {
        const page = await api.call(
          "list_epic_tickets",
          { workspaceId, epicId, limit: 100, offset: items.length },
          signal,
        );
        items.push(...page.items);
        restrictedCount = page.restrictedCount;
        total = page.items.length ? page.total : items.length;
      }
      return { items, restrictedCount };
    },
  });
  const preview = useTicketPreview(),
    list = useRef<HTMLUListElement>(null),
    activeTicket = useRef<string | null>(null);
  usePreviewCollection(
    members.data?.items.map((ticket) => ticket.id) ?? [],
    (id) => {
      const ticket = members.data?.items.find((row) => row.id === id);
      activeTicket.current = id;
      if (ticket) preview?.open({ projectId: ticket.projectId, ticketId: ticket.id });
    },
    () =>
      (activeTicket.current
        ? document
            .getElementById(`epic-ticket-${activeTicket.current}`)
            ?.querySelector<HTMLElement>("a")
        : list.current?.querySelector<HTMLElement>("a")) ?? null,
  );
  const epic = result.data;
  const change = (
    fields: Omit<Input<"update_epic">, "workspaceId" | "epicId" | "expectedVersion" | "requestId">,
  ) => {
    if (epic)
      void update
        .mutateAsync({ workspaceId, epicId, expectedVersion: epic.version, ...fields })
        .catch(reportError);
  };
  if (result.isPending) return <Loading />;
  if (!epic) return <ErrorNotice error={result.error} />;
  return (
    <>
      <PageHeader title={epic.title}>
        <IconButton
          label={t("settings.lifecycle.row.epics")}
          render={<Link to="/workspaces/$workspaceId/epics" params={{ workspaceId }} />}
        >
          <ArrowLeft />
        </IconButton>
        {access.canWrite && (
          <>
            <IconButton label={t("detail.epic.edit")} onClick={() => setEditing(true)}>
              <Pencil />
            </IconButton>
            <IconButton
              label={epic.archived ? t("detail.epic.restore") : t("detail.epic.archive")}
              disabled={update.isPending}
              onClick={() => change({ archived: !epic.archived })}
            >
              <Archive />
            </IconButton>
          </>
        )}
      </PageHeader>
      <ErrorNotice error={result.error} />
      <div className="mb-7 flex flex-wrap items-center gap-2">
        <TicketProperty
          property="status"
          value={epic.status}
          workspaceId={workspaceId}
          disabled={!access.canWrite || update.isPending}
          onChange={(value) => change({ status: parseStatus(value).status })}
        />
        <TicketProperty
          property="priority"
          value={epic.priority}
          workspaceId={workspaceId}
          disabled={!access.canWrite || update.isPending}
          onChange={(priority) => change({ priority })}
        />
        <TicketProperty
          property="assignee"
          value={epic.assigneeId}
          workspaceId={workspaceId}
          disabled={!access.canWrite || update.isPending}
          onChange={(assigneeId) => change({ assigneeId })}
        />
        {epic.archived && (
          <span className="text-xs text-muted-foreground">{t("detail.page.archived")}</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {t("detail.epic.progress", {
            closed: epic.closedTickets,
            total: epic.openTickets + epic.closedTickets,
          })}
        </span>
      </div>
      <div className="mx-auto max-w-4xl space-y-8">
        <section>
          <SectionHeading title={t("detail.field.description")} />
          <Markdown>{epic.description || t("detail.page.noDescription")}</Markdown>
        </section>
        <section>
          <SectionHeading title={t("detail.field.acceptanceCriteria")} />
          <Markdown>{epic.acceptanceCriteria || t("detail.page.noAcceptanceCriteria")}</Markdown>
        </section>
        <section>
          <SectionHeading title={t("detail.page.tickets")} />
          <ErrorNotice error={members.error} />
          {members.isPending ? (
            <Loading />
          ) : (
            members.data && (
              <>
                {members.data.restrictedCount > 0 && (
                  <p className="text-sm text-muted-foreground">
                    {t("detail.epic.restricted", {
                      total: formatNumber(members.data.restrictedCount),
                    })}
                  </p>
                )}
                {members.data.items.length ? (
                  <ul ref={list} className="m-0 list-none divide-y border-y p-0">
                    {members.data.items.map((ticket) => (
                      <li
                        id={`epic-ticket-${ticket.id}`}
                        key={ticket.id}
                        className="flex items-start gap-3 py-3"
                      >
                        <PropertyValue
                          property="status"
                          value={statusValue(ticket)}
                          projectId={ticket.projectId}
                        />
                        <TicketLink
                          projectId={ticket.projectId}
                          ticketId={ticket.id}
                          ticket={ticket}
                          className="min-w-0 break-words"
                        >
                          <span className="mr-2 text-xs text-muted-foreground">{ticket.key}</span>{" "}
                          {ticket.title}
                        </TicketLink>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState title={t("detail.epic.noTickets")} />
                )}
              </>
            )
          )}
        </section>
        <section>
          <SectionHeading title={t("detail.section.discussion")} />
          <Discussion epic={epic} />
        </section>
      </div>
      {editing && (
        <EpicEditor workspaceId={workspaceId} epic={epic} onClose={() => setEditing(false)} />
      )}
    </>
  );
}

function EpicEditor({
  workspaceId,
  epic,
  onClose,
}: {
  workspaceId: string;
  epic?: Epic;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(epic?.title ?? ""),
    [description, setDescription] = useState(epic?.description ?? ""),
    [acceptanceCriteria, setAcceptanceCriteria] = useState(epic?.acceptanceCriteria ?? "");
  const create = useOperation("create_epic"),
    update = useOperation("update_epic"),
    navigate = useNavigate();
  const operation = epic ? update : create;
  return (
    <Modal
      title={epic ? t("detail.epic.edit") : t("detail.epic.create")}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      busy={operation.isPending}
      size="composer"
    >
      <form
        className="flex min-h-0 flex-col"
        onKeyDown={submitOnModEnter}
        onSubmit={(event) => {
          event.preventDefault();
          const fields = { workspaceId, title, description, acceptanceCriteria };
          const save = epic
            ? update.mutateAsync({ ...fields, epicId: epic.id, expectedVersion: epic.version })
            : create.mutateAsync(fields);
          void save
            .then((saved) => {
              onClose();
              if (!epic)
                void navigate({
                  to: "/workspaces/$workspaceId/epics/$epicId",
                  params: { workspaceId, epicId: saved.id },
                });
            })
            .catch(() => {});
        }}
      >
        <div className="min-h-0 space-y-4 overflow-y-auto p-5">
          <TextInput
            label={t("detail.field.title")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            required
            autoFocus
          />
          <MarkdownField
            label={t("detail.field.description")}
            value={description}
            onChange={setDescription}
            maxLength={100000}
            rows={4}
          />
          <MarkdownField
            label={t("detail.field.acceptanceCriteria")}
            value={acceptanceCriteria}
            onChange={setAcceptanceCriteria}
            maxLength={100000}
            rows={4}
          />
        </div>
        <div className="shrink-0 border-t px-5 pb-4">
          <FormActions
            error={operation.error}
            pending={operation.isPending}
            submitLabel={epic ? t("common.action.save") : t("detail.epic.create")}
            onCancel={onClose}
            submitDisabled={!title.trim()}
          />
        </div>
      </form>
    </Modal>
  );
}
