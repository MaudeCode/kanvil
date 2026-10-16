import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pencil, Settings2, Users, Tags } from "lucide-react";
import { toast } from "sonner";
import type { Output } from "@kanvil/contracts";
import { Badge } from "@/components/ui/badge";
import { api, useOperation, useProjectAccess, useWorkspace } from "../data.tsx";
import {
  Button,
  CopyButton,
  ErrorNotice,
  IconButton,
  Input,
  RelativeTime,
  Select,
  SelectItem,
  Textarea,
  reportError,
} from "../ui.tsx";
import { submitOnModEnter } from "../forms.ts";
import { TabsContent } from "@/components/ui/tabs";
import { SettingsLayout, SettingRow } from "./settings-layout.tsx";
import { MemberDirectory } from "./member-directory.tsx";
import { ProjectIconPicker } from "./project-icon-picker.tsx";
import { ProjectLabelSettings } from "./project-label-settings.tsx";
const sections = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "members", label: "Members", icon: Users },
  { id: "labels", label: "Labels", icon: Tags },
];
export function ProjectSettings({
  project,
  section,
  onSectionChange,
}: {
  project: Output<"list_projects">[number];
  section: "general" | "members" | "labels";
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
            <div className="flex flex-wrap items-start gap-5">
              <ProjectIconPicker project={project} disabled={!access.canAdmin} />
              {editing ? (
                <form
                  className="min-w-0 flex-1 basis-60 [&_[data-slot=field-label]]:sr-only"
                  onKeyDown={submitOnModEnter}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void update
                      .mutateAsync({
                        projectId: project.id,
                        expectedVersion: draft.version,
                        name: draft.name,
                        description: draft.description,
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
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditing(false);
                    }}
                    required
                    maxLength={120}
                    autoFocus
                    className="text-base font-semibold"
                  />
                  <Textarea
                    label="Description"
                    value={draft.description}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditing(false);
                    }}
                    maxLength={5000}
                    rows={3}
                    placeholder="Add a description"
                    className="field-sizing-content"
                  />
                  {project.version !== draft.version && (
                    <p role="alert" className="mt-2 mb-0 text-xs">
                      This project changed elsewhere. Cancel and start again.
                    </p>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      type="submit"
                      variant="default"
                      size="sm"
                      disabled={update.isPending || project.version !== draft.version}
                    >
                      {update.isPending ? "Saving…" : "Save"}
                    </Button>
                    <Button size="sm" disabled={update.isPending} onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                  </div>
                  <ErrorNotice error={update.error} />
                </form>
              ) : (
                <div className="min-w-0 flex-1 basis-60">
                  <h2 className="mb-1 flex flex-wrap items-center gap-1.5 text-base">
                    {project.name}
                    <Badge variant="secondary" className="ml-0.5 font-mono text-[10px] font-normal">
                      {project.key}
                    </Badge>
                    <CopyButton label="Copy ticket prefix" value={project.key} size="icon-xs" />
                  </h2>
                  <p className="mb-2 max-w-xl whitespace-pre-wrap">
                    {project.description || "No description"}
                  </p>
                  <p className="mb-0 text-xs tabular-nums">
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId: project.id }}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {project.openTickets === 0
                        ? "No open tickets"
                        : `${project.openTickets} open ${project.openTickets === 1 ? "ticket" : "tickets"}`}
                      {project.overdueTickets > 0 && (
                        <span className="text-(--warning)">
                          {" "}
                          · {project.overdueTickets} overdue
                        </span>
                      )}
                    </Link>
                    {" · Created "}
                    <RelativeTime value={project.createdAt} />
                  </p>
                </div>
              )}
              {access.canAdmin && !editing && (
                <IconButton
                  label="Edit project"
                  onClick={() => {
                    setDraft({
                      name: project.name,
                      description: project.description,
                      version: project.version,
                    });
                    update.reset();
                    setEditing(true);
                  }}
                >
                  <Pencil />
                </IconButton>
              )}
            </div>
          </section>
          <section>
            <SettingRow
              title="Project access"
              description={
                project.visibility === "workspace"
                  ? "Workspace members inherit access from their workspace role."
                  : "Only members you add and workspace administrators can see this project."
              }
            >
              <Select
                label="Project access"
                labelHidden
                className="mb-0 w-56"
                value={project.visibility}
                disabled={!access.canAdmin || update.isPending}
                onValueChange={(value) => {
                  const visibility = value === "private" ? "private" : "workspace";
                  if (visibility === project.visibility) return;
                  void update
                    .mutateAsync({
                      projectId: project.id,
                      expectedVersion: project.version,
                      name: project.name,
                      description: project.description,
                      visibility,
                    })
                    .then(() => toast.success("Project access updated"))
                    .catch(reportError);
                }}
              >
                <SelectItem value="workspace">Everyone in the workspace</SelectItem>
                <SelectItem value="private">Only project members</SelectItem>
              </Select>
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
        <TabsContent value="labels">
          <ProjectLabelSettings projectId={project.id} canAdmin={access.canAdmin} />
        </TabsContent>
      </SettingsLayout>
    </>
  );
}
