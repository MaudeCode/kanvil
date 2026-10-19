import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, ImageUp } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { capabilitiesOf, type Output, type Project } from "@kanvil/contracts";
import { Badge } from "@/components/ui/badge";
import { api, useOperation, useProjectAccess, useWorkspace } from "../data.tsx";
import {
  Button,
  Confirm,
  CopyButton,
  FormActions,
  IconButton,
  Modal,
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
import { ProjectDestinations, RepositoryConnections } from "./delivery-settings.tsx";
import { CalendarFeedSettings } from "./calendar-feed-settings.tsx";
import {
  ArchiveProjectRow,
  DeleteProjectRow,
  ExportProjectRow,
  MoveProject,
} from "./project-lifecycle.tsx";
import type { projectSections } from "../search.ts";
import { Input as FileInput } from "@/components/ui/input";
import { prepareImage } from "../lib/browser.ts";
import { PrefixInput } from "./create-project.tsx";
import { t } from "@kanvil/contracts/i18n";
import { Trans } from "react-i18next";
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
    workspace = useWorkspace(),
    // Workspaces the project can move to: the caller must also manage projects in the destination.
    destinations = workspace.workspaces.filter(
      (space) =>
        capabilitiesOf(space).includes("project.manage") && space.id !== project.workspaceId,
    );
  const members = useQuery(api.query("list_members", { projectId: project.id })),
    roles = useQuery(api.query("list_project_roles", { projectId: project.id }));
  const candidates = useQuery({
    ...api.query("list_workspace_members", { workspaceId: project.workspaceId }),
    enabled: !!workspace.active?.role,
  });
  return (
    <>
      <SettingsLayout title={t("settings.project.title")} section={section}>
        <SettingsPanel value="general">
          <section>
            <EditableHeading
              name={project.name}
              description={project.description}
              canEdit={access.canManage}
              version={project.version}
              pending={update.isPending}
              error={update.error}
              editLabel={t("settings.project.edit")}
              media={<ProjectIconPicker project={project} disabled={!access.canManage} />}
              badges={
                <>
                  <Badge variant="secondary" className="ml-0.5 font-mono text-[10px] font-normal">
                    {project.key}
                  </Badge>
                  <CopyButton
                    label={t("settings.project.copyPrefix")}
                    value={project.key}
                    size="icon-xs"
                  />
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
                  .then(() => toast.success(t("settings.project.saved")))
              }
            >
              <p className="mb-0 text-xs tabular-nums">
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: project.id }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {project.openTickets === 0
                    ? t("settings.project.noOpenTickets")
                    : t("settings.project.openTickets", { count: project.openTickets })}
                  {project.overdueTickets > 0 && (
                    <span className="text-(--warning)">
                      {" "}
                      {t("settings.project.overdueTickets", { count: project.overdueTickets })}
                    </span>
                  )}
                </Link>{" "}
                <Trans
                  i18nKey="settings.project.created"
                  components={{ time: <RelativeTime value={project.createdAt} /> }}
                />
              </p>
            </EditableHeading>
          </section>
          <section>
            <SettingRow
              title={t("settings.project.access")}
              description={
                project.visibility === "workspace"
                  ? t("settings.project.accessWorkspace")
                  : t("settings.project.accessPrivate")
              }
            >
              <Select
                label={t("settings.project.access")}
                labelHidden
                className="mb-0 w-56"
                value={project.visibility}
                disabled={!access.canManage || update.isPending}
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
                    .then(() => toast.success(t("settings.project.accessUpdated")))
                    .catch(reportError);
                }}
              >
                <SelectItem value="workspace">
                  {t("settings.project.visibility.workspace")}
                </SelectItem>
                <SelectItem value="private">{t("settings.project.visibility.private")}</SelectItem>
              </Select>
            </SettingRow>
            <TicketPrefix project={project} canAdmin={access.canManage} />
            <PublicLink project={project} canAdmin={access.canShare} />
            <ProjectBackground project={project} canAdmin={access.canManage} />
            <SettingRow
              title={t("settings.project.workspace")}
              description={workspace.active?.name}
            >
              {access.canManage &&
                capabilitiesOf(workspace.active ?? { role: null }).includes("project.manage") &&
                destinations.length > 0 && (
                  <MoveProject project={project} destinations={destinations} />
                )}
              {workspace.active?.role && (
                <Button
                  render={
                    <Link
                      to="/workspaces/$workspaceId/settings"
                      params={{ workspaceId: project.workspaceId }}
                    />
                  }
                >
                  {t("settings.project.workspaceSettings")}
                </Button>
              )}
            </SettingRow>
            <ExportProjectRow project={project} />
            {access.canManage && (
              <>
                <ArchiveProjectRow project={project} />
                <DeleteProjectRow project={project} />
              </>
            )}
          </section>
        </SettingsPanel>
        <SettingsPanel value="members">
          <MemberDirectory
            people={members.data ?? []}
            candidates={candidates.data ?? members.data ?? []}
            pending={member.isPending}
            loading={members.isPending}
            error={members.error}
            canAdmin={access.canManageMembers}
            scope="project"
            roles={roles.data}
            authority={{ admin: access.role === "admin", capabilities: access.capabilities }}
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
          <RepositoryConnections
            projectId={project.id}
            workspaceId={project.workspaceId}
            canAdmin={access.canManage}
            canChange={access.canAdmin}
          />
          <ProjectDestinations
            projectId={project.id}
            canAdmin={access.canManage}
            canChange={access.canAdmin}
          />
        </SettingsPanel>
        <SettingsPanel value="calendar">
          <CalendarFeedSettings
            projectId={project.id}
            canAdmin={access.canShare}
            canCreate={access.canShare && !access.archived}
          />
        </SettingsPanel>
      </SettingsLayout>
    </>
  );
}

