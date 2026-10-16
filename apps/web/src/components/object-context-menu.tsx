import { lazy, Suspense, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  Bell,
  BellOff,
  Copy,
  ExternalLink,
  Flag,
  FolderOpen,
  Link2,
  Pencil,
  Plus,
  Settings,
  Trash2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { states, priorities, type Ticket, type Project } from "@kanvil/contracts";
import { api, useOperation, useProjectAccess } from "../data.tsx";
import { Confirm, Modal, TicketIndicator, Loading, reportError } from "../ui.tsx";
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
async function copy(value: string, label: string) {
  try {
    await copyText(value);
    toast.success(`${label} copied`);
  } catch (error) {
    reportError(error);
  }
}
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
  const members = useQuery({
    ...api.query("list_members", { projectId: ticket.projectId }),
    enabled: open && access.canWrite,
  });
  const current = read.data?.ticket ?? ticket,
    update = useOperation("update_ticket"),
    remove = useOperation("delete_ticket"),
    subscribe = useOperation("set_subscription");
  const Root = variant === "dropdown" ? DropdownMenu : ContextMenu,
    Trigger = variant === "dropdown" ? DropdownMenuTrigger : ContextMenuTrigger,
    Content = variant === "dropdown" ? DropdownMenuContent : ContextMenuContent;
  const href = `/projects/${ticket.projectId}/tickets/${ticket.id}`;
  const change = (changes: Partial<Ticket>) => {
    void update
      .mutateAsync({
        projectId: current.projectId,
        ticketId: current.id,
        expectedVersion: current.version,
        changes,
      })
      .catch(reportError);
  };
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
            <ContextMenuItem
              onClick={() => {
                void copy(new URL(href, location.origin).href, "Ticket link");
              }}
            >
              <Link2 />
              Copy link
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                void copy(`${ticket.key} ${ticket.title}`, "Ticket");
              }}
            >
              <Copy />
              Copy key and title
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!access.canWrite}
            onClick={() => (onEdit ? onEdit() : setEditing(true))}
          >
            <Pencil />
            Edit ticket
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={!access.canWrite}>Status</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={current.status}
                onValueChange={(value) => change({ status: z.enum(states).parse(value) })}
              >
                {states.map((status) => (
                  <ContextMenuRadioItem key={status} value={status}>
                    <TicketIndicator property="status" value={status} />
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={!access.canWrite}>
              <Flag />
              Priority
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={current.priority}
                onValueChange={(value) => change({ priority: z.enum(priorities).parse(value) })}
              >
                {priorities.map((priority) => (
                  <ContextMenuRadioItem key={priority} value={priority}>
                    <TicketIndicator property="priority" value={priority} />
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={!access.canWrite}>
              <UserRound />
              Assignee
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={current.assigneeId ?? ""}
                onValueChange={(value) =>
                  change({ assigneeId: typeof value === "string" && value ? value : null })
                }
              >
                <ContextMenuRadioItem value="">Unassigned</ContextMenuRadioItem>
                {members.data?.map((member) => (
                  <ContextMenuRadioItem key={member.userId} value={member.userId}>
                    {member.name}
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
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
