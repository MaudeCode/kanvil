import { SidebarGroupAction } from "@/components/ui/sidebar";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { formText } from "../forms.ts";
import { useOperation, useWorkspace } from "../data.tsx";
import { Button, Input, Modal, Textarea, ErrorNotice, Select, SelectItem } from "../ui.tsx";

export function CreateProject({ sidebarAction = false }: { sidebarAction?: boolean }) {
  const { active: workspace } = useWorkspace();
  const canCreate = !!workspace && (workspace.role === "writer" || workspace.role === "admin");
  const [open, setOpen] = useState(false),
    create = useOperation("create_project"),
    navigate = useNavigate();
  return (
    <>
      {sidebarAction ? (
        <SidebarGroupAction
          disabled={!canCreate}
          aria-label="New project"
          onClick={() => setOpen(true)}
        >
          <Plus />
        </SidebarGroupAction>
      ) : (
        <Button
          variant="default"
          size="default"
          disabled={!canCreate}
          aria-label="New project"
          onClick={() => setOpen(true)}
        >
          <Plus />
          New project
        </Button>
      )}
      <Modal title="New project" open={open} onOpenChange={setOpen}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void create
              .mutateAsync({
                workspaceId: workspace?.id,
                visibility: formText(values, "visibility") === "private" ? "private" : "workspace",
                key: formText(values, "key"),
                name: formText(values, "name"),
                description: formText(values, "description"),
              })
              .then(async (project) => {
                setOpen(false);
                await navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
              })
              .catch(() => {});
          }}
        >
          <Input label="Project name" name="name" required maxLength={120} />
          <Input
            label="Permanent ticket prefix"
            name="key"
            required
            minLength={2}
            maxLength={10}
            pattern="[A-Z][A-Z0-9]{1,9}"
            placeholder="KAN"
          />
          <Textarea label="Description" name="description" maxLength={5000} />
          <Select label="Project access" name="visibility" defaultValue="workspace">
            <SelectItem value="workspace">Everyone in this workspace</SelectItem>
            <SelectItem value="private">Only project members</SelectItem>
          </Select>
          <ErrorNotice error={create.error} />
          <Button type="submit" variant="default" disabled={create.isPending}>
            Create project
          </Button>
        </form>
      </Modal>
    </>
  );
}
