import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  permissionLabels,
  permissions,
  type Permission,
  type WorkspaceRole,
} from "@kanvil/contracts";
import { api, useOperation } from "../data.tsx";
import {
  Check,
  Confirm,
  EmptyState,
  ErrorNotice,
  FormActions,
  IconButton,
  Input,
  Loading,
  Modal,
  SectionHeading,
  Select,
  SelectItem,
} from "../ui.tsx";
import { SettingRow } from "./settings-layout.tsx";

const memberships = (count: number) => `${count} ${count === 1 ? "membership" : "memberships"}`;
// Roles follow LabelSettings: SettingRow rows with a Modal editor, here a checklist of the action
// catalog. The seeded roles are fixed; custom ones edit when they grant nothing beyond the viewer.
export function RoleSettings({
  workspaceId,
  canEdit,
  authority,
}: {
  workspaceId: string;
  canEdit: boolean;
  authority: { admin: boolean; capabilities: readonly Permission[] };
}) {
  const roles = useQuery(api.query("list_workspace_roles", { workspaceId }));
  const create = useOperation("create_workspace_role"),
    update = useOperation("update_workspace_role"),
    remove = useOperation("delete_workspace_role");
  const [draft, setDraft] = useState<{
    role: WorkspaceRole | null;
    name: string;
    permissions: Permission[];
  } | null>(null);
  const [deleting, setDeleting] = useState<{ role: WorkspaceRole; reassignTo: string } | null>(
    null,
  );
  const rows = roles.data ?? [];
  const busy = create.isPending || update.isPending;
  const holds = (permission: Permission) => authority.capabilities.includes(permission);
  const grantable = (role: WorkspaceRole) =>
    (role.id !== "admin" || authority.admin) && role.permissions.every(holds);
  function edit(role: WorkspaceRole | null) {
    create.reset();
    update.reset();
    setDraft({ role, name: role?.name ?? "", permissions: role ? [...role.permissions] : [] });
  }
  function save(role: WorkspaceRole | null, name: string, granted: Permission[]) {
    return role
      ? update.mutateAsync({
          workspaceId,
          roleId: role.id,
          expectedVersion: role.version,
          name,
          permissions: granted,
        })
      : create.mutateAsync({ workspaceId, name, permissions: granted });
  }
  async function destroy(role: WorkspaceRole, reassignTo?: string) {
    await remove.mutateAsync({
      workspaceId,
      roleId: role.id,
      expectedVersion: role.version,
      ...(reassignTo ? { reassignTo } : {}),
    });
    setDeleting(null);
    toast.success("Role deleted");
  }
  const targets = deleting
    ? rows.filter((role) => role.id !== deleting.role.id && grantable(role))
    : [];
  return (
    <section>
      <SectionHeading
        title="Roles"
        action={
          canEdit && (
            <IconButton label="New role" variant="default" onClick={() => edit(null)}>
              <Plus />
            </IconButton>
          )
        }
      />
      <ErrorNotice error={roles.error} />
      {roles.isPending ? (
        <Loading />
      ) : rows.length ? (
        rows.map((role) => {
          const editable = canEdit && !role.seeded && grantable(role);
          return (
            <SettingRow
              key={role.id}
              compact
              title={
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0">{role.name}</span>
                  {role.seeded && (
                    <span className="shrink-0 text-xs font-normal text-muted-foreground">
                      Built in
                    </span>
                  )}
                </span>
              }
              description={
                role.permissions.length
                  ? role.permissions
                      .map((permission) => permissionLabels[permission].label)
                      .join(" · ")
                  : "No actions beyond reading"
              }
            >
              <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                {memberships(role.assigned)}
              </span>
              {editable && (
                <>
                  <IconButton label={`Edit role ${role.name}`} onClick={() => edit(role)}>
                    <Pencil />
                  </IconButton>
                  {role.assigned ? (
                    <IconButton
                      label={`Delete role ${role.name}`}
                      onClick={() => {
                        remove.reset();
                        setDeleting({ role, reassignTo: "reader" });
                      }}
                    >
                      <Trash2 />
                    </IconButton>
                  ) : (
                    <Confirm
                      label={`Delete role ${role.name}`}
                      icon={<Trash2 />}
                      danger
                      description={`Delete the unused role ${role.name}?`}
                      onConfirm={() => destroy(role)}
                    />
                  )}
                </>
              )}
            </SettingRow>
          );
        })
      ) : (
        !roles.error && <EmptyState title="No roles" />
      )}
      <Modal
        title={draft?.role ? "Edit role" : "New role"}
        open={!!draft}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
        busy={busy}
      >
        {draft && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save(draft.role, draft.name.trim(), draft.permissions)
                .then(() => {
                  setDraft(null);
                  toast.success("Role saved");
                })
                .catch(() => {});
            }}
          >
            <Input
              label="Role name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              maxLength={40}
              required
              autoFocus
            />
            <fieldset className="mb-4">
              <legend className="mb-1 text-sm font-medium">Actions</legend>
              <p className="mt-0 mb-1 text-xs text-muted-foreground">
                Every member can read the projects they reach.
              </p>
              {permissions.map((permission) => (
                <Check
                  key={permission}
                  label={permissionLabels[permission].label}
                  description={permissionLabels[permission].description}
                  checked={draft.permissions.includes(permission)}
                  disabled={busy || !holds(permission)}
                  onCheckedChange={(checked) =>
                    setDraft({
                      ...draft,
                      permissions: checked
                        ? [...draft.permissions, permission]
                        : draft.permissions.filter((item) => item !== permission),
                    })
                  }
                />
              ))}
            </fieldset>
            {draft.role && draft.role.assigned > 0 && (
              <p className="text-xs text-muted-foreground">
                Changes apply at once to the {memberships(draft.role.assigned)} holding this role.
              </p>
            )}
            <FormActions
              error={create.error ?? update.error}
              pending={busy}
              submitLabel="Save role"
              submitDisabled={!draft.name.trim()}
              onCancel={() => setDraft(null)}
            />
          </form>
        )}
      </Modal>
      <Modal
        title="Delete role"
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        busy={remove.isPending}
      >
        {deleting && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void destroy(deleting.role, deleting.reassignTo).catch(() => {});
            }}
          >
            <p className="mt-0 text-sm text-muted-foreground">
              {memberships(deleting.role.assigned)}{" "}
              {deleting.role.assigned === 1 ? "holds" : "hold"} {deleting.role.name}. Choose the
              role they move to.
            </p>
            <Select
              label="Move members to"
              value={deleting.reassignTo}
              onValueChange={(reassignTo) => reassignTo && setDeleting({ ...deleting, reassignTo })}
            >
              {targets.map((role) => (
                <SelectItem key={role.id} value={role.id}>
                  {role.name}
                </SelectItem>
              ))}
            </Select>
            <FormActions
              error={remove.error}
              pending={remove.isPending}
              danger
              submitLabel="Delete role"
              pendingLabel="Deleting…"
              onCancel={() => setDeleting(null)}
            />
          </form>
        )}
      </Modal>
    </section>
  );
}
