import { TicketPicker } from "./components/ticket-picker.tsx";
import { TicketLink } from "./components/ticket-link.tsx";
import {
  PropertyValue,
  TicketProperty,
  statusValue,
  useTicketChange,
} from "./components/ticket-property.tsx";
import { Unlink, Plus, GitBranchPlus, CornerLeftUp } from "lucide-react";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  relationReference,
  relationChoices,
  parseRelationChoice,
  type Ticket,
} from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { Trans } from "react-i18next";
import { api, useOperation, useProjectAccess } from "./data.tsx";
import {
  Button,
  IconButton,
  ErrorNotice,
  Loading,
  Modal,
  Select,
  SelectItem,
  SectionHeading,
  FormActions,
} from "./ui.tsx";
import { Item, ItemContent, ItemActions, ItemGroup } from "@/components/ui/item";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
const TicketEditor = lazy(() =>
  import("./ticket-editor.tsx").then((module) => ({ default: module.TicketEditor })),
);

export function Relations({ ticket }: { ticket: Ticket }) {
  const access = useProjectAccess(ticket.projectId);
  const relations = useQuery(
    api.query("list_relations", { projectId: ticket.projectId, ticketId: ticket.id }),
  );
  const [open, setOpen] = useState(false),
    [creatingChild, setCreatingChild] = useState(false),
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
  // Linked tickets arrive in bounded batches, not one read per relationship row.
  const linked = useQueries({
    queries: Array.from({ length: Math.ceil((relations.data?.length ?? 0) / 100) }, (_, page) =>
      api.query("list_tickets", {
        projectId: ticket.projectId,
        relatedTo: ticket.id,
        archived: "include",
        sort: "number",
        limit: 100,
        offset: page * 100,
      }),
    ),
  });
  const linkedTickets = new Map(
    linked.flatMap((page) => page.data?.items ?? []).map((item) => [item.id, item]),
  );
  const add = useOperation("add_relation"),
    remove = useOperation("remove_relation");
  return (
    <section>
      <SectionHeading
        compact
        title={t("detail.relations.heading")}
        action={
          access.canWrite && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<IconButton label={t("detail.relations.add")} />}>
                <Plus />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  onClick={() => {
                    add.reset();
                    setValidationError(undefined);
                    setTarget(null);
                    setOpen(true);
                  }}
                >
                  <Unlink />
                  {t("detail.relations.linkExisting")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setCreatingChild(true)}>
                  <GitBranchPlus />
                  {t("detail.relations.newChild")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
      />
      {ticket.parentId && (
        <Item size="xs" className="px-0">
          <CornerLeftUp className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <ItemContent className="min-w-0">
            <span className="text-xs text-muted-foreground">{t("detail.field.parent")}</span>
            <TicketLink
              projectId={ticket.projectId}
              ticketId={ticket.parentId}
              ticket={parent.data?.ticket}
            />
          </ItemContent>
        </Item>
      )}
      {children.data && (children.data.total > 0 || offset > 0) && (
        <>
          <h3 className="mt-3 mb-1 text-xs text-muted-foreground">
            <Trans
              i18nKey="detail.relations.children"
              values={{
                done: children.data.items.filter((child) => child.status === "done").length,
                total: children.data.total,
              }}
              components={{ count: <span className="tabular-nums" /> }}
            />
          </h3>
          <ItemGroup className="gap-0">
            {children.data.items.map((child) => (
              <ReferenceRow
                key={child.id}
                projectId={ticket.projectId}
                ticketId={child.id}
                ticket={child}
                canWrite={access.canWrite}
              >
                <TicketLink projectId={ticket.projectId} ticketId={child.id} ticket={child} />
              </ReferenceRow>
            ))}
          </ItemGroup>
          {(children.data.total > 20 || offset > 0) && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 20))}
              >
                {t("detail.relations.previousChildren")}
              </Button>
              <Button
                size="sm"
                disabled={offset + 20 >= children.data.total}
                onClick={() => setOffset(offset + 20)}
              >
                {t("detail.relations.nextChildren")}
              </Button>
            </div>
          )}
        </>
      )}
      <ItemGroup className="gap-0">
        {relations.data?.map((relation) => {
          const reference = relationReference(relation, ticket.id),
            projectId = reference.projectId ?? ticket.projectId;
          return (
            <ReferenceRow
              key={relation.id}
              projectId={projectId}
              ticketId={reference.id}
              ticket={linkedTickets.get(reference.id)}
              canWrite={access.canWrite}
              label={reference.label}
              action={
                <IconButton
                  size="icon-sm"
                  label={t(`detail.relations.remove.${relation.type}`)}
                  onClick={() =>
                    remove.mutate({ projectId: ticket.projectId, relationId: relation.id })
                  }
                >
                  <Unlink />
                </IconButton>
              }
            >
              {reference.restricted ? (
                <span className="text-muted-foreground">{reference.title}</span>
              ) : (
                <TicketLink projectId={projectId} ticketId={reference.id}>
                  {reference.title}
                </TicketLink>
              )}
            </ReferenceRow>
          );
        })}
      </ItemGroup>
      {!ticket.parentId && !children.data?.total && relations.data?.length === 0 && (
        <p className="mb-0 text-xs text-muted-foreground">{t("detail.relations.empty")}</p>
      )}
      <Modal
        title={t("detail.relations.add")}
        open={open}
        onOpenChange={setOpen}
        busy={add.isPending}
      >
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
                ...parseRelationChoice(form.get("type")),
              })
              .then(() => setOpen(false))
              .catch(setValidationError);
          }}
        >
          <Select label={t("detail.relations.type")} name="type">
            {relationChoices.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </Select>
          <TicketPicker
            projectId={ticket.projectId}
            label={t("detail.relations.ticket")}
            value={target}
            onChange={setTarget}
            exclude={[ticket.id]}
            allowClear={false}
          />

          <FormActions
            error={validationError ?? add.error}
            pending={add.isPending}
            submitLabel={t("detail.relations.add")}
            submitDisabled={!target}
            onCancel={() => setOpen(false)}
          />
        </form>
      </Modal>
      <Modal
        size="composer"
        title={t("detail.relations.newChildTitle", { key: ticket.key })}
        open={creatingChild}
        onOpenChange={setCreatingChild}
      >
        {creatingChild && (
          <Suspense fallback={<Loading />}>
            <TicketEditor
              projectId={ticket.projectId}
              initial={{ parentId: ticket.id, labels: ticket.labels, scopes: ticket.scopes }}
              onSaved={() => setCreatingChild(false)}
            />
          </Suspense>
        )}
      </Modal>
      <ErrorNotice
        error={
          relations.error ??
          remove.error ??
          parent.error ??
          children.error ??
          linked.find((page) => page.error)?.error
        }
      />
    </section>
  );
}

