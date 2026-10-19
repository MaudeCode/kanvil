import { lazy, Suspense, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  Bell,
  BellOff,
  CalendarDays,
  Copy,
  ExternalLink,
  FolderOpen,
  Link2,
  Pencil,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { type Ticket, type Project } from "@kanvil/contracts";
import { api, useOperation, useProjectAccess } from "../data.tsx";
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
} from "./ticket-property.tsx";
import { DateCalendar, endOfDay } from "./date-picker.tsx";
const TicketEditor = lazy(() =>
  import("../ticket-editor.tsx").then((module) => ({ default: module.TicketEditor })),
);
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import { copyText } from "../lib/browser.ts";
import { ticketCopyActions, type CopyAction, type CopySource } from "../lib/actions.ts";
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
  onChange: (changes: Partial<Ticket>) => void;
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
    toast.success(`${label} copied`);
  } catch (error) {
    reportError(error);
  }
}
export const copyTicket = (action: CopyAction, ticket: CopySource) =>
  copy(action.value(ticket), action.copied);
export function TicketContextMenu({
  ticket,
  children,
  onEdit,
  variant = "context",
}: {
  ticket: Ticket;
  children: ReactElement;
  onEdit?: () => void;
  variant?: "context" | "dropdown";
}) {
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState(false),
    [deleting, setDeleting] = useState(false),
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
    subscribe = useOperation("set_subscription");
  const Root = variant === "dropdown" ? DropdownMenu : ContextMenu,
    Trigger = variant === "dropdown" ? DropdownMenuTrigger : ContextMenuTrigger,
    Content = variant === "dropdown" ? DropdownMenuContent : ContextMenuContent;
  const href = `/projects/${ticket.projectId}/tickets/${ticket.id}`;
  const change = (changes: Partial<Ticket>) => void update.change(changes);
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
              Open ticket
            </ContextMenuItem>
            <ContextMenuItem render={<a href={href} target="_blank" rel="noreferrer" />}>
              <ExternalLink />
              Open in new tab
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
            Edit ticket
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
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={!access.canWrite || update.pending}>
              <CalendarDays />
              Due date
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-auto p-0">
              {/* The calendar keeps its own arrow-key grid; the menu still closes on Escape. */}
              <div
                onKeyDown={(event) => {
                  if (event.key !== "Escape") event.stopPropagation();
                }}
              >
                <DateCalendar
                  label="Due date"
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
            {read.data?.subscribed ? "Unfollow ticket" : "Follow ticket"}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!access.canWrite}
            onClick={() => change({ archived: !current.archived })}
          >
            <Archive />
            {current.archived ? "Unarchive ticket" : "Archive ticket"}
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            disabled={!access.canWrite}
            onClick={() => setDeleting(true)}
          >
            <Trash2 />
            Delete ticket
          </ContextMenuItem>
        </Content>
      </Root>
      <Modal size="composer" title={`Edit ${ticket.key}`} open={editing} onOpenChange={setEditing}>
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
      <Confirm
        label="Delete ticket"
        danger
        trigger={false}
        open={deleting}
        onOpenChange={setDeleting}
        description={`Permanently delete ${ticket.key}, its comments, relationships, and attachments?`}
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
    access = useProjectAccess(project.id, open);
  return (
    <>
      <ContextMenu open={open} onOpenChange={setOpen}>
        <ContextMenuTrigger render={children} className="select-text" />
        <ContextMenuContent className="w-56">
          <ContextMenuGroup>
            <ContextMenuLabel>{project.name}</ContextMenuLabel>
            <ContextMenuItem
              render={<Link to="/projects/$projectId" params={{ projectId: project.id }} />}
            >
              <FolderOpen />
              Open project
            </ContextMenuItem>
            <ContextMenuItem
              render={<a href={`/projects/${project.id}`} target="_blank" rel="noreferrer" />}
            >
              <ExternalLink />
              Open in new tab
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                void copy(new URL(`/projects/${project.id}`, location.origin).href, "Project link");
              }}
            >
              <Link2 />
              Copy link
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!access.canWrite} onClick={() => setCreating(true)}>
            <Plus />
            New ticket
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!access.canAdmin}
            render={<Link to="/projects/$projectId/settings" params={{ projectId: project.id }} />}
          >
            <Settings />
            Project settings
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <Modal size="composer" title="New ticket" open={creating} onOpenChange={setCreating}>
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
          <ContextMenuLabel>{name}</ContextMenuLabel>
          <ContextMenuItem onClick={onOpen}>
            <Settings />
            Manage account
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              void copy(email, "Email");
            }}
          >
            <Copy />
            Copy email
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}
