import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pencil, KeyRound, Plus } from "lucide-react";
import { hasAdminRole, okSchema, roleLabels } from "@kanvil/contracts";
import { accountDetailsSchema } from "@kanvil/contracts/users";
import { toast } from "sonner";
import { api, auth, date, useIdentity, useOperation, useWorkspaces } from "../data.tsx";
import {
  Button,
  Confirm,
  EmptyState,
  ErrorNotice,
  Input,
  Loading,
  Modal,
  Select,
  SelectItem,
  FormActions,
} from "../ui.tsx";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { SettingRow } from "./settings-layout.tsx";
import { UserAvatar } from "./user-avatar.tsx";
import { formText } from "../forms.ts";
// One workspace or project grant: a link to its member settings and the role or access it carries.
export function AccessRow({ children, badge }: { children: ReactNode; badge: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-3">
      {children}
      <Badge variant="outline">{badge}</Badge>
    </div>
  );
}
export function AccountDetails({
  userId,
  onClose,
  onChanged,
}: {
  userId: string | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const identity = useIdentity(),
    [editing, setEditing] = useState<"profile" | "role" | "password" | "workspace" | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>();
  const spaces = useWorkspaces(),
    membership = useOperation("set_workspace_member");
  const detail = useQuery({
    queryKey: ["kanvil", "user", userId],
    queryFn: () =>
      api.request(`/api/v1/admin/users/${encodeURIComponent(userId ?? "")}`, accountDetailsSchema),
    enabled: !!userId,
  });
  const person = detail.data;
  async function action(run: () => Promise<unknown>, message: string) {
    setPending(true);
    setError(undefined);
    try {
      const result = await run();
      if (result && typeof result === "object" && "error" in result && result.error) {
        const cause = result.error;
        throw new Error(
          typeof cause === "object" && "message" in cause
            ? String(cause.message)
            : "The account could not be updated",
        );
      }
      await onChanged();
      setEditing(null);
      toast.success(message);
    } catch (cause) {
      setError(cause);
      throw cause;
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Sheet
        open={!!userId}
        onOpenChange={(open) => {
          if (!open && !pending) onClose();
        }}
      >
        <SheetContent className="w-full! sm:max-w-lg!">
          <SheetHeader className="shrink-0 border-b pr-14">
            <SheetTitle className="mb-0">{person?.name ?? "Account details"}</SheetTitle>
            <SheetDescription className="break-all">{person?.email}</SheetDescription>
          </SheetHeader>
          <div className="@container min-h-0 overflow-y-auto px-6 pb-8">
            <ErrorNotice error={detail.error ?? (!editing ? error : undefined)} />
            {detail.isPending ? (
              <Loading />
            ) : (
              person && (
                <>
                  <div className="mb-7 flex flex-wrap items-center gap-4">
                    <UserAvatar
                      name={person.name}
                      image={person.image}
                      className="size-16 text-xl"
                    />
                    <div className="min-w-40 flex-1">
                      <Badge variant={person.banned ? "destructive" : "secondary"}>
                        {person.banned ? "Disabled" : "Active"}
                      </Badge>
                      <p className="mt-2 mb-0 text-xs text-muted-foreground">
                        Joined {date(person.createdAt)}
                      </p>
                    </div>
                    <Button
                      className="ml-auto"
                      onClick={() => {
                        setError(undefined);
                        setEditing("profile");
                      }}
                    >
                      <Pencil />
                      Edit account
                    </Button>
                  </div>
                  <SettingRow
                    title="Instance role"
                    description={
                      hasAdminRole(person.role)
                        ? "Can administer every workspace, account, and deployment setting."
                        : "Workspace and project roles determine access."
                    }
                  >
                    <Button
                      onClick={() => {
                        setError(undefined);
                        setEditing("role");
                      }}
                    >
                      Change role
                    </Button>
                  </SettingRow>
                  <SettingRow
                    title="Sign-in methods"
                    description={
                      person.providers
                        .map((provider) =>
                          provider === "credential"
                            ? "Local password"
                            : provider === "oidc"
                              ? "OIDC"
                              : provider,
                        )
                        .join(", ") || "No linked sign-in methods"
                    }
                  >
                    <Button
                      onClick={() => {
                        setError(undefined);
                        setEditing("password");
                      }}
                    >
                      <KeyRound />
                      Set local password
                    </Button>
                  </SettingRow>
                  <SettingRow
                    title="Active sessions"
                    description={`${person.sessionCount} ${person.sessionCount === 1 ? "session" : "sessions"}`}
                  >
                    <Confirm
                      label="Revoke sessions"
                      description={`Sign ${person.name} out of every device? API keys stay active.`}
                      onConfirm={() =>
                        action(
                          () => auth.admin.revokeUserSessions({ userId: person.id }),
                          "Sessions revoked",
                        )
                      }
                    />
                  </SettingRow>
                  {person.id !== identity.id && (
                    <SettingRow
                      title="Account access"
                      description={
                        person.banned
                          ? "Sign-in and API access are disabled."
                          : "Disabling an account preserves tickets and activity history."
                      }
                    >
                      <Confirm
                        label={person.banned ? "Enable account" : "Disable account"}
                        danger={!person.banned}
                        description={
                          person.banned
                            ? `Restore sign-in for ${person.name}?`
                            : `Disable ${person.name}'s sign-in and API access, and revoke their sessions?`
                        }
                        onConfirm={() =>
                          action(
                            () =>
                              person.banned
                                ? auth.admin.unbanUser({ userId: person.id })
                                : auth.admin.banUser({
                                    userId: person.id,
                                    banReason: "Disabled by an instance administrator",
                                  }),
                            person.banned ? "Account enabled" : "Account disabled",
                          )
                        }
                      />
                    </SettingRow>
                  )}
                  <section className="pt-7">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="mb-0">Workspaces</h3>
                      <Button
                        size="sm"
                        onClick={() => {
                          setError(undefined);
                          setEditing("workspace");
                        }}
                      >
                        <Plus />
                        Add to workspace
                      </Button>
                    </div>
                    {person.workspaces.length ? (
                      person.workspaces.map((workspace) => (
                        <AccessRow key={workspace.id} badge={roleLabels[workspace.role]}>
                          <Link
                            to="/workspaces/$workspaceId/settings"
                            params={{ workspaceId: workspace.id }}
                            search={{ section: "members" }}
                            onClick={onClose}
                            className="text-primary"
                          >
                            {workspace.name}
                          </Link>
                        </AccessRow>
                      ))
                    ) : (
                      <EmptyState title="No workspace membership" className="py-5" />
                    )}
                  </section>
                  {!!person.projects.length && (
                    <section className="pt-7">
                      <h3>Direct project access</h3>
                      {person.projects.map((project) => (
                        <AccessRow key={project.id} badge={roleLabels[project.role]}>
                          <Link
                            to="/projects/$projectId/settings"
                            params={{ projectId: project.id }}
                            search={{ section: "members" }}
                            onClick={onClose}
                            className="text-primary"
                          >
                            {project.name}
                          </Link>
                        </AccessRow>
                      ))}
                    </section>
                  )}
                </>
              )
            )}
          </div>
        </SheetContent>
      </Sheet>
      {person && (
        <Modal
          title={
            editing === "profile"
              ? "Edit account"
              : editing === "role"
                ? "Change instance role"
                : editing === "workspace"
                  ? "Add to workspace"
                  : "Set local password"
          }
          open={!!editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          busy={pending}
        >
          <form
            key={editing}
            onSubmit={(event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              let run: () => Promise<unknown>, message: string;
              if (editing === "profile") {
                run = () =>
                  auth.admin.updateUser({
                    userId: person.id,
                    data: { name: formText(values, "name"), email: formText(values, "email") },
                  });
                message = "Account updated";
              } else if (editing === "role") {
                run = () =>
                  auth.admin.setRole({
                    userId: person.id,
                    role: values.get("role") === "admin" ? "admin" : "user",
                  });
                message = "Instance role updated";
              } else if (editing === "workspace") {
                run = () =>
                  membership.mutateAsync({
                    workspaceId: formText(values, "workspace"),
                    email: person.email,
                    role:
                      formText(values, "role") === "reader"
                        ? "reader"
                        : formText(values, "role") === "admin"
                          ? "admin"
                          : "writer",
                  });
                message = "Workspace access added";
              } else {
                const password = formText(values, "password");
                if (password !== formText(values, "confirm")) {
                  setError(new Error("The new passwords do not match."));
                  return;
                }
                run = () =>
                  api.request(
                    `/api/v1/admin/users/${encodeURIComponent(person.id)}/password`,
                    okSchema,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ password }),
                    },
                  );
                message = "Local password set and sessions revoked";
              }
              void action(run, message).catch(() => {});
            }}
          >
            {editing === "profile" ? (
              <>
                <Input
                  label="Name"
                  name="name"
                  defaultValue={person.name}
                  required
                  maxLength={120}
                  autoFocus
                />
                <Input
                  label="Email"
                  name="email"
                  type="email"
                  defaultValue={person.email}
                  required
                />
              </>
            ) : editing === "role" ? (
              <>
                <Select
                  label="Instance role"
                  name="role"
                  defaultValue={hasAdminRole(person.role) ? "admin" : "user"}
                >
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="admin">Administrator</SelectItem>
                </Select>
                <p className="text-sm text-muted-foreground">
                  Administrators can manage all workspaces, users, and instance settings.
                </p>
              </>
            ) : editing === "workspace" ? (
              <>
                <Select label="Workspace" name="workspace" required>
                  {spaces.data
                    ?.filter(
                      (workspace) =>
                        !person.workspaces.some((current) => current.id === workspace.id),
                    )
                    .map((workspace) => (
                      <SelectItem key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </SelectItem>
                    ))}
                </Select>
                <Select label="Workspace role" name="role" defaultValue="writer">
                  <SelectItem value="reader">Read only</SelectItem>
                  <SelectItem value="writer">Can edit</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </Select>
              </>
            ) : (
              <>
                <Input
                  label="New password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                />
                <Input
                  label="Confirm new password"
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                />
                <p className="text-sm text-muted-foreground">
                  This sets a local password and signs the user out of every device.
                </p>
              </>
            )}
            <FormActions
              error={error}
              pending={pending}
              submitLabel="Save changes"
              pendingLabel="Saving…"
              onCancel={() => setEditing(null)}
            />
          </form>
        </Modal>
      )}
    </>
  );
}