// Changing the prefix re-keys every ticket; the server keeps earlier prefixes and keys resolving.
function TicketPrefix({ project, canAdmin }: { project: Project; canAdmin: boolean }) {
  const update = useOperation("update_project"),
    [open, setOpen] = useState(false),
    [key, setKey] = useState(project.key);
  return (
    <SettingRow
      title={t("settings.project.prefix")}
      description={t("settings.project.prefixDescription")}
    >
      {canAdmin && (
        <Button
          onClick={() => {
            setKey(project.key);
            update.reset();
            setOpen(true);
          }}
        >
          {t("settings.project.changePrefix")}
        </Button>
      )}
      <Modal
        title={t("settings.project.changePrefixTitle")}
        description={t("settings.project.changePrefixDescription", { name: project.name })}
        open={open}
        onOpenChange={setOpen}
        busy={update.isPending}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void update
              .mutateAsync({
                projectId: project.id,
                expectedVersion: project.version,
                name: project.name,
                description: project.description,
                key,
              })
              .then((saved) => {
                setOpen(false);
                toast.success(t("settings.project.prefixChanged", { key: saved.key }));
              })
              .catch(() => {});
          }}
        >
          <PrefixInput
            value={key}
            onChange={(next) => {
              setKey(next);
              update.reset();
            }}
            autoFocus
          />
          <FormActions
            error={update.error}
            pending={update.isPending}
            submitLabel={t("settings.project.changePrefix")}
            pendingLabel={t("settings.project.changing")}
            submitDisabled={key === project.key}
            onCancel={() => setOpen(false)}
          />
        </form>
      </Modal>
    </SettingRow>
  );
}

// Shares the project read-only with anyone who has its link, or stops sharing at once.
function PublicLink({ project, canAdmin }: { project: Project; canAdmin: boolean }) {
  const update = useOperation("update_project"),
    url = new URL(`/public/projects/${project.id}`, window.location.origin).href,
    // What a public link discloses; the public operations' projection is the source of this list.
    disclosure = t("settings.project.publicDisclosure");
  const save = (publicReadEnabled: boolean) =>
    update
      .mutateAsync({
        projectId: project.id,
        expectedVersion: project.version,
        name: project.name,
        description: project.description,
        publicReadEnabled,
      })
      .then(() =>
        toast.success(
          publicReadEnabled ? t("settings.project.publicOn") : t("settings.project.publicOff"),
        ),
      );
  return (
    <SettingRow
      title={t("settings.project.publicLink")}
      description={
        project.publicReadEnabled ? (
          <>
            <code className="block text-xs break-all text-foreground">{url}</code>
            <span className="mt-1 block">{disclosure}</span>
          </>
        ) : (
          t("settings.project.off")
        )
      }
    >
      {project.publicReadEnabled && (
        <>
          <CopyButton label={t("settings.project.copyPublicLink")} value={url} />
          <IconButton
            label={t("settings.project.openPublic")}
            render={<a href={url} target="_blank" rel="noreferrer" />}
          >
            <ExternalLink />
          </IconButton>
        </>
      )}
      {canAdmin &&
        (project.publicReadEnabled ? (
          <Button disabled={update.isPending} onClick={() => void save(false).catch(reportError)}>
            {t("settings.project.stopSharing")}
          </Button>
        ) : (
          <Confirm
            label={t("settings.project.share")}
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
      .then(() =>
        toast.success(
          background
            ? t("settings.project.backgroundUpdated")
            : t("settings.project.backgroundRemoved"),
        ),
      );
  return (
    <SettingRow
      title={t("settings.project.background")}
      description={
        project.background ? t("settings.project.backgroundDescription") : t("common.state.none")
      }
    >
      {project.background && (
        <img
          src={project.background}
          alt={t("settings.project.currentBackground")}
          className="h-14 w-24 rounded-md border object-cover"
        />
      )}
      {canAdmin && (
        <>
          <Button disabled={busy} onClick={() => file.current?.click()}>
            <ImageUp />
            {busy
              ? t("settings.project.uploading")
              : project.background
                ? t("settings.project.replace")
                : t("settings.project.upload")}
          </Button>
          {project.background && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void save(null).catch(reportError)}
            >
              {t("common.action.remove")}
            </Button>
          )}
          <FileInput
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            aria-label={t("settings.project.backgroundFile")}
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
