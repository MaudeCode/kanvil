import { UserRound, Palette, KeyRound, Bell, Plus, Pencil } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { toast } from "sonner";
import { infoSchema, roles, type Project } from "@kanvil/contracts";
import { api, auth, useOperation, useProjectAccess } from "./data.tsx";
import {
  Button,
  Confirm,
  ErrorNotice,
  Input,
  Select,
  SelectItem,
  Textarea,
  Modal,
  SectionHeading,
  Loading,
} from "./ui.tsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { SettingsLayout, SettingRow } from "./components/settings-layout.tsx";
import { Credentials } from "./components/credentials-settings.tsx";
import { ProfileSettings } from "./components/profile-settings.tsx";
import { AppearanceSettings } from "./components/appearance.tsx";
import { UserAvatar } from "./components/user-avatar.tsx";
import { accountSections } from "./search.ts";
import { formText } from "./forms.ts";
const roleLabels = { reader: "Read only", writer: "Can edit", admin: "Admin" };
export function ProjectSettings({ project }: { project: Project }) {
  const update = useOperation("update_project"),
    member = useOperation("set_member"),
    access = useProjectAccess(project.id),
    members = useQuery(api.query("list_members", { projectId: project.id }));
  const [editing, setEditing] = useState(false),
    [adding, setAdding] = useState(false),
    [draft, setDraft] = useState({
      name: project.name,
      description: project.description,
      version: project.version,
    });
  return (
    <>
      <header className="page-header">
        <h1>{project.name} settings</h1>
      </header>
      <Tabs defaultValue="project" className="settings">
        <TabsList variant="line" className="mb-6">
          <TabsTrigger value="project">General</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
        </TabsList>
        <TabsContent value="project">
          <section>
            <SectionHeading
              title="Project details"
              action={
                access.canAdmin && (
                  <Button
                    onClick={() => {
                      setDraft({
                        name: project.name,
                        description: project.description,
                        version: project.version,
                      });
                      update.reset();
                      setEditing(true);
                    }}
                  >
                    <Pencil />
                    Edit project
                  </Button>
                )
              }
            />
            <SettingRow title="Name" description={project.name} />
            <SettingRow title="Ticket prefix" description="This prefix is permanent.">
              <code className="rounded-md bg-muted px-2 py-1 text-sm">{project.key}</code>
            </SettingRow>
            <SettingRow title="Description" description={project.description || "No description"} />
          </section>
        </TabsContent>
        <TabsContent value="members">
          <section>
            <SectionHeading
              title="Members"
              action={
                access.canAdmin && (
                  <Button
                    variant="default"
                    onClick={() => {
                      member.reset();
                      setAdding(true);
                    }}
                  >
                    <Plus />
                    Add member
                  </Button>
                )
              }
            />
            <ErrorNotice error={members.error ?? (!adding ? member.error : undefined)} />
            {members.isPending ? (
              <Loading />
            ) : (
              members.data?.map((person) => (
                <div className="member-row" key={person.userId}>
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <UserAvatar name={person.name} />
                    <div className="min-w-0">
                      <strong className="block font-medium">{person.name}</strong>
                      <span className="break-all text-xs text-muted-foreground">
                        {person.email}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      label={`Role for ${person.name}`}
                      className="member-role mb-0 w-36"
                      value={person.role}
                      disabled={!access.canAdmin || member.isPending}
                      onValueChange={(value) => {
                        void member
                          .mutateAsync({
                            projectId: project.id,
                            email: person.email,
                            role: z.enum(roles).parse(value),
                          })
                          .catch(() => {});
                      }}
                    >
                      {roles.map((role) => (
                        <SelectItem key={role} value={role}>
                          {roleLabels[role]}
                        </SelectItem>
                      ))}
                    </Select>
                    {access.canAdmin && (
                      <Confirm
                        label="Remove member"
                        description={`Remove ${person.name}'s access to this project?`}
                        onConfirm={() =>
                          member.mutateAsync({
                            projectId: project.id,
                            email: person.email,
                            role: null,
                          })
                        }
                      />
                    )}
                  </div>
                </div>
              ))
            )}
          </section>
        </TabsContent>
      </Tabs>
      <Modal title="Edit project" open={editing} onOpenChange={setEditing} busy={update.isPending}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void update
              .mutateAsync({
                projectId: project.id,
                expectedVersion: draft.version,
                name: draft.name,
                description: draft.description,
              })
              .then(() => {
                setEditing(false);
                toast.success("Project saved");
              })
              .catch(() => {});
          }}
        >
          <Input
            label="Name"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            required
            maxLength={120}
          />
          <Textarea
            label="Description"
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            maxLength={5000}
          />
          {project.version !== draft.version && (
            <p role="alert">
              This project changed. Close and reopen the editor to load the current version.
            </p>
          )}
          <ErrorNotice error={update.error} />
          <div className="dialog-actions">
            <Button onClick={() => setEditing(false)} disabled={update.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={update.isPending || project.version !== draft.version}
            >
              Save project
            </Button>
          </div>
        </form>
      </Modal>
      <Modal title="Add member" open={adding} onOpenChange={setAdding} busy={member.isPending}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void member
              .mutateAsync({
                projectId: project.id,
                email: formText(values, "email"),
                role: z.enum(roles).parse(values.get("role")),
              })
              .then(() => {
                setAdding(false);
                toast.success("Member added");
              })
              .catch(() => {});
          }}
        >
          <Input label="Existing account email" type="email" name="email" required autoFocus />
          <p className="text-xs text-muted-foreground">
            Use an account that already exists on this instance.
          </p>
          <Select label="Project role" name="role" defaultValue="writer">
            {roles.map((role) => (
              <SelectItem key={role} value={role}>
                {roleLabels[role]}
              </SelectItem>
            ))}
          </Select>
          <ErrorNotice error={member.error} />
          <div className="dialog-actions">
            <Button onClick={() => setAdding(false)} disabled={member.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="default" disabled={member.isPending}>
              Add member
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
const personalSections = [
  { id: "account", label: "Profile & security", icon: UserRound },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "credentials", label: "API keys", icon: KeyRound },
  { id: "notifications", label: "Notifications", icon: Bell },
];
export function AccountSettings({
  section,
  onSectionChange,
}: {
  section: (typeof accountSections)[number];
  onSectionChange: (value: string) => void;
}) {
  const info = useQuery({
      queryKey: ["info"],
      queryFn: () => api.request("/api/v1/info", infoSchema),
    }),
    accounts = useQuery({
      queryKey: ["accounts"],
      queryFn: async () => {
        const result = await auth.listAccounts();
        if (result.error) throw new Error(result.error.message);
        return result.data;
      },
    });
  const [passwordOpen, setPasswordOpen] = useState(false),
    [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false);
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const values = new FormData(event.currentTarget);
    if (values.get("next") !== values.get("confirm")) {
      setError(new Error("The new passwords do not match."));
      return;
    }
    setPending(true);
    try {
      const result = await auth.changePassword({
        currentPassword: formText(values, "current"),
        newPassword: formText(values, "next"),
        revokeOtherSessions: true,
      });
      if (result.error) throw new Error(result.error.message);
      setPasswordOpen(false);
      toast.success("Password updated. Other sessions signed out.");
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <SettingsLayout
      title="Settings"
      value={section}
      onChange={onSectionChange}
      sections={personalSections}
    >
      <TabsContent value="account">
        <ProfileSettings />
        <section>
          <SectionHeading title="Sign-in & security" />
          <SettingRow
            title="Local password"
            description="Changing your password signs out your other sessions."
          >
            <Button
              onClick={() => {
                setError(undefined);
                setPasswordOpen(true);
              }}
            >
              Change password
            </Button>
          </SettingRow>
          {info.data?.oidc && (
            <SettingRow
              title={info.data.oidc.name}
              description={
                accounts.data?.some((account) => account.providerId === "oidc")
                  ? "Use this identity provider to sign in to the same account."
                  : "Link your account before signing in through this provider."
              }
            >
              {accounts.data?.some((account) => account.providerId === "oidc") ? (
                <Badge variant="secondary">Linked</Badge>
              ) : (
                <Button
                  disabled={pending}
                  onClick={() => {
                    setPending(true);
                    setError(undefined);
                    void auth
                      .linkSocial({ provider: "oidc", callbackURL: window.location.href })
                      .then((result) => {
                        if (result.error) throw new Error(result.error.message);
                      })
                      .catch(setError)
                      .finally(() => setPending(false));
                  }}
                >
                  Link {info.data.oidc.name}
                </Button>
              )}
            </SettingRow>
          )}
          {!passwordOpen && <ErrorNotice error={error} />}
          <ErrorNotice error={accounts.error ?? info.error} />
        </section>
        <Modal
          title="Change password"
          open={passwordOpen}
          onOpenChange={setPasswordOpen}
          busy={pending}
        >
          <form
            onSubmit={(event) => {
              void changePassword(event);
            }}
          >
            <Input
              label="Current password"
              name="current"
              type="password"
              autoComplete="current-password"
              required
            />
            <Input
              label="New password"
              name="next"
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
            <ErrorNotice error={error} />
            <div className="dialog-actions">
              <Button onClick={() => setPasswordOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" variant="default" disabled={pending}>
                Change password
              </Button>
            </div>
          </form>
        </Modal>
      </TabsContent>
      <TabsContent value="appearance">
        <AppearanceSettings />
      </TabsContent>
      <TabsContent value="credentials">
        <Credentials />
      </TabsContent>
      <TabsContent value="notifications">
        <NotificationPreferences pushAvailable={info.data?.push ?? false} />
      </TabsContent>
    </SettingsLayout>
  );
}
function NotificationPreferences({ pushAvailable }: { pushAvailable: boolean }) {
  const cache = useQueryClient(),
    options = api.notificationPreferences(),
    preferences = useQuery(options),
    update = useMutation({
      mutationFn: api.setNotificationPreferences,
      networkMode: "always",
      retry: false,
      onSuccess: (value) => cache.setQueryData(options.queryKey, value),
    });
  return (
    <section>
      <SectionHeading title="Notifications" />
      <ErrorNotice error={preferences.error ?? update.error} />
      {preferences.isPending ? (
        <Loading />
      ) : (
        preferences.data && (
          <>
            <SettingRow title="Inbox" description="Updates to tickets you follow appear in Kanvil.">
              <Switch
                aria-label="Subscribed ticket updates in Inbox"
                checked={update.isPending ? update.variables.inApp : preferences.data.inApp}
                disabled={update.isPending}
                onCheckedChange={(checked) =>
                  update.mutate({ ...preferences.data, inApp: checked })
                }
              />
            </SettingRow>
            <SettingRow
              title="Push notifications"
              description={
                pushAvailable
                  ? "Send updates to devices you’ve registered."
                  : "Push delivery is not enabled on this instance."
              }
            >
              <Switch
                aria-label="Push notifications on registered devices"
                checked={
                  update.isPending ? (update.variables.push ?? false) : preferences.data.push
                }
                disabled={update.isPending || !pushAvailable}
                onCheckedChange={(checked) =>
                  update.mutate({ inApp: preferences.data?.inApp ?? true, push: checked })
                }
              />
            </SettingRow>
          </>
        )
      )}
    </section>
  );
}
