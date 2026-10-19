import { useState } from "react";
import { z } from "zod";
import { Plus, Trash2, RotateCcw } from "lucide-react";
import {
  roles,
  roleLabels,
  seededPermissions,
  type memberSchema,
  type Permission,
  type WorkspaceRole,
} from "@kanvil/contracts";
import { toast } from "sonner";
import {
  Confirm,
  EmptyState,
  ErrorNotice,
  IconButton,
  Loading,
  SearchField,
  Modal,
  SectionHeading,
  Select,
  SelectItem,
  FormActions,
} from "../ui.tsx";
import { Item, ItemActions, ItemContent, ItemGroup } from "@/components/ui/item";
import { Badge } from "@/components/ui/badge";
import { UserIdentity } from "./user-avatar.tsx";
import { UserPicker } from "./user-picker.tsx";
import { t } from "@kanvil/contracts/i18n";
// Before the role catalog loads, and from servers without custom roles, the seeded roles.
const seededRoles = roles.map((id) => ({
  id,
  name: roleLabels[id],
  permissions: seededPermissions[id],
}));
// A seeded role reads in the interface language; a custom role's name is the workspace's own.
export function roleName(role: { id: string; name: string }) {
  const seeded = roles.find((id) => id === role.id);
  return seeded ? roleLabels[seeded] : role.name;
}
export function MemberDirectory({
  people,
  candidates = people,
  pending,
  loading,
  error,
  canAdmin,
  ownerId,
  scope,
  roles: catalog,
  authority,
  onChange,
}: {
  people: z.output<typeof memberSchema>[];
  candidates?: z.output<typeof memberSchema>[];
  pending: boolean;
  loading: boolean;
  error: unknown;
  canAdmin: boolean;
  // The workspace owner keeps the Admin role until ownership is transferred.
  ownerId?: string | null | undefined;
  scope: "project" | "workspace";
  // The seeded and custom roles a membership here can hold.
  roles?: WorkspaceRole[] | undefined;
  // The viewer's own role here: no one grants, changes, or removes a role beyond it, and only an
  // administrator grants Admin. The server enforces the same rule.
  authority: { admin: boolean; capabilities: readonly Permission[] };
  onChange: (email: string, role: string | null) => Promise<unknown>;
}) {
  const [query, setQuery] = useState(""),
    [adding, setAdding] = useState(false),
    [email, setEmail] = useState(""),
    [failure, setFailure] = useState<unknown>();
  const options: { id: string; name: string; permissions: readonly Permission[] }[] =
    catalog?.length ? catalog : seededRoles;
  const nameOf = (id: string | null | undefined) => {
    const option = options.find((item) => item.id === id);
    return option ? roleName(option) : id ? t("settings.members.customRole") : "";
  };
  const grantable = (id: string) => {
    const option = options.find((candidate) => candidate.id === id);
    return (
      !!option &&
      (id !== "admin" || authority.admin) &&
      option.permissions.every((permission) => authority.capabilities.includes(permission))
    );
  };
  const matches = people.filter((person) =>
    `${person.name} ${person.email}`.toLowerCase().includes(query.toLowerCase()),
  );
  const choices = options.map((option) => (
    <SelectItem key={option.id} value={option.id} disabled={!grantable(option.id)}>
      {roleName(option)}
    </SelectItem>
  ));
  async function change(memberEmail: string, role: string | null) {
    setFailure(undefined);
    try {
      await onChange(memberEmail, role);
    } catch (cause) {
      setFailure(cause);
      throw cause;
    }
  }
  return (
    <section>
      <SectionHeading
        title={t("settings.members.title")}
        action={
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <SearchField
              label={t("settings.members.search")}
              placeholder={t("settings.members.searchPlaceholder")}
              value={query}
              onChange={setQuery}
            />
            {canAdmin && (
              <IconButton
                label={t("settings.members.add")}
                variant="default"
                onClick={() => {
                  setFailure(undefined);
                  setEmail("");
                  setAdding(true);
                }}
              >
                <Plus />
              </IconButton>
            )}
          </div>
        }
      />
      {!adding && <ErrorNotice error={failure ?? error} />}
      {loading ? (
        <Loading />
      ) : matches.length ? (
        <ItemGroup className="gap-0">
          {matches.map((person) => {
            const held = person.roleId ?? person.role,
              inherited = person.inheritedRoleId ?? person.inheritedRole,
              owner = scope === "workspace" && person.userId === ownerId,
              badge =
                scope === "project" && person.source === "workspace"
                  ? t("settings.members.workspaceAccess")
                  : owner
                    ? t("settings.members.owner")
                    : null;
            return (
              <Item
                key={person.userId}
                className="member-row rounded-none border-x-0 border-t-0 border-b-border px-0 py-3"
              >
                <ItemContent className="min-w-0">
                  <UserIdentity name={person.name} email={person.email} image={person.image} />
                  {badge && (
                    <Badge variant="outline" className="mt-1.5 ml-11 w-fit font-normal">
                      {badge}
                    </Badge>
                  )}
                </ItemContent>
                <ItemActions>
                  <Select
                    label={t("settings.members.roleFor", { name: person.name })}
                    labelHidden
                    className="mb-0 w-36"
                    value={held}
                    disabled={
                      !canAdmin ||
                      pending ||
                      owner ||
                      !grantable(held) ||
                      (scope === "project" && person.source === "workspace" && held === "admin")
                    }
                    onValueChange={(role) => {
                      void change(person.email, z.string().parse(role)).catch(() => {});
                    }}
                  >
                    {options.some((option) => option.id === held)
                      ? choices
                      : [
                          ...choices,
                          <SelectItem key={held} value={held} disabled>
                            {nameOf(held)}
                          </SelectItem>,
                        ]}
                  </Select>
                  {canAdmin &&
                    !owner &&
                    grantable(held) &&
                    (scope === "workspace" || person.source !== "workspace") && (
                      <Confirm
                        label={
                          scope === "project" && inherited
                            ? t("settings.members.useWorkspaceAccess")
                            : t("settings.members.remove")
                        }
                        icon={scope === "project" && inherited ? <RotateCcw /> : <Trash2 />}
                        danger={!(scope === "project" && inherited)}
                        description={
                          scope === "workspace"
                            ? t("settings.members.removeFromWorkspace", { name: person.name })
                            : inherited
                              ? t("settings.members.restoreAccess", {
                                  role: nameOf(inherited),
                                  name: person.name,
                                })
                              : t("settings.members.removeFromProject", { name: person.name })
                        }
                        onConfirm={() => change(person.email, null)}
                      />
                    )}
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      ) : (
        <EmptyState
          title={query ? t("settings.members.noMatches") : t("settings.members.empty")}
          className="py-10"
        />
      )}
      <Modal
        title={t("settings.members.add")}
        open={adding}
        onOpenChange={setAdding}
        busy={pending}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void change(email, z.string().parse(values.get("role")))
              .then(() => {
                setAdding(false);
                toast.success(t("settings.members.added"));
              })
              .catch(() => {});
          }}
        >
          <UserPicker people={candidates} value={email} onChange={setEmail} disabled={pending} />
          <Select
            label={
              scope === "project"
                ? t("settings.members.projectRole")
                : t("settings.members.workspaceRole")
            }
            name="role"
            defaultValue={grantable("writer") ? "writer" : "reader"}
          >
            {choices}
          </Select>
          <FormActions
            error={failure}
            pending={pending}
            submitLabel={t("settings.members.add")}
            submitDisabled={!email}
            onCancel={() => setAdding(false)}
          />
        </form>
      </Modal>
    </section>
  );
}
