import { useState } from "react";
import { z } from "zod";
import { Plus, Search, Trash2, RotateCcw } from "lucide-react";
import { roles, memberSchema } from "@kanvil/contracts";
import { toast } from "sonner";
import {
  Button,
  Confirm,
  EmptyState,
  ErrorNotice,
  Loading,
  Modal,
  SectionHeading,
  Select,
  SelectItem,
} from "../ui.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { UserIdentity } from "./user-avatar.tsx";
import { UserPicker } from "./user-picker.tsx";
export const roleLabels = { reader: "Read only", writer: "Can edit", admin: "Admin" };
export function MemberDirectory({
  people,
  candidates = people,
  pending,
  loading,
  error,
  canAdmin,
  scope,
  onChange,
}: {
  people: z.output<typeof memberSchema>[];
  candidates?: z.output<typeof memberSchema>[];
  pending: boolean;
  loading: boolean;
  error: unknown;
  canAdmin: boolean;
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
          canAdmin && (
            <Button
              variant="default"
              onClick={() => {
                setFailure(undefined);
                setEmail("");
                setAdding(true);
              }}
            >
              <Plus />
              Add member
            </Button>
          )
        }
      />
      <div className="mb-5 max-w-md">
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Search members"
            placeholder="Search members…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
      </div>
      {!adding && <ErrorNotice error={failure ?? error} />}
      {loading ? (
        <Loading />
      ) : matches.length ? (
        matches.map((person) => (
          <div key={person.userId} className="member-row">
            <div className="min-w-0 flex-1">
              <UserIdentity name={person.name} email={person.email} image={person.image} />
              {scope === "project" && person.source === "workspace" && (
                <p className="mt-1 mb-0 pl-11 text-xs text-muted-foreground">Workspace access</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Select
                label={`Role for ${person.name}`}
                className="member-role mb-0 w-36"
                value={person.role}
                disabled={
                  !canAdmin ||
                  pending ||
                  (scope === "project" && person.source === "workspace" && person.role === "admin")
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
              {canAdmin && (scope === "workspace" || person.source !== "workspace") && (
                <Confirm
                  label={
                    scope === "project" && person.inheritedRole
                      ? "Use workspace access"
                      : "Remove member"
                  }
                  icon={scope === "project" && person.inheritedRole ? <RotateCcw /> : <Trash2 />}
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
            </div>
          </div>
        ))
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
          <ErrorNotice error={failure} />
          <div className="dialog-actions">
            <Button disabled={pending} onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="default" disabled={pending || !email}>
              Add member
            </Button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
