import { UserRound, Palette, KeyRound, Bell } from "lucide-react";
import { SettingsLayout } from "./components/settings-layout.tsx";
import { Credentials } from "./components/credentials-settings.tsx";
import { accountSections } from "./search.ts";
import { ProfileSettings } from "./components/profile-settings.tsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AppearanceSettings } from "./components/appearance.tsx";
import { formText } from "./forms.ts";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { infoSchema, roles, type Project } from "@kanvil/contracts";
import { api, auth, useOperation } from "./data.tsx";
import { Button, Check, Confirm, ErrorNotice, Input, Select, SelectItem, Textarea } from "./ui.tsx";

export function ProjectSettings({ project }: { project: Project }) {
  const update = useOperation("update_project"),
    member = useOperation("set_member");
  const members = useQuery(api.query("list_members", { projectId: project.id }));
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
            <h2>Project</h2>
            <form
              key={project.version}
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                update.mutate({
                  projectId: project.id,
                  expectedVersion: project.version,
                  name: formText(data, "name"),
                  description: formText(data, "description"),
                });
              }}
            >
              <Input
                label="Name"
                name="name"
                defaultValue={project.name}
                required
                maxLength={120}
              />
              <Input label="Permanent prefix" value={project.key} readOnly />
              <Textarea
                label="Description"
                name="description"
                defaultValue={project.description}
                maxLength={5000}
              />
              <ErrorNotice error={update.error} />
              <Button type="submit" disabled={update.isPending}>
                Save project
              </Button>
              {update.isSuccess && <p role="status">Project saved</p>}
            </form>
          </section>
        </TabsContent>
        <TabsContent value="members">
          <section>
            <h2>Members</h2>
            <ErrorNotice error={members.error ?? member.error} />
            {members.data?.map((person) => (
              <div className="resource-row" key={person.userId}>
                <span>
                  {person.name}
                  <small className="muted"> {person.email}</small>
                </span>
                <Select
                  label={`Role for ${person.name}`}
                  value={person.role}
                  onValueChange={(value) =>
                    member.mutate({
                      projectId: project.id,
                      email: person.email,
                      role: z.enum(roles).parse(value ?? ""),
                    })
                  }
                >
                  {roles.map((role) => (
                    <SelectItem key={role} value={role}>
                      {role}
                    </SelectItem>
                  ))}
                </Select>
                <Confirm
                  label="Remove member"
                  description={`Remove ${person.name}'s access to this project?`}
                  onConfirm={() =>
                    member.mutateAsync({ projectId: project.id, email: person.email, role: null })
                  }
                />
              </div>
            ))}
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                member.mutate({
                  projectId: project.id,
                  email: formText(data, "email"),
                  role: z.enum(roles).parse(data.get("role")),
                });
              }}
            >
              <Input label="Existing account email" type="email" name="email" required />
              <Select label="Project role" name="role" defaultValue="writer">
                {roles.map((role) => (
                  <SelectItem key={role} value={role}>
                    {role}
                  </SelectItem>
                ))}
              </Select>
              <Button type="submit" disabled={member.isPending}>
                Add member
              </Button>
            </form>
          </section>
        </TabsContent>
      </Tabs>
    </>
  );
}
const personalSections = [
  { id: "account", label: "Profile & security", icon: UserRound },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "credentials", label: "Agent credentials", icon: KeyRound },
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
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: async () => {
      const result = await auth.listAccounts();
      if (result.error) throw new Error(result.error.message);
      return result.data;
    },
  });
  const [error, setError] = useState<unknown>(),
    [message, setMessage] = useState(""),
    [pending, setPending] = useState(false);
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      values = new FormData(form);
    setError(undefined);
    setPending(true);
    try {
      const result = await auth.changePassword({
        currentPassword: formText(values, "current"),
        newPassword: formText(values, "next"),
        revokeOtherSessions: true,
      });
      if (result.error) throw new Error(result.error.message);
      setMessage("Password updated; other sessions revoked");
      form.reset();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <SettingsLayout
        title="Settings"
        value={section}
        onChange={onSectionChange}
        sections={personalSections}
      >
        <TabsContent value="account">
          <section>
            <h2>Account</h2>
            <ProfileSettings />
            <h3>Password</h3>
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
              <Button type="submit" disabled={pending}>
                Change password
              </Button>
            </form>
            <ErrorNotice error={error} />
            {message && <p role="status">{message}</p>}
            {info.data?.oidc && (
              <div className="oidc">
                <h3>{info.data.oidc.name}</h3>
                {accounts.data?.some((account) => account.providerId === "oidc") ? (
                  <p>Account linked. You can sign in with {info.data.oidc.name}.</p>
                ) : (
                  <>
                    <p>Link this account before signing in through your identity provider.</p>
                    <Button
                      onClick={() => {
                        void auth
                          .linkSocial({ provider: "oidc", callbackURL: window.location.href })
                          .then((result) => {
                            if (result.error) setError(new Error(result.error.message));
                          });
                      }}
                    >
                      Link {info.data.oidc.name}
                    </Button>
                  </>
                )}
              </div>
            )}
            <ErrorNotice error={accounts.error} />
          </section>
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
    </>
  );
}
function NotificationPreferences({ pushAvailable }: { pushAvailable: boolean }) {
  const cache = useQueryClient(),
    options = api.notificationPreferences();
  const preferences = useQuery(options);
  const update = useMutation({
    mutationFn: api.setNotificationPreferences,
    networkMode: "always",
    retry: false,
    onSuccess: (value) => cache.setQueryData(options.queryKey, value),
  });
  return (
    <section>
      <h2>Notifications</h2>
      <ErrorNotice error={preferences.error ?? update.error} />
      {preferences.data && (
        <Check
          label="Subscribed ticket updates in Inbox"
          checked={update.isPending ? update.variables.inApp : preferences.data.inApp}
          disabled={update.isPending}
          onCheckedChange={(checked) => update.mutate({ ...preferences.data, inApp: checked })}
        />
      )}
      {pushAvailable && preferences.data && (
        <Check
          label="Push notifications on registered devices"
          checked={update.isPending ? (update.variables.push ?? false) : preferences.data.push}
          disabled={update.isPending}
          onCheckedChange={(checked) =>
            update.mutate({ inApp: preferences.data?.inApp ?? true, push: checked })
          }
        />
      )}
    </section>
  );
}
