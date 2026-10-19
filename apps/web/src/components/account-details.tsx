import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pencil, KeyRound, Plus } from "lucide-react";
import { hasAdminRole, okSchema, roleLabels } from "@kanvil/contracts";
import { accountDetailsSchema } from "@kanvil/contracts/users";
import { t } from "@kanvil/contracts/i18n";
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
import { DeleteAccountRow, signInMethods } from "./project-lifecycle.tsx";
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
            : t("admin.account.updateFailed"),
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
            <SheetTitle className="mb-0">{person?.name ?? t("admin.account.details")}</SheetTitle>
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
                        {person.banned ? t("admin.users.disabled") : t("admin.users.active")}
                      </Badge>
                      <p className="mt-2 mb-0 text-xs text-muted-foreground">
                        {t("admin.account.joined", { date: date(person.createdAt) })}
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
                      {t("admin.account.edit")}
                    </Button>
                  </div>
                  <SettingRow
                    title={t("admin.account.instanceRole")}
                    description={
                      hasAdminRole(person.role)
                        ? t("admin.account.adminDescription")
                        : t("admin.account.userDescription")
                    }
                  >
                    <Button
                      onClick={() => {
                        setError(undefined);
                        setEditing("role");
                      }}
                    >
                      {t("admin.account.changeRole")}
                    </Button>
                  </SettingRow>
                  <SettingRow
                    title={t("admin.account.signInMethods")}
                    description={signInMethods(person.providers)}
                  >
                    <Button
                      onClick={() => {
                        setError(undefined);
                        setEditing("password");
                      }}
                    >
                      <KeyRound />
                      {t("admin.account.setPassword")}
                    </Button>
                  </SettingRow>
                  <SettingRow
                    title={t("admin.account.activeSessions")}
                    description={t("admin.account.sessions", { count: person.sessionCount })}
                  >
                    <Confirm
                      label={t("admin.account.revokeSessions")}
                      description={t("admin.account.revokeConfirm", { name: person.name })}
                      onConfirm={() =>
                        action(
                          () => auth.admin.revokeUserSessions({ userId: person.id }),
                          t("admin.account.sessionsRevoked"),
                        )
                      }
                    />
                  </SettingRow>
                  {person.id !== identity.id && (
                    <SettingRow
                      title={t("admin.account.access")}
                      description={
                        person.banned
                          ? t("admin.account.accessDisabled")
                          : t("admin.account.accessPreserved")
                      }
                    >
                      <Confirm
                        label={
                          person.banned ? t("admin.account.enable") : t("admin.account.disable")
                        }
                        danger={!person.banned}
                        description={
                          person.banned
                            ? t("admin.account.enableConfirm", { name: person.name })
                            : t("admin.account.disableConfirm", { name: person.name })
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
                            person.banned
                              ? t("admin.account.enabled")
                              : t("admin.account.disabledToast"),
                          )
                        }
                      />
                    </SettingRow>
                  )}
                  {person.id !== identity.id && (
                    <DeleteAccountRow
                      account={person}
                      onDeleted={async () => {
                        onClose();
                        await onChanged();
                      }}
                    />
                  )}
                  <section className="pt-7">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="mb-0">{t("admin.account.workspaces")}</h3>
                      <Button
                        size="sm"
                        onClick={() => {
                          setError(undefined);
                          setEditing("workspace");
                        }}
                      >
                        <Plus />
                        {t("admin.account.addToWorkspace")}
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
                            dir="auto"
                          >
                            {workspace.name}
                          </Link>
                        </AccessRow>
                      ))
                    ) : (
                      <EmptyState title={t("admin.account.noWorkspaces")} className="py-5" />
                    )}
                  </section>
                  {!!person.projects.length && (
                    <section className="pt-7">
                      <h3>{t("admin.account.projectAccess")}</h3>
                      {person.projects.map((project) => (
                        <AccessRow key={project.id} badge={roleLabels[project.role]}>
                          <Link
                            to="/projects/$projectId/settings"
                            params={{ projectId: project.id }}
                            search={{ section: "members" }}
                            onClick={onClose}
                            className="text-primary"
                            dir="auto"
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
              ? t("admin.account.edit")
              : editing === "role"
                ? t("admin.account.changeRoleTitle")
                : editing === "workspace"
                  ? t("admin.account.addToWorkspace")
                  : t("admin.account.setPassword")
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
                message = t("admin.account.updated");
              } else if (editing === "role") {
                run = () =>
                  auth.admin.setRole({
                    userId: person.id,
                    role: values.get("role") === "admin" ? "admin" : "user",
                  });
                message = t("admin.account.roleUpdated");
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
                message = t("admin.account.workspaceAdded");
              } else {
                const password = formText(values, "password");
                if (password !== formText(values, "confirm")) {
                  setError(new Error(t("admin.account.passwordMismatch")));
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
                message = t("admin.account.passwordSet");
              }
              void action(run, message).catch(() => {});
            }}
          >
            {editing === "profile" ? (
              <>
                <Input
                  label={t("admin.account.name")}
                  name="name"
                  defaultValue={person.name}
                  required
                  maxLength={120}
                  autoFocus
                />
                <Input
                  label={t("admin.account.email")}
                  name="email"
                  type="email"
                  defaultValue={person.email}
                  required
                />
              </>
            ) : editing === "role" ? (
              <>
                <Select
                  label={t("admin.account.instanceRole")}
                  name="role"
                  defaultValue={hasAdminRole(person.role) ? "admin" : "user"}
                >
                  <SelectItem value="user">{t("admin.account.user")}</SelectItem>
                  <SelectItem value="admin">{t("admin.account.administrator")}</SelectItem>
                </Select>
                <p className="text-sm text-muted-foreground">{t("admin.account.adminsNote")}</p>
              </>
            ) : editing === "workspace" ? (
              <>
                <Select label={t("admin.account.workspace")} name="workspace" required>
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
                <Select label={t("admin.account.workspaceRole")} name="role" defaultValue="writer">
                  <SelectItem value="reader">{roleLabels.reader}</SelectItem>
                  <SelectItem value="writer">{roleLabels.writer}</SelectItem>
                  <SelectItem value="admin">{roleLabels.admin}</SelectItem>
                </Select>
              </>
            ) : (
              <>
                <Input
                  label={t("admin.account.newPassword")}
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                />
                <Input
                  label={t("admin.account.confirmPassword")}
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                />
                <p className="text-sm text-muted-foreground">{t("admin.account.passwordNote")}</p>
              </>
            )}
            <FormActions
              error={error}
              pending={pending}
              submitLabel={t("admin.account.save")}
              pendingLabel={t("common.state.saving")}
              onCancel={() => setEditing(null)}
            />
          </form>
        </Modal>
      )}
    </>
  );
}
