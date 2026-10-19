import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, ImageUp } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import type { Output, Project } from "@kanvil/contracts";
import { Badge } from "@/components/ui/badge";
import { api, useOperation, useProjectAccess, useWorkspace } from "../data.tsx";
import {
  Button,
  Confirm,
  CopyButton,
  IconButton,
  RelativeTime,
  Select,
  SelectItem,
  reportError,
} from "../ui.tsx";
import { EditableHeading, SettingsLayout, SettingsPanel, SettingRow } from "./settings-layout.tsx";
import { MemberDirectory } from "./member-directory.tsx";
import { ProjectIconPicker } from "./project-icon-picker.tsx";
import { LabelSettings } from "./label-settings.tsx";
import { ProjectWorkflowSettings } from "./project-workflow-settings.tsx";
import { CustomFieldSettings } from "./custom-field-settings.tsx";
import { ProjectDestinations } from "./delivery-settings.tsx";
import { CalendarFeedSettings } from "./calendar-feed-settings.tsx";
import type { projectSections } from "../search.ts";
import { Input as FileInput } from "@/components/ui/input";
import { prepareImage } from "../lib/browser.ts";
export function ProjectSettings({
  project,
  section,
}: {
  project: Output<"list_projects">[number];
  section: (typeof projectSections)[number];
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
  return (
    <>
      <SettingsLayout title="Project settings" section={section}>
        <SettingsPanel value="general">
          <section>
            <EditableHeading
              name={project.name}
              description={project.description}
              canEdit={access.canAdmin}
              version={project.version}
              pending={update.isPending}
              error={update.error}
              editLabel="Edit project"
              media={<ProjectIconPicker project={project} disabled={!access.canAdmin} />}
              badges={
                <>
                  <Badge variant="secondary" className="ml-0.5 font-mono text-[10px] font-normal">
                    {project.key}
                  </Badge>
                  <CopyButton label="Copy ticket prefix" value={project.key} size="icon-xs" />
                </>
              }
              onSave={(draft) =>
                update
                  .mutateAsync({
                    projectId: project.id,
                    expectedVersion: project.version,
                    name: draft.name,
                    description: draft.description,
                  })
                  .then(() => toast.success("Project saved"))
              }
            >
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
                    <span className="text-(--warning)"> · {project.overdueTickets} overdue</span>
                  )}
                </Link>
                {" · Created "}
                <RelativeTime value={project.createdAt} />
              </p>
            </EditableHeading>
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
            <PublicLink project={project} canAdmin={access.canAdmin} />
            <ProjectBackground project={project} canAdmin={access.canAdmin} />
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
        </SettingsPanel>
        <SettingsPanel value="members">
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
        </SettingsPanel>
        <SettingsPanel value="workflow">
          <ProjectWorkflowSettings projectId={project.id} canAdmin={access.canAdmin} />
        </SettingsPanel>
        <SettingsPanel value="labels">
          <LabelSettings owner={{ projectId: project.id }} canAdmin={access.canAdmin} />
        </SettingsPanel>
        <SettingsPanel value="fields">
          <CustomFieldSettings projectId={project.id} canAdmin={access.canAdmin} />
        </SettingsPanel>
        <SettingsPanel value="integrations">
          <ProjectDestinations projectId={project.id} canAdmin={access.canAdmin} />
        </SettingsPanel>
        <SettingsPanel value="calendar">
          <CalendarFeedSettings projectId={project.id} canAdmin={access.canAdmin} />
        </SettingsPanel>
      </SettingsLayout>
    </>
  );
}

// What a public link discloses; the public operations' projection is the source of this list.
const disclosure =
  "Anyone with the link can read every unarchived ticket's title, description, acceptance criteria, status, priority, kind, difficulty, labels, scopes, dates, and links to other tickets in this project. People, comments, activity, attachments, evidence, and claims stay private.";
// Shares the project read-only with anyone who has its link, or stops sharing at once.
function PublicLink({ project, canAdmin }: { project: Project; canAdmin: boolean }) {
  const update = useOperation("update_project"),
    url = new URL(`/public/projects/${project.id}`, window.location.origin).href;
  const save = (publicReadEnabled: boolean) =>
    update
      .mutateAsync({
        projectId: project.id,
        expectedVersion: project.version,
        name: project.name,
        description: project.description,
        publicReadEnabled,
      })
      .then(() => toast.success(publicReadEnabled ? "Public link on" : "Public link off"));
  return (
    <SettingRow
      title="Public link"
      description={
        project.publicReadEnabled ? (
          <>
            <code className="block text-xs break-all text-foreground">{url}</code>
            <span className="mt-1 block">{disclosure}</span>
          </>
        ) : (
          "Off"
        )
      }
    >
      {project.publicReadEnabled && (
        <>
          <CopyButton label="Copy public link" value={url} />
          <IconButton
            label="Open public view"
            render={<a href={url} target="_blank" rel="noreferrer" />}
          >
            <ExternalLink />
          </IconButton>
        </>
      )}
      {canAdmin &&
        (project.publicReadEnabled ? (
          <Button disabled={update.isPending} onClick={() => void save(false).catch(reportError)}>
            Stop sharing
          </Button>
        ) : (
          <Confirm
            label="Share publicly"
            description={disclosure}
            disabled={update.isPending}
            onConfirm={() => save(true)}
          />
        ))}
    </SettingRow>
  );
}

// The optional image behind the project's ticket list and board. Each person can still hide
// backgrounds in their display preferences without touching this project setting.
function ProjectBackground({ project, canAdmin }: { project: Project; canAdmin: boolean }) {
  const update = useOperation("set_project_background"),
    file = useRef<HTMLInputElement>(null),
    [preparing, setPreparing] = useState(false),
    busy = preparing || update.isPending;
  const save = (background: Parameters<typeof update.mutateAsync>[0]["background"]) =>
    update
      .mutateAsync({ projectId: project.id, expectedVersion: project.version, background })
      .then(() => toast.success(background ? "Background updated" : "Background removed"));
  return (
    <SettingRow
      title="Background"
      description={
        project.background ? "Shown behind this project's ticket list and board." : "None"
      }
    >
      {project.background && (
        <img
          src={project.background}
          alt="Current background"
          className="h-14 w-24 rounded-md border object-cover"
        />
      )}
      {canAdmin && (
        <>
          <Button disabled={busy} onClick={() => file.current?.click()}>
            <ImageUp />
            {busy ? "Uploading…" : project.background ? "Replace" : "Upload image"}
          </Button>
          {project.background && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void save(null).catch(reportError)}
            >
              Remove
            </Button>
          )}
          <FileInput
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            aria-label="Project background file"
            onChange={(event) => {
              const selected = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!selected) return;
              setPreparing(true);
              void prepareImage(selected, { fit: "inside", size: 1920 })
                .then((image) => save(image))
                .catch(reportError)
                .finally(() => setPreparing(false));
            }}
          />
        </>
      )}
    </SettingRow>
  );
}
