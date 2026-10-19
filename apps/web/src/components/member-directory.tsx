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
// Before the role catalog loads, and from servers without custom roles, the seeded roles.
const seededRoles = roles.map((id) => ({
  id,
  name: roleLabels[id],
  permissions: seededPermissions[id],
}));
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
  const nameOf = (id: string | null | undefined) =>
    options.find((option) => option.id === id)?.name ?? (id ? "Custom role" : "");
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
      {option.name}
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
        title="Members"
        action={
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <SearchField
              label="Search members"
              placeholder="Name or email…"
              value={query}
              onChange={setQuery}
            />
            {canAdmin && (
              <IconButton
                label="Add member"
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
                  ? "Workspace access"
                  : owner
                    ? "Owner"
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
                    label={`Role for ${person.name}`}
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
                            ? "Use workspace access"
                            : "Remove member"
                        }
                        icon={scope === "project" && inherited ? <RotateCcw /> : <Trash2 />}
                        danger={!(scope === "project" && inherited)}
                        description={
                          scope === "workspace"
                            ? `Remove ${person.name} from this workspace and all of its projects?`
                            : inherited
                              ? `Restore ${nameOf(inherited)} workspace access for ${person.name}?`
                              : `Remove ${person.name}'s project access?`
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
        <EmptyState title={query ? "No matching members" : "No members"} className="py-10" />
      )}
      <Modal title="Add member" open={adding} onOpenChange={setAdding} busy={pending}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void change(email, z.string().parse(values.get("role")))
              .then(() => {
                setAdding(false);
                toast.success("Member added");
              })
              .catch(() => {});
          }}
        >
          <UserPicker people={candidates} value={email} onChange={setEmail} disabled={pending} />
          <Select
            label={scope === "project" ? "Project role" : "Workspace role"}
            name="role"
            defaultValue={grantable("writer") ? "writer" : "reader"}
          >
            {choices}
          </Select>
          <FormActions
            error={failure}
            pending={pending}
            submitLabel="Add member"
            submitDisabled={!email}
            onCancel={() => setAdding(false)}
          />
        </form>
      </Modal>
    </section>
  );
}