// A child or linked ticket whose status and assignee edit in place for writers.
function ReferenceRow({
  projectId,
  ticketId,
  ticket: current,
  canWrite,
  label,
  action,
  children,
}: {
  projectId: string;
  ticketId: string;
  ticket: Ticket | undefined;
  canWrite: boolean;
  label?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const { change, pending } = useTicketChange({
    id: ticketId,
    projectId,
    version: current?.version ?? 0,
  });
  const editable = canWrite && current;
  return (
    <Item size="xs" className="px-0">
      {editable ? (
        <TicketProperty
          property="status"
          value={statusValue(current)}
          onChange={(status) => void change({ status })}
          projectId={projectId}
          disabled={pending}
          variant="cell"
          iconOnly
          ariaLabel={t("detail.relations.statusOf", { key: current.key })}
          className="mx-0"
        />
      ) : (
        current && (
          <PropertyValue
            property="status"
            value={statusValue(current)}
            projectId={projectId}
            iconOnly
          />
        )
      )}
      <ItemContent className="min-w-0 gap-0">
        {label && <span className="text-xs text-muted-foreground">{label}</span>}
        {children}
      </ItemContent>
      {(editable || current?.assigneeId || (canWrite && action)) && (
        <ItemActions className="gap-0">
          {editable ? (
            <TicketProperty
              property="assignee"
              value={current.assigneeId}
              onChange={(assignee) => void change({ assignee })}
              projectId={projectId}
              disabled={pending}
              variant="cell"
              iconOnly
              align="end"
              ariaLabel={t("detail.relations.assigneeOf", { key: current.key })}
              className="mx-0"
            />
          ) : (
            current?.assigneeId && (
              <PropertyValue
                property="assignee"
                value={current.assigneeId}
                projectId={projectId}
                iconOnly
              />
            )
          )}
          {canWrite && action}
        </ItemActions>
      )}
    </Item>
  );
}
