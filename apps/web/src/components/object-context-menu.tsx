import { lazy, Suspense, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpToLine,
  Bell,
  BellOff,
  CalendarDays,
  Copy,
  CopyPlus,
  ExternalLink,
  FolderInput,
  FolderOpen,
  PanelRight,
  Link2,
  Pencil,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { type Ticket, type Project, type Output } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { useQueryClient } from "@tanstack/react-query";
import { api, projectsQuery, useOperation, useProjectAccess, useProjects } from "../data.tsx";
import { Confirm, Modal, Loading, reportError } from "../ui.tsx";
import {
  PropertyValue,
  pair,
  propertyChange,
  propertyIcons,
  propertyLabels,
  propertyOf,
  propertyOrder,
  usePropertyOptions,
  useTicketChange,
  type PropertyName,
  type TicketChange,
} from "./ticket-property.tsx";
import { DateCalendar, endOfDay } from "./date-picker.tsx";
import { TicketMoveForm } from "./ticket-move.tsx";
const TicketEditor = lazy(() =>
  import("../ticket-editor.tsx").then((module) => ({ default: module.TicketEditor })),
);
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import { copyText } from "../lib/browser.ts";
import {
  moveCommandNames,
  moveCommands,
  ticketCopyActions,
  type CopyAction,
  type CopySource,
  type MoveCommand,
} from "../lib/actions.ts";
import { neighborFor, placeNear } from "../lib/list-order.ts";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuGroup,
  ContextMenuLabel,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
// A property submenu built from the same options, icons, and value renderer as TicketProperty.
function PropertyMenu({
  property,
  ticket,
  enabled,
  disabled,
  onChange,
}: {
  property: PropertyName;
  ticket: Ticket;
  enabled: boolean;
  disabled: boolean;
  onChange: (changes: TicketChange) => void;
}) {
  const options = usePropertyOptions(property, ticket.projectId, enabled),
    current = propertyOf(ticket, property);
  const Icon = propertyIcons[property];
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger disabled={disabled}>
        <Icon />
        {propertyLabels[property]}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ContextMenuRadioGroup
          value={String(options.findIndex((option) => option.value === current))}
          onValueChange={(index) => {
            const option = options[Number(index)];
            if (option) onChange(propertyChange(property, option.value));
          }}
        >
          {options.map((option, index) => (
            <ContextMenuRadioItem key={String(option.value)} value={String(index)}>
              <PropertyValue {...pair(property, option.value)} projectId={ticket.projectId} />
            </ContextMenuRadioItem>
          ))}
        </ContextMenuRadioGroup>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
async function copy(value: string, label: string) {
  try {
    await copyText(value);
    toast.success(t("ticket.menu.copied", { label }));
  } catch (error) {
    reportError(error);
  }
}
export const copyTicket = (action: CopyAction, ticket: CopySource) =>
  copy(action.value(ticket), action.copied);
const moveIcons: Record<MoveCommand, typeof ArrowUp> = {
  top: ArrowUpToLine,
  up: ArrowUp,
  down: ArrowDown,
  bottom: ArrowDownToLine,
  previous: ArrowLeft,
  next: ArrowRight,
};
// Move items for a ticket or project menu; a move with nowhere to go stays listed but disabled.
function MoveItems({
  moves,
  keys = true,
}: {
  moves: { command: MoveCommand; run?: (() => void) | undefined }[];
  keys?: boolean;
}) {
  return moves.map(({ command, run }) => {
    const Icon = moveIcons[command];
    return (
      <ContextMenuItem key={command} disabled={!run} onClick={run}>
        <Icon />
        {moveCommands[command].menu}
        {keys && <ContextMenuShortcut>{moveCommands[command].keys}</ContextMenuShortcut>}
      </ContextMenuItem>
    );
  });
}
// Places a project next to a neighbor of its workspace; the sidebar shows the new order at once.
export function useProjectMove() {
  const move = useOperation("move_project"),
    cache = useQueryClient();
  return {
    pending: move.isPending,
    place: (project: Project, anchor: string, below: boolean) => {
      if (move.isPending) return;
      cache.setQueryData<Output<"list_projects">>(
        projectsQuery().queryKey,
        (rows) => rows && placeNear(rows, project.id, anchor, below),
      );
      void move
        .mutateAsync({
          projectId: project.id,
          expectedVersion: project.version,
          ...(below ? { after: anchor } : { before: anchor }),
        })
        .catch((error: unknown) => {
          void cache.invalidateQueries({ queryKey: ["kanvil"] });
          reportError(error);
        });
    },
  };
}
export function TicketContextMenu({
  ticket,
  children,
  onEdit,
  onPreview,
  moves,
  variant = "context",
}: {
  ticket: Ticket;
  children: ReactElement;
  onEdit?: () => void;
  // Lists open the ticket in their preview sheet.
  onPreview?: () => void;
  // The moves a list offers for this ticket, read when the menu opens.
  moves?: (() => { command: MoveCommand; run?: (() => void) | undefined }[]) | undefined;
  variant?: "context" | "dropdown";
}) {
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState(false),
    [deleting, setDeleting] = useState(false),
    [relocating, setRelocating] = useState(false),
    access = useProjectAccess(ticket.projectId, open),
    navigate = useNavigate();
  const read = useQuery({
    ...api.query("get_ticket", { projectId: ticket.projectId, ticketId: ticket.id }),
    enabled: open,
  });
  // A cached read can be older than the row that opened the menu; use whichever is newer.
  const current =
      read.data && read.data.ticket.version > ticket.version ? read.data.ticket : ticket,
    update = useTicketChange(current),
    remove = useOperation("delete_ticket"),
    duplicate = useOperation("duplicate_ticket"),
    subscribe = useOperation("set_subscription");
  const Root = variant === "dropdown" ? DropdownMenu : ContextMenu,
    Trigger = variant === "dropdown" ? DropdownMenuTrigger : ContextMenuTrigger,
    Content = variant === "dropdown" ? DropdownMenuContent : ContextMenuContent;
  const href = `/projects/${ticket.projectId}/tickets/${ticket.id}`;
  const change = (changes: TicketChange) => void update.change(changes);
  return (
    <>
      <Root open={open} onOpenChange={setOpen}>
        <Trigger render={children} className="select-text" />
        <Content className="w-56">
          <ContextMenuGroup>
            <ContextMenuLabel>{ticket.key}</ContextMenuLabel>
            <ContextMenuItem
              render={
                <Link
                  to="/projects/$projectId/tickets/$ticketId"
                  params={{ projectId: ticket.projectId, ticketId: ticket.id }}
                />
              }
            >
              <FolderOpen />
              {t("ticket.menu.open")}
            </ContextMenuItem>
            {onPreview && (
              <ContextMenuItem onClick={onPreview}>
                <PanelRight />
                {t("ticket.menu.preview")}
              </ContextMenuItem>
            )}
            <ContextMenuItem render={<a href={href} target="_blank" rel="noreferrer" />}>
              <ExternalLink />
              {t("ticket.menu.newTab")}
            </ContextMenuItem>
            {ticketCopyActions.map((action) => (
              <ContextMenuItem key={action.label} onClick={() => void copyTicket(action, current)}>
                <action.icon />
                {action.label}
              </ContextMenuItem>
            ))}
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!access.canWrite}
            onClick={() => (onEdit ? onEdit() : setEditing(true))}
          >
            <Pencil />
            {t("ticket.menu.edit")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!access.canWrite || duplicate.isPending}
            onClick={() => {
              void duplicate
                .mutateAsync({ projectId: current.projectId, ticketId: current.id })
                .then(async (created) => {
                  toast.success(t("ticket.menu.created", { key: created.key }));
                  await navigate({
                    to: "/projects/$projectId/tickets/$ticketId",
                    params: { projectId: created.projectId, ticketId: created.id },
                  });
                })
                .catch(reportError);
            }}
          >
            <CopyPlus />
            {t("ticket.menu.duplicate")}
          </ContextMenuItem>
          {propertyOrder.map((name) => (
            <PropertyMenu
              key={name}
              property={name}
              ticket={current}
              enabled={open && access.canWrite}
              disabled={!access.canWrite || update.pending}
              onChange={change}
            />
          ))}
          {open && moves && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <ArrowUp />
                {t("ticket.menu.move")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-60">
                <MoveItems moves={moves()} />
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          <ContextMenuItem disabled={!access.canWrite} onClick={() => setRelocating(true)}>
            <FolderInput />
            {t("ticket.menu.moveToProject")}
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={!access.canWrite || update.pending}>
              <CalendarDays />
              {t("ticket.date.due")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-auto p-0">
              {/* The calendar keeps its own arrow-key grid; the menu still closes on Escape. */}
              <div
                onKeyDown={(event) => {
                  if (event.key !== "Escape") event.stopPropagation();
                }}
              >
                <DateCalendar
                  label={t("ticket.date.due")}
                  value={current.dueAt ? new Date(current.dueAt) : null}
                  clearable={!!current.dueAt}
                  autoFocus
                  onChange={(date) => {
                    setOpen(false);
                    change({ dueAt: date ? endOfDay(date) : null });
                  }}
                />
              </div>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem
            disabled={!read.data || subscribe.isPending}
            onClick={() => {
              void subscribe
                .mutateAsync({
                  projectId: ticket.projectId,
                  ticketId: ticket.id,
                  enabled: !read.data?.subscribed,
                })
                .catch(reportError);
            }}
          >
            {read.data?.subscribed ? <BellOff /> : <Bell />}
            {read.data?.subscribed ? t("ticket.menu.unfollow") : t("ticket.menu.follow")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!access.canWrite}
            onClick={() => change({ archived: !current.archived })}
          >
            <Archive />
            {current.archived ? t("ticket.menu.unarchive") : t("ticket.menu.archive")}
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            disabled={!access.canDelete}
            onClick={() => setDeleting(true)}
          >
            <Trash2 />
            {t("ticket.menu.delete")}
          </ContextMenuItem>
        </Content>
      </Root>
      <Modal
        size="composer"
        title={t("ticket.menu.editTitle", { key: ticket.key })}
        open={editing}
        onOpenChange={setEditing}
      >
        {editing && (
          <Suspense fallback={<Loading />}>
            <TicketEditor
              projectId={ticket.projectId}
              ticket={current}
              onSaved={() => setEditing(false)}
            />
          </Suspense>
        )}
      </Modal>
      <Modal
        title={t("ticket.menu.moveTitle", { key: ticket.key })}
        open={relocating}
        onOpenChange={setRelocating}
      >
        {relocating && (
          <TicketMoveForm
            ticket={current}
            onCancel={() => setRelocating(false)}
            onMoved={(moved) => {
              setRelocating(false);
              toast.success(t("ticket.menu.moved", { key: moved.key }));
              if (location.pathname === href)
                void navigate({
                  to: "/projects/$projectId/tickets/$ticketId",
                  params: { projectId: moved.projectId, ticketId: moved.id },
                  replace: true,
                });
            }}
          />
        )}
      </Modal>
      <Confirm
        label={t("ticket.menu.delete")}
        danger
        trigger={false}
        open={deleting}
        onOpenChange={setDeleting}
        description={t("ticket.menu.deleteConfirm", { key: ticket.key })}
        onConfirm={async () => {
          await remove.mutateAsync({
            projectId: current.projectId,
            ticketId: current.id,
            expectedVersion: current.version,
          });
          if (location.pathname === href)
            await navigate({
              to: "/projects/$projectId",
              params: { projectId: current.projectId },
            });
        }}
      />
    </>
  );
}
export function ProjectContextMenu({
  project,
  children,
}: {
  project: Project;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false),
    [creating, setCreating] = useState(false),
    access = useProjectAccess(project.id, open),
    siblings = useProjects().data?.map((item) => item.id) ?? [],
    reorder = useProjectMove();
  const moves = moveCommandNames
    .filter((command) => command !== "previous" && command !== "next")
    .map((command) => {
      const target = access.canAdmin ? neighborFor(siblings, project.id, command) : undefined;
      return {
        command,
        run: target && (() => reorder.place(project, target.anchor, target.below)),
      };
    });
  return (
    <>
      <ContextMenu open={open} onOpenChange={setOpen}>
        <ContextMenuTrigger render={children} className="select-text" />
        <ContextMenuContent className="w-56">
          <ContextMenuGroup>
            <ContextMenuLabel dir="auto">{project.name}</ContextMenuLabel>
            <ContextMenuItem
              render={<Link to="/projects/$projectId" params={{ projectId: project.id }} />}
            >
              <FolderOpen />
              {t("ticket.menu.openProject")}
            </ContextMenuItem>
            <ContextMenuItem
              render={<a href={`/projects/${project.id}`} target="_blank" rel="noreferrer" />}
            >
              <ExternalLink />
              {t("ticket.menu.newTab")}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                void copy(
                  new URL(`/projects/${project.id}`, location.origin).href,
                  t("ticket.menu.projectLink"),
                );
              }}
            >
              <Link2 />
              {t("ticket.menu.copyLink")}
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!access.canWrite} onClick={() => setCreating(true)}>
            <Plus />
            {t("ticket.menu.newTicket")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!access.canManage}
            render={<Link to="/projects/$projectId/settings" params={{ projectId: project.id }} />}
          >
            <Settings />
            {t("ticket.menu.projectSettings")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <MoveItems moves={moves} keys={false} />
        </ContextMenuContent>
      </ContextMenu>
      <Modal
        size="composer"
        title={t("ticket.menu.newTicket")}
        open={creating}
        onOpenChange={setCreating}
      >
        {creating && (
          <Suspense fallback={<Loading />}>
            <TicketEditor projectId={project.id} onSaved={() => setCreating(false)} />
          </Suspense>
        )}
      </Modal>
    </>
  );
}

export function UserContextMenu({
  name,
  email,
  onOpen,
  children,
}: {
  name: string;
  email: string;
  onOpen: () => void;
  children: ReactElement;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} className="select-text" />
      <ContextMenuContent className="w-56">
        <ContextMenuGroup>
          <ContextMenuLabel dir="auto">{name}</ContextMenuLabel>
          <ContextMenuItem onClick={onOpen}>
            <Settings />
            {t("ticket.menu.manageAccount")}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              void copy(email, t("ticket.menu.email"));
            }}
          >
            <Copy />
            {t("ticket.menu.copyEmail")}
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}
