import { useState } from "react";
import { z } from "zod";
import { Plus, Trash2, RotateCcw } from "lucide-react";
import { roles, roleLabels, memberSchema } from "@kanvil/contracts";
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
export function MemberDirectory({
  people,
  candidates = people,
  pending,
  loading,
  error,
  canAdmin,
  ownerId,
  scope,
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
  onChange: (email: string, role: (typeof roles)[number] | null) => Promise<unknown>;
}) {
  const [query, setQuery] = useState(""),
    [adding, setAdding] = useState(false),
    [email, setEmail] = useState(""),
    [failure, setFailure] = useState<unknown>();
  const matches = people.filter((person) =>
    `${person.name} ${person.email}`.toLowerCase().includes(query.toLowerCase()),
  );
  async function change(memberEmail: string, role: (typeof roles)[number] | null) {
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
            const owner = scope === "workspace" && person.userId === ownerId,
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
                    value={person.role}
                    disabled={
                      !canAdmin ||
                      pending ||
                      owner ||
                      (scope === "project" &&
                        person.source === "workspace" &&
                        person.role === "admin")
                    }
                    onValueChange={(role) => {
                      void change(person.email, z.enum(roles).parse(role)).catch(() => {});
                    }}
                  >
                    {roles.map((role) => (
                      <SelectItem key={role} value={role}>
                        {roleLabels[role]}
                      </SelectItem>
                    ))}
                  </Select>
                  {canAdmin &&
                    !owner &&
                    (scope === "workspace" || person.source !== "workspace") && (
                      <Confirm
                        label={
                          scope === "project" && person.inheritedRole
                            ? "Use workspace access"
                            : "Remove member"
                        }
                        icon={
                          scope === "project" && person.inheritedRole ? <RotateCcw /> : <Trash2 />
                        }
                        danger={!(scope === "project" && person.inheritedRole)}
                        description={
                          scope === "workspace"
                            ? `Remove ${person.name} from this workspace and all of its projects?`
                            : person.inheritedRole
                              ? `Restore ${roleLabels[person.inheritedRole]} workspace access for ${person.name}?`
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
            void change(email, z.enum(roles).parse(values.get("role")))
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
            defaultValue="writer"
          >
            {roles.map((role) => (
              <SelectItem key={role} value={role}>
                {roleLabels[role]}
              </SelectItem>
            ))}
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
