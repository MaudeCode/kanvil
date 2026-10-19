import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { capabilitiesOf, type memberSchema, type Workspace } from "@kanvil/contracts";
import type { z } from "zod";
import { api, useAllProjects, useIdentity, useOperation, useWorkspaces } from "../data.tsx";
import {
  Button,
  CopyButton,
  EmptyState,
  ErrorNotice,
  FormActions,
  Loading,
  Modal,
} from "../ui.tsx";
import { UserPicker } from "./user-picker.tsx";
import { DeleteWorkspaceRow } from "./project-lifecycle.tsx";
import { Badge } from "@/components/ui/badge";
import { EditableHeading, SettingsLayout, SettingsPanel, SettingRow } from "./settings-layout.tsx";
import { MemberDirectory } from "./member-directory.tsx";
import { RoleSettings } from "./role-settings.tsx";
import { InvitationList } from "./invitations.tsx";
import { LabelSettings } from "./label-settings.tsx";
import { ImportProjects } from "./project-import.tsx";
import type { workspaceSections } from "../search.ts";
import { t } from "@kanvil/contracts/i18n";
type Member = z.output<typeof memberSchema>;
// Only the owner and instance administrators see the transfer; it goes to another active
// administrator, and the previous owner stays an administrator.
function WorkspaceOwnerRow({
  workspace,
  people,
  canTransfer,
}: {
  workspace: Workspace;
  people: Member[];
  canTransfer: boolean;
}) {
  const [open, setOpen] = useState(false),
    [email, setEmail] = useState(""),
    transfer = useOperation("transfer_workspace");
  const owner = people.find((person) => person.userId === workspace.ownerId),
    eligible = people.filter(
      (person) =>
        person.role === "admin" && !person.disabled && person.userId !== workspace.ownerId,
    ),
    chosen = eligible.find((person) => person.email === email);
  return (
    <SettingRow
      title={t("settings.workspace.owner")}
      description={
        owner
          ? `${owner.name} · ${owner.email}`
          : workspace.ownerId
            ? undefined
            : t("settings.workspace.noOwner")
      }
    >
      {canTransfer && (
        <>
          <Button
            onClick={() => {
              setEmail("");
              setOpen(true);
            }}
          >
            {t("settings.workspace.transfer")}
          </Button>
          <Modal
            title={t("settings.workspace.transfer")}
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              if (!next) transfer.reset();
            }}
            busy={transfer.isPending}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!chosen) return;
                void transfer
                  .mutateAsync({
                    workspaceId: workspace.id,
                    expectedVersion: workspace.version,
                    userId: chosen.userId,
                  })
                  .then(() => {
                    setOpen(false);
                    toast.success(
                      t("settings.workspace.transferred", {
                        name: chosen.name,
                        workspace: workspace.name,
                      }),
                    );
                  })
                  .catch(() => {});
              }}
            >
              {eligible.length ? (
                <UserPicker
                  people={eligible}
                  value={email}
                  onChange={setEmail}
                  disabled={transfer.isPending}
                  label={t("settings.workspace.newOwner")}
                  anyAccount={false}
                />
              ) : (
                <p className="mt-0 text-sm text-muted-foreground">
                  {t("settings.workspace.noEligible")}
                </p>
              )}
              <p className="mt-0 text-sm text-muted-foreground">
                {chosen
                  ? t("settings.workspace.chosenCan", { name: chosen.name })
                  : t("settings.workspace.newOwnerCan")}{" "}
                {owner ? t("settings.workspace.ownerStays", { name: owner.name }) : ""}
              </p>
              <FormActions
                error={transfer.error}
                pending={transfer.isPending}
                submitLabel={t("settings.workspace.transfer")}
                pendingLabel={t("settings.workspace.transferring")}
                submitDisabled={!chosen}
                onCancel={() => setOpen(false)}
              />
            </form>
          </Modal>
        </>
      )}
    </SettingRow>
  );
}
export function WorkspaceSettings({
  workspaceId,
  section,
}: {
  workspaceId: string;
  section: (typeof workspaceSections)[number];
}) {
  const identity = useIdentity(),
    spaces = useWorkspaces(),
    projects = useAllProjects(),
    workspace = spaces.data?.find((space) => space.id === workspaceId);
  const people = useQuery({
      ...api.query("list_workspace_members", { workspaceId }),
      enabled: !!workspace?.role,
    }),
    roles = useQuery({
      ...api.query("list_workspace_roles", { workspaceId }),
      enabled: !!workspace?.role,
    });
  const update = useOperation("update_workspace"),
    member = useOperation("set_workspace_member");
  if (spaces.isPending) return <Loading />;
  if (!workspace?.role)
    return (
      <EmptyState title={t("settings.workspace.unavailable")}>
        <ErrorNotice error={spaces.error} />
        <Button render={<Link to="/" />}>{t("settings.workspace.backToProjects")}</Button>
      </EmptyState>
    );
  // What the caller's role allows here, as the server reports it.
  const granted = capabilitiesOf(workspace),
    authority = { admin: workspace.role === "admin", capabilities: granted },
    canAdmin = granted.includes("workspace.manage"),
    isOwner = workspace.ownerId === identity.id || identity.admin,
    count = projects.data?.filter((project) => project.workspaceId === workspace.id).length ?? 0;
  return (
    <>
      <SettingsLayout title={t("settings.workspace.title")} section={section}>
        <SettingsPanel value="general">
          <section>
            <EditableHeading
              name={workspace.name}
              description={workspace.description}
              nameLabel={t("settings.workspace.name")}
              canEdit={canAdmin}
              version={workspace.version}
              pending={update.isPending}
              error={update.error}
              editLabel={t("settings.workspace.edit")}
              badges={
                <>
                  <Badge variant="secondary" className="ml-0.5 font-mono text-[10px] font-normal">
                    {workspace.slug}
                  </Badge>
                  <CopyButton
                    label={t("settings.workspace.copyKey")}
                    value={workspace.slug}
                    size="icon-xs"
                  />
                </>
              }
              onSave={(draft) =>
                update
                  .mutateAsync({
                    workspaceId,
                    expectedVersion: workspace.version,
                    name: draft.name,
                    description: draft.description,
                  })
                  .then(() => toast.success(t("settings.workspace.saved")))
              }
            />
          </section>
          <section>
            <SettingRow
              title={t("settings.workspace.projects")}
              description={t("settings.workspace.projectCount", { count })}
            >
              <Button render={<Link to="/" />}>{t("settings.workspace.viewProjects")}</Button>
            </SettingRow>
            <WorkspaceOwnerRow
              workspace={workspace}
              people={people.data ?? []}
              canTransfer={isOwner}
            />
            <SettingRow
              title={t("settings.workspace.members")}
              description={t("settings.workspace.membersDescription")}
            >
              <Button
                render={
                  <Link
                    to="/workspaces/$workspaceId/settings"
                    params={{ workspaceId }}
                    search={{ section: "members" }}
                  />
                }
              >
                {t("settings.workspace.manageMembers")}
              </Button>
            </SettingRow>
            {granted.includes("ticket.write") && <ImportProjects workspaceId={workspaceId} />}
            {isOwner && <DeleteWorkspaceRow workspace={workspace} />}
          </section>
        </SettingsPanel>
        <SettingsPanel value="members">
          <MemberDirectory
            people={people.data ?? []}
            pending={member.isPending}
            loading={people.isPending}
            error={people.error}
            canAdmin={granted.includes("member.manage")}
            ownerId={workspace.ownerId}
            scope="workspace"
            roles={roles.data}
            authority={authority}
            onChange={(email, role) => member.mutateAsync({ workspaceId, email, role })}
          />
          {granted.includes("invitation.manage") && <InvitationList workspaceId={workspaceId} />}
        </SettingsPanel>
        <SettingsPanel value="roles">
          <RoleSettings workspaceId={workspaceId} canEdit={canAdmin} authority={authority} />
        </SettingsPanel>
        <SettingsPanel value="labels">
          <LabelSettings owner={{ workspaceId }} canAdmin={canAdmin} />
        </SettingsPanel>
      </SettingsLayout>
    </>
  );
}
