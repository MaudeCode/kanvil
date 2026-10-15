import { formText } from "./forms.ts";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  credentialsSchema,
  createdCredentialSchema,
  infoSchema,
  okSchema,
  roles,
  scopes,
  type Project,
} from "@kanvil/contracts";
import { api, auth, date, useIdentity, useOperation, useProjects } from "./data.tsx";
import { Button, Check, Confirm, ErrorNotice, Input, Select, Textarea } from "./ui.tsx";

export function ProjectSettings({ project }: { project: Project }) {
  const update = useOperation("update_project"),
    member = useOperation("set_member");
  const members = useQuery(api.query("list_members", { projectId: project.id }));
  return (
    <>
      <header className="page-header">
        <h1>{project.name} settings</h1>
      </header>
      <div className="settings">
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
            <Input label="Name" name="name" defaultValue={project.name} required maxLength={120} />
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
                onChange={(event) =>
                  member.mutate({
                    projectId: project.id,
                    email: person.email,
                    role: z.enum(roles).parse(event.target.value),
                  })
                }
              >
                {roles.map((role) => (
                  <option key={role}>{role}</option>
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
                <option key={role}>{role}</option>
              ))}
            </Select>
            <Button type="submit" disabled={member.isPending}>
              Add member
            </Button>
          </form>
        </section>
      </div>
    </>
  );
}
export function AccountSettings() {
  const identity = useIdentity();
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
      <header className="page-header">
        <h1>Settings</h1>
      </header>
      <div className="settings">
        <section>
          <h2>Account</h2>
          <p>
            {identity.name} · {identity.email}
          </p>
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
        <Credentials />
        <NotificationPreferences />
        {identity.admin && <AccountAdministration />}
      </div>
    </>
  );
}
function NotificationPreferences() {
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
          onChange={(event) => update.mutate({ inApp: event.target.checked })}
        />
      )}
    </section>
  );
}
function Credentials() {
  const cache = useQueryClient(),
    projects = useProjects();
  const credentials = useQuery({
    queryKey: ["kanvil", "credentials"],
    queryFn: () => api.request("/api/v1/credentials", credentialsSchema),
  });
  const [error, setError] = useState<unknown>(),
    [key, setKey] = useState(""),
    [pending, setPending] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setError(undefined);
    setPending(true);
    setKey("");
    try {
      const result = await api.request("/api/v1/credentials", createdCredentialSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: values.get("name"),
          projectIds: values.getAll("projects"),
          scopes: values.getAll("scopes"),
          expiresIn: Number(values.get("days")) * 86400,
        }),
      });
      setKey(result.key);
      await cache.invalidateQueries({ queryKey: ["kanvil", "credentials"] });
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <section>
      <h2>Agent credentials</h2>
      <p className="muted">Credentials inherit your project role and the selected restrictions.</p>
      <ErrorNotice error={credentials.error ?? error} />
      {credentials.data?.map((credential) => (
        <div className="resource-row" key={credential.id}>
          <span>
            {credential.name}
            <small className="muted">
              {" "}
              {credential.start}… ·{" "}
              {credential.expiresAt ? `Expires ${date(credential.expiresAt)}` : "No expiry"}
            </small>
          </span>
          <Confirm
            label="Revoke"
            description={`Revoke ${credential.name ?? "this credential"} immediately?`}
            onConfirm={async () => {
              await api.request(
                `/api/v1/credentials/${encodeURIComponent(credential.id)}`,
                okSchema,
                { method: "DELETE" },
              );
              await cache.invalidateQueries({ queryKey: ["kanvil", "credentials"] });
            }}
          />
        </div>
      ))}
      <form
        onSubmit={(event) => {
          void create(event);
        }}
      >
        <Input label="Credential name" name="name" required maxLength={100} />
        <fieldset>
          <legend>Projects</legend>
          {projects.data?.map((project) => (
            <Check key={project.id} label={project.name} name="projects" value={project.id} />
          ))}
        </fieldset>
        <fieldset>
          <legend>Permissions</legend>
          {scopes.map((scope) => (
            <Check
              key={scope}
              label={scope}
              name="scopes"
              value={scope}
              defaultChecked={scope === "read"}
            />
          ))}
        </fieldset>
        <Input
          label="Expires after (days)"
          name="days"
          type="number"
          min={1}
          max={365}
          defaultValue={90}
          required
        />
        <Button type="submit" disabled={pending}>
          Create credential
        </Button>
      </form>
      {key && (
        <div className="secret" role="status">
          <p>Copy this credential now. It will not be shown again.</p>
          <Input
            label="New credential"
            value={key}
            readOnly
            onFocus={(event) => event.target.select()}
          />
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(key).catch(setError);
            }}
          >
            Copy
          </Button>
          <Button onClick={() => setKey("")}>Dismiss</Button>
        </div>
      )}
    </section>
  );
}
function AccountAdministration() {
  const [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false),
    [created, setCreated] = useState("");
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      values = new FormData(form);
    setPending(true);
    setError(undefined);
    try {
      const result = await auth.admin.createUser({
        name: formText(values, "name"),
        email: formText(values, "email"),
        password: formText(values, "password"),
        role: values.get("role") === "admin" ? "admin" : "user",
      });
      if (result.error) throw new Error(result.error.message);
      setCreated(`Created ${result.data.user.email}`);
      form.reset();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <section>
      <h2>Create account</h2>
      <form
        onSubmit={(event) => {
          void create(event);
        }}
      >
        <Input label="Name" name="name" required maxLength={120} />
        <Input label="Email" name="email" type="email" required autoComplete="off" />
        <Input
          label="Initial password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
        <Select label="Instance role" name="role">
          <option value="user">User</option>
          <option value="admin">Administrator</option>
        </Select>
        <ErrorNotice error={error} />
        <Button type="submit" disabled={pending}>
          Create account
        </Button>
        {created && <p role="status">{created}</p>}
      </form>
    </section>
  );
}
