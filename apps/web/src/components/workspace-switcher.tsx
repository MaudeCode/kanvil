import { useState } from "react";
import { useNavigate, Link } from "@tanstack/react-router";
import { Building2, ChevronsUpDown, Plus, Settings } from "lucide-react";
import { useOperation, useWorkspace } from "../data.tsx";
import { Button, Input, Modal, FormActions } from "../ui.tsx";
import { SidebarMenu, SidebarMenuItem, SidebarMenuButton } from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
function WorkspaceCreateDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const workspace = useWorkspace(),
    navigate = useNavigate(),
    create = useOperation("create_workspace");
  const [name, setName] = useState(""),
    [slug, setSlug] = useState(""),
    [customKey, setCustomKey] = useState(false);
  return (
    <Modal title="New workspace" open onOpenChange={onOpenChange} busy={create.isPending}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create
            .mutateAsync({ name, slug })
            .then(async (space) => {
              workspace.select(space.id);
              onOpenChange(false);
              await navigate({ to: "/" });
            })
            .catch(() => {});
        }}
      >
        <Input
          label="Workspace name"
          value={name}
          onChange={(event) => {
            const next = event.target.value;
            setName(next);
            if (!customKey)
              setSlug(
                next
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, "")
                  .slice(0, 80),
              );
          }}
          required
          maxLength={120}
          autoFocus
        />
        <Input
          label="Workspace key"
          value={slug}
          onChange={(event) => {
            setCustomKey(true);
            setSlug(event.target.value);
          }}
          required
          minLength={2}
          maxLength={80}
          pattern="[a-z0-9][a-z0-9-]{1,79}"
          placeholder="my-workspace"
        />
        <FormActions
          error={create.error}
          pending={create.isPending}
          submitLabel="Create workspace"
          onCancel={() => onOpenChange(false)}
        />
      </form>
    </Modal>
  );
}
export function CreateWorkspace() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="default" onClick={() => setOpen(true)}>
        <Plus />
        New workspace
      </Button>
      {open && <WorkspaceCreateDialog onOpenChange={setOpen} />}
    </>
  );
}
export function WorkspaceSwitcher() {
  const workspace = useWorkspace(),
    navigate = useNavigate(),
    [creating, setCreating] = useState(false);
  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton
                  tooltip={workspace.active?.name ?? "Workspaces"}
                  aria-label="Switch workspace"
                />
              }
            >
              <Building2 />
              <span className="truncate">{workspace.active?.name ?? "Workspaces"}</span>
              <ChevronsUpDown className="ml-auto" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="start" className="min-w-64">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={workspace.active?.id ?? ""}
                  onValueChange={(id) => {
                    workspace.select(id);
                    void navigate({ to: "/" });
                  }}
                >
                  {workspace.workspaces.map((space) => (
                    <DropdownMenuRadioItem key={space.id} value={space.id}>
                      {space.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              {workspace.active?.role && (
                <DropdownMenuItem
                  render={
                    <Link
                      to="/workspaces/$workspaceId/settings"
                      params={{ workspaceId: workspace.active.id }}
                    />
                  }
                >
                  <Settings />
                  Workspace settings
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setCreating(true)}>
                <Plus />
                New workspace
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      {creating && <WorkspaceCreateDialog onOpenChange={setCreating} />}
    </>
  );
}
