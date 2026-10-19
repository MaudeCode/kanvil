import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import type { memberSchema, Workspace } from "@kanvil/contracts";
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
import { InvitationList } from "./invitations.tsx";
import { LabelSettings } from "./label-settings.tsx";
import type { workspaceSections } from "../search.ts";
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
      title="Owner"
      description={
        owner
          ? `${owner.name} · ${owner.email}`
          : workspace.ownerId
            ? undefined
            : "No owner. An instance administrator can assign one."
      }
    >
      {canTransfer && (
        <Button
          onClick={() => {
            setEmail("");
            setOpen(true);
          }}
        >
          Transfer ownership
        </Button>
      )}
      <Modal
        title="Transfer ownership"
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
                toast.success(`${chosen.name} now owns ${workspace.name}`);
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
              label="New owner"
              anyAccount={false}
            />
          ) : (
            <p className="mt-0 text-sm text-muted-foreground">
              Ownership goes to an active workspace administrator. Make another member an
              administrator first.
            </p>
          )}
          <p className="mt-0 text-sm text-muted-foreground">
            {chosen
              ? `${chosen.name} can then transfer or delete the workspace.`
              : "The new owner can transfer or delete the workspace."}{" "}
            {owner ? `${owner.name} stays an administrator.` : ""}
          </p>
          <FormActions
            error={transfer.error}
            pending={transfer.isPending}
            submitLabel="Transfer ownership"
            pendingLabel="Transferring…"
            submitDisabled={!chosen}
            onCancel={() => setOpen(false)}
          />
        </form>
      </Modal>
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
  });
  const update = useOperation("update_workspace"),
    member = useOperation("set_workspace_member");
  if (spaces.isPending) return <Loading />;
  if (!workspace?.role)
    return (
      <EmptyState title="Workspace unavailable">
        <ErrorNotice error={spaces.error} />
        <Button render={<Link to="/" />}>Back to projects</Button>
      </EmptyState>
    );
  const canAdmin = workspace.role === "admin",
    isOwner = workspace.ownerId === identity.id || identity.admin,
    count = projects.data?.filter((project) => project.workspaceId === workspace.id).length ?? 0;
  return (
    <>
      <SettingsLayout title="Workspace settings" section={section}>
        <SettingsPanel value="general">
          <section>
            <EditableHeading
              name={workspace.name}
              description={workspace.description}
              nameLabel="Workspace name"
              canEdit={canAdmin}
              version={workspace.version}
              pending={update.isPending}
              error={update.error}
              editLabel="Edit workspace"
              badges={
                <>
                  <Badge variant="secondary" className="ml-0.5 font-mono text-[10px] font-normal">
                    {workspace.slug}
                  </Badge>
                  <CopyButton label="Copy workspace key" value={workspace.slug} size="icon-xs" />
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
                  .then(() => toast.success("Workspace saved"))
              }
            />
          </section>
          <section>
            <SettingRow
              title="Projects"
              description={`${count} ${count === 1 ? "project" : "projects"} you can access in this workspace.`}
            >
              <Button render={<Link to="/" />}>View projects</Button>
            </SettingRow>
            <WorkspaceOwnerRow
              workspace={workspace}
              people={people.data ?? []}
              canTransfer={isOwner}
            />
            <SettingRow
              title="Members"
              description="Workspace roles apply to projects that use workspace access."
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
                Manage members
              </Button>
            </SettingRow>
            {isOwner && <DeleteWorkspaceRow workspace={workspace} />}
          </section>
        </SettingsPanel>
        <SettingsPanel value="members">
          <MemberDirectory
            people={people.data ?? []}
            pending={member.isPending}
            loading={people.isPending}
            error={people.error}
            canAdmin={canAdmin}
            ownerId={workspace.ownerId}
            scope="workspace"
            onChange={(email, role) => member.mutateAsync({ workspaceId, email, role })}
          />
          {canAdmin && <InvitationList workspaceId={workspaceId} />}
        </SettingsPanel>
        <SettingsPanel value="labels">
          <LabelSettings owner={{ workspaceId }} canAdmin={canAdmin} />
        </SettingsPanel>
      </SettingsLayout>
    </>
  );
}
