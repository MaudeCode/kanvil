import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pencil, Settings2, Users } from "lucide-react";
import { toast } from "sonner";
import type { Project } from "@kanvil/contracts";
import { api, useOperation, useProjectAccess, useWorkspace } from "../data.tsx";
import {
  Button,
  CopyValue,
  ErrorNotice,
  Input,
  Modal,
  SectionHeading,
  Select,
  SelectItem,
  Textarea,
} from "../ui.tsx";
import { TabsContent } from "@/components/ui/tabs";
import { SettingsLayout, SettingRow } from "./settings-layout.tsx";
import { MemberDirectory } from "./member-directory.tsx";
import { ProjectIcon } from "./project-icon.tsx";
import { ProjectIconPicker } from "./project-icon-picker.tsx";
const sections = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "members", label: "Members", icon: Users },
];
export function ProjectSettings({
  project,
  section,
  onSectionChange,
}: {
  project: Project;
  section: "general" | "members";
  onSectionChange: (section: string) => void;
}) {
  const update = useOperation("update_project"),
    member = useOperation("set_member"),
    access = useProjectAccess(project.id),
    workspace = useWorkspace();
  const members = useQuery(api.query("list_members", { projectId: project.id }));
  const candidates = useQuery({
    ...api.query("list_workspace_members", { workspaceId: project.workspaceId }),
    enabled: !!workspace.active?.role,
  });
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState({
      name: project.name,
      description: project.description,
      visibility: project.visibility,
      version: project.version,
    });
  return (
    <>
      <SettingsLayout
        title="Project settings"
        value={section}
        onChange={onSectionChange}
        sections={sections}
      >
        <TabsContent value="general">
          <section>
            <SectionHeading
              title={project.name}
              action={
                access.canAdmin && (
                  <Button
                    onClick={() => {
                      setDraft({
                        name: project.name,
                        description: project.description,
                        visibility: project.visibility,
                        version: project.version,
                      });
                      update.reset();
                      setEditing(true);
                    }}
                  >
                    <Pencil />
                    Edit project
                  </Button>
                )
              }
            />
            <div className="mb-8 flex items-center gap-5">
              <ProjectIcon project={project} className="size-14" />
              <p className="mb-0 max-w-xl whitespace-pre-wrap text-sm text-muted-foreground">
                {project.description || "No description"}
              </p>
            </div>
            <SettingRow
              title="Project icon"
              description="Choose a library icon or upload your own."
            >
              <ProjectIconPicker project={project} disabled={!access.canAdmin} />
            </SettingRow>
            <SettingRow title="Workspace" description={workspace.active?.name}>
              {workspace.active?.role && (
                <Button
                  render={
                    <Link
                      to="/workspaces/$workspaceId/settings"
                      params={{ workspaceId: project.workspaceId }}
                    />
                  }
                >
                  Workspace settings
                </Button>
              )}
            </SettingRow>
            <SettingRow
              title="Project access"
              description={
                project.visibility === "workspace"
                  ? "Workspace members inherit access from their workspace role."
                  : "Only project members and workspace administrators can access this project."
              }
            />
            <div className="pt-6">
              <CopyValue label="Permanent ticket prefix" value={project.key} />
            </div>
          </section>
        </TabsContent>
        <TabsContent value="members">
          <MemberDirectory
            people={members.data ?? []}
            candidates={candidates.data ?? members.data ?? []}
            pending={member.isPending}
            loading={members.isPending}
            error={members.error}
            canAdmin={access.canAdmin}
            scope="project"
            onChange={(email, role) => member.mutateAsync({ projectId: project.id, email, role })}
          />
        </TabsContent>
      </SettingsLayout>
      <Modal title="Edit project" open={editing} onOpenChange={setEditing} busy={update.isPending}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void update
              .mutateAsync({
                projectId: project.id,
                expectedVersion: draft.version,
                name: draft.name,
                description: draft.description,
                visibility: draft.visibility,
              })
              .then(() => {
                setEditing(false);
                toast.success("Project saved");
              })
              .catch(() => {});
          }}
        >
          <Input
            label="Name"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            required
            maxLength={120}
            autoFocus
          />
          <Textarea
            label="Description"
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            maxLength={5000}
          />
          <Select
            label="Project access"
            value={draft.visibility}
            onValueChange={(value) =>
              setDraft({ ...draft, visibility: value === "workspace" ? "workspace" : "private" })
            }
          >
            <SelectItem value="workspace">Everyone in this workspace</SelectItem>
            <SelectItem value="private">Only project members</SelectItem>
          </Select>
          {project.version !== draft.version && (
            <p role="alert">This project changed. Reopen the editor before saving.</p>
          )}
          <ErrorNotice error={update.error} />
          <div className="dialog-actions">
            <Button disabled={update.isPending} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={update.isPending || project.version !== draft.version}
            >
              Save project
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
