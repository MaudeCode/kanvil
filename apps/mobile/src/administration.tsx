import { AccountDeletion } from "./account-settings.tsx";
import { useAppNavigation } from "./navigation.ts";
import { useDeferredValue, useState } from "react";
import { Alert } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { authResult, okSchema, roleLabels, roles } from "@kanvil/contracts";
import {
  adminInstanceSchema,
  initialInstanceDraft,
  instanceDraftInput,
  type AdminInstance,
} from "@kanvil/contracts/instance";
import {
  accountsSchema,
  accountDetailsSchema,
  adminWorkspacesSchema,
  localPasswordSchema,
} from "@kanvil/contracts/users";
import { adminSections } from "@kanvil/contracts/navigation";
import { t } from "@kanvil/contracts/i18n";
import { useConnection, useIdentity, useOperation, useWorkspace } from "./data.tsx";
import {
  Body,
  Button,
  Check,
  Choice,
  ErrorNotice,
  Field,
  Loading,
  Row,
  Screen,
  Section,
  Sheet,
  Pager,
} from "./ui.tsx";
import { useSettingsSection } from "./management.tsx";
import type { ScreenProps } from "./navigation.ts";

export function Administration({ route, navigation }: ScreenProps<"Administration">) {
  const identity = useIdentity(),
    { api } = useConnection();
  const section = useSettingsSection(navigation, adminSections, route.params?.section);
  const result = useQuery({
    queryKey: ["kanvil", "instance"],
    queryFn: () => api.request("/api/v1/admin/instance", adminInstanceSchema),
    enabled: identity.admin,
    refetchOnMount: "always",
    refetchInterval: ["storage", "search", "events"].includes(section) ? 5000 : false,
  });
  if (!identity.admin) return <ErrorNotice error={new Error(t("shell.app.adminRequired"))} />;
  return (
    <Screen>
      {section === "users" ? (
        <Users />
      ) : section === "workspaces" ? (
        <Workspaces
          onOpen={(workspaceId) => navigation.navigate("WorkspaceSettings", { workspaceId })}
        />
      ) : result.data ? (
        <InstanceSettings key={section} data={result.data} section={section} />
      ) : result.isPending ? (
        <Loading />
      ) : (
        <ErrorNotice error={result.error} />
      )}
    </Screen>
  );
}

function InstanceSettings({ data, section }: { data: AdminInstance; section: string }) {
  const { api } = useConnection(),
    cache = useQueryClient();
  const [draft, setDraft] = useState(() => initialInstanceDraft(data)),
    [message, setMessage] = useState("");
  const action = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["kanvil", "instance"] });
      await cache.invalidateQueries({ queryKey: ["info"] });
    },
  });
  const locked =
    section === "storage"
      ? data.storage.source === "deployment"
      : section === "search"
        ? data.search.source === "deployment"
        : section === "events"
          ? data.broker.source === "deployment"
          : false;
  const setS3 = (patch: Partial<typeof draft.s3>) =>
    setDraft((previous) => ({ ...previous, s3: { ...previous.s3, ...patch } }));
  const setElastic = (patch: Partial<typeof draft.elastic>) =>
    setDraft((previous) => ({ ...previous, elastic: { ...previous.elastic, ...patch } }));
  async function test(path: string, body?: unknown) {
    await api.request(path, okSchema, {
      method: "POST",
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    setMessage(t("common.evidenceOutcome.passed"));
  }
  return (
    <>
      {locked && <Body muted>{t("admin.instance.deploymentManaged")}</Body>}
      {section === "general" && (
        <>
          <Field
            label={t("admin.configure.instanceName")}
            value={draft.name}
            onChangeText={(name) => setDraft((previous) => ({ ...previous, name }))}
            maxLength={100}
          />
          <Field
            label={t("admin.configure.instanceDescription")}
            value={draft.description}
            onChangeText={(description) => setDraft((previous) => ({ ...previous, description }))}
            maxLength={500}
            multiline
          />
          <Body>{data.deployment.url}</Body>
          <Body muted>{data.deployment.version}</Body>
        </>
      )}
      {section === "storage" && (
        <>
          <Choice
            label={t("admin.configure.storageProvider")}
            value={draft.storageProvider}
            disabled={locked}
            options={[
              { value: "local", label: t("admin.instance.provider.local") },
              { value: "s3", label: t("admin.instance.provider.s3") },
            ]}
            onChange={(value) =>
              setDraft((previous) => ({
                ...previous,
                storageProvider: value === "s3" ? "s3" : "local",
              }))
            }
          />
          {draft.storageProvider === "s3" && (
            <>
              <Field
                label={t("admin.configure.s3Endpoint")}
                value={draft.s3.endpoint}
                editable={!locked}
                onChangeText={(endpoint) => setS3({ endpoint })}
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Field
                label={t("admin.instance.bucket")}
                value={draft.s3.bucket}
                editable={!locked}
                onChangeText={(bucket) => setS3({ bucket })}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Field
                label={t("admin.configure.region")}
                value={draft.s3.region}
                editable={!locked}
                onChangeText={(region) => setS3({ region })}
                autoCapitalize="none"
              />
              <Field
                label={t("admin.configure.prefix")}
                value={draft.s3.prefix}
                editable={!locked}
                onChangeText={(prefix) => setS3({ prefix })}
                autoCapitalize="none"
              />
              <Field
                label={t("admin.configure.accessKeyId")}
                value={draft.s3.accessKeyId}
                editable={!locked}
                onChangeText={(accessKeyId) => setS3({ accessKeyId })}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Field
                label={t("admin.configure.secretAccessKey")}
                value={draft.s3.secretAccessKey}
                editable={!locked}
                onChangeText={(secretAccessKey) => setS3({ secretAccessKey })}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Check
                label={t("admin.configure.pathStyle")}
                checked={draft.s3.forcePathStyle}
                disabled={locked}
                onChange={(forcePathStyle) => setS3({ forcePathStyle })}
              />
              <Button
                title={t("admin.configure.testStorage")}
                disabled={action.isPending}
                onPress={() => action.mutate(() => test("/api/v1/admin/storage/test", draft.s3))}
              />
            </>
          )}
          <Body>
            {data.storage.pending
              ? t("admin.configure.filesWaiting", { count: data.storage.pending })
              : t("admin.configure.transfersComplete")}
          </Body>
          {data.locations.map((location) => (
            <Row
              key={location.id}
              title={location.bucket}
              caption={t("admin.configure.locationFiles", { count: location.objects })}
              onPress={() => {}}
            />
          ))}
          {!!data.locations.length && (
            <Button
              title={t("admin.configure.cleanUp")}
              disabled={action.isPending}
              onPress={() =>
                Alert.alert(t("admin.configure.cleanUp"), t("admin.configure.cleanUpConfirm"), [
                  { text: t("common.action.cancel"), style: "cancel" },
                  {
                    text: t("common.action.confirm"),
                    onPress: () =>
                      action.mutate(() =>
                        api.request(
                          "/api/v1/admin/storage/cleanup",
                          z.object({ removed: z.number() }),
                          { method: "POST" },
                        ),
                      ),
                  },
                ])
              }
            />
          )}
        </>
      )}
      {section === "search" && (
        <>
          <Choice
            label={t("admin.configure.searchProvider")}
            value={draft.searchProvider}
            disabled={locked}
            options={[
              { value: "postgres", label: t("admin.configure.searchBuiltIn") },
              { value: "elasticsearch", label: t("admin.instance.provider.elasticsearch") },
            ]}
            onChange={(value) =>
              setDraft((previous) => ({
                ...previous,
                searchProvider: value === "elasticsearch" ? "elasticsearch" : "postgres",
              }))
            }
          />
          {draft.searchProvider === "elasticsearch" && (
            <>
              <Field
                label={t("admin.instance.searchEndpoint")}
                value={draft.elastic.url}
                editable={!locked}
                onChangeText={(url) => setElastic({ url })}
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Field
                label={t("admin.configure.indexName")}
                value={draft.elastic.index}
                editable={!locked}
                onChangeText={(index) => setElastic({ index })}
                autoCapitalize="none"
              />
              <Choice
                label={t("admin.configure.searchAuthentication")}
                value={draft.elastic.auth}
                disabled={locked}
                options={(["none", "apiKey", "basic"] as const).map((value) => ({
                  value,
                  label:
                    value === "none"
                      ? t("admin.configure.noAuthentication")
                      : value === "apiKey"
                        ? t("admin.configure.apiKey")
                        : t("admin.configure.basic"),
                }))}
                onChange={(value) =>
                  setElastic({
                    auth: value === "apiKey" ? "apiKey" : value === "basic" ? "basic" : "none",
                  })
                }
              />
              {draft.elastic.auth === "apiKey" && (
                <Field
                  label={t("admin.configure.searchApiKey")}
                  value={draft.elastic.apiKey}
                  editable={!locked}
                  onChangeText={(apiKey) => setElastic({ apiKey })}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              )}
              {draft.elastic.auth === "basic" && (
                <>
                  <Field
                    label={t("admin.configure.searchUsername")}
                    value={draft.elastic.username}
                    editable={!locked}
                    onChangeText={(username) => setElastic({ username })}
                    autoCapitalize="none"
                  />
                  <Field
                    label={t("admin.configure.searchPassword")}
                    value={draft.elastic.password}
                    editable={!locked}
                    onChangeText={(password) => setElastic({ password })}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </>
              )}
              <Button
                title={t("admin.configure.testSearch")}
                disabled={action.isPending}
                onPress={() =>
                  action.mutate(() => test("/api/v1/admin/search/test", draft.elastic))
                }
              />
              <Button
                title={t("admin.configure.rebuild")}
                disabled={action.isPending}
                onPress={() => action.mutate(() => test("/api/v1/admin/search/reindex"))}
              />
            </>
          )}
        </>
      )}
      {section === "events" && (
        <>
          <Choice
            label={t("admin.configure.brokerProvider")}
            value={draft.brokerProvider}
            disabled={locked}
            options={[
              { value: "postgres", label: t("admin.configure.brokerBuiltIn") },
              { value: "rabbitmq", label: "RabbitMQ" },
            ]}
            onChange={(value) =>
              setDraft((previous) => ({
                ...previous,
                brokerProvider: value === "rabbitmq" ? "rabbitmq" : "postgres",
              }))
            }
          />
          {draft.brokerProvider === "rabbitmq" && (
            <>
              <Field
                label={t("admin.configure.rabbitUrl")}
                value={draft.rabbit.url}
                editable={!locked}
                onChangeText={(url) =>
                  setDraft((previous) => ({ ...previous, rabbit: { ...previous.rabbit, url } }))
                }
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Field
                label={t("admin.configure.rabbitExchange")}
                value={draft.rabbit.exchange}
                editable={!locked}
                onChangeText={(exchange) =>
                  setDraft((previous) => ({
                    ...previous,
                    rabbit: { ...previous.rabbit, exchange },
                  }))
                }
                autoCapitalize="none"
              />
              <Button
                title={t("admin.configure.testBroker")}
                disabled={action.isPending}
                onPress={() => action.mutate(() => test("/api/v1/admin/broker/test", draft.rabbit))}
              />
            </>
          )}
        </>
      )}
      {section === "authentication" && (
        <>
          <Check
            label={t("admin.authentication.emailPassword")}
            checked={draft.authentication.emailPasswordEnabled}
            onChange={(emailPasswordEnabled) =>
              setDraft((previous) => ({
                ...previous,
                authentication: { ...previous.authentication, emailPasswordEnabled },
              }))
            }
          />
          <Check
            label={t("admin.authentication.ssoProvision")}
            checked={draft.authentication.ssoAutoProvision}
            onChange={(ssoAutoProvision) =>
              setDraft((previous) => ({
                ...previous,
                authentication: { ...previous.authentication, ssoAutoProvision },
              }))
            }
          />
          <Body muted>{t("admin.authentication.registrationClosed")}</Body>
          <Body>{data.deployment.oidc?.name ?? t("admin.authentication.notConfigured")}</Body>
          {data.deployment.oidc && (
            <>
              <Body>{data.deployment.oidc.discoveryUrl}</Body>
              <Body>{data.deployment.oidc.clientId}</Body>
            </>
          )}
        </>
      )}
      <ErrorNotice error={action.error} />
      {message && <Body>{message}</Body>}
      {!locked && (
        <Button
          title={t("admin.configure.save")}
          primary
          disabled={action.isPending}
          onPress={() =>
            action.mutate(async () => {
              await api.request("/api/v1/admin/instance", okSchema, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(instanceDraftInput(draft, section === "authentication")),
              });
              setDraft((previous) => ({
                ...previous,
                expectedVersion: previous.expectedVersion + 1,
                s3: { ...previous.s3, secretAccessKey: "" },
                elastic: { ...previous.elastic, apiKey: "", password: "" },
                rabbit: { ...previous.rabbit, url: "" },
              }));
              setMessage(t("admin.configure.saved"));
            })
          }
        />
      )}
    </>
  );
}

function Workspaces({ onOpen }: { onOpen: (id: string) => void }) {
  const { api } = useConnection(),
    [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0);
  const q = useDeferredValue(query);
  const list = useQuery({
    queryKey: ["kanvil", "admin-workspaces", q, offset],
    queryFn: () =>
      api.request(
        `/api/v1/admin/workspaces?${new URLSearchParams({ q, offset: String(offset), limit: "25" })}`,
        adminWorkspacesSchema,
      ),
  });
  return (
    <>
      <Field
        label={t("settings.workspaces.search")}
        value={query}
        onChangeText={(value) => {
          setQuery(value);
          setOffset(0);
        }}
      />
      <ErrorNotice error={list.error} />
      {list.isPending ? (
        <Loading />
      ) : (
        list.data?.workspaces.map((space) => (
          <Row
            key={space.id}
            title={space.name}
            caption={space.administrators.map((person) => person.name).join(", ")}
            onPress={() => onOpen(space.id)}
          />
        ))
      )}
      <Pager
        offset={offset}
        total={list.data?.total}
        onChange={setOffset}
        noun={t("settings.workspaces.pagerNoun")}
      />
    </>
  );
}

function Users() {
  const { api } = useConnection(),
    [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [role, setRole] = useState("all"),
    [status, setStatus] = useState("all"),
    [editing, setEditing] = useState<string | null | undefined>();
  const q = useDeferredValue(query);
  const list = useQuery({
    queryKey: ["kanvil", "users", q, role, status, offset],
    queryFn: () =>
      api.request(
        `/api/v1/admin/users?${new URLSearchParams({ q, role, status, offset: String(offset), limit: "25" })}`,
        accountsSchema,
      ),
  });
  return (
    <>
      <Field
        label={t("admin.users.search")}
        value={query}
        onChangeText={(value) => {
          setQuery(value);
          setOffset(0);
        }}
      />
      <Choice
        label={t("admin.users.roleFilter")}
        value={role}
        options={[
          { value: "all", label: t("admin.users.allRoles") },
          { value: "admin", label: t("admin.users.administrators") },
          { value: "user", label: t("admin.users.users") },
        ]}
        onChange={(value) => {
          setRole(value);
          setOffset(0);
        }}
      />
      <Choice
        label={t("admin.users.statusFilter")}
        value={status}
        options={[
          { value: "all", label: t("admin.users.allAccounts") },
          { value: "active", label: t("admin.users.active") },
          { value: "disabled", label: t("admin.users.disabled") },
        ]}
        onChange={(value) => {
          setStatus(value);
          setOffset(0);
        }}
      />
      <ErrorNotice error={list.error} />
      {list.isPending ? (
        <Loading />
      ) : (
        list.data?.users.map((person) => (
          <Row
            key={person.id}
            title={person.name}
            caption={person.email}
            onPress={() => setEditing(person.id)}
          />
        ))
      )}
      <Pager
        offset={offset}
        total={list.data?.total}
        onChange={setOffset}
        noun={t("admin.users.pagerNoun")}
      />
      <Button title={t("admin.users.new")} onPress={() => setEditing(null)} />
      <Sheet
        title={editing ? t("admin.account.details") : t("admin.users.new")}
        open={editing !== undefined}
        onClose={() => setEditing(undefined)}
      >
        {editing !== undefined && (
          <UserDetails
            key={editing ?? "new"}
            userId={editing}
            onSaved={() => {
              setEditing(undefined);
              void list.refetch();
            }}
          />
        )}
      </Sheet>
    </>
  );
}

function UserDetails({ userId, onSaved }: { userId: string | null; onSaved: () => void }) {
  const navigation = useAppNavigation(),
    identity = useIdentity();
  const { api, auth } = useConnection(),
    cache = useQueryClient(),
    workspace = useWorkspace();
  const person = useQuery({
    queryKey: ["kanvil", "user", userId],
    queryFn: () =>
      api.request(`/api/v1/admin/users/${encodeURIComponent(userId ?? "")}`, accountDetailsSchema),
    enabled: !!userId,
  });
  const [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [role, setRole] = useState<"user" | "admin">("user"),
    [workspaceId, setWorkspaceId] = useState(""),
    [workspaceRole, setWorkspaceRole] = useState<(typeof roles)[number]>("writer"),
    [loaded, setLoaded] = useState(false);
  if (person.data && !loaded) {
    setName(person.data.name);
    setEmail(person.data.email);
    setRole(person.data.role === "admin" ? "admin" : "user");
    setLoaded(true);
  }
  const membership = useOperation("set_workspace_member");
  const action = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["kanvil"] }),
  });
  const save = () =>
    action.mutate(async () => {
      if (!userId) authResult(await auth.admin.createUser({ name, email, password, role }));
      else {
        authResult(await auth.admin.updateUser({ userId, data: { name, email } }));
        authResult(await auth.admin.setRole({ userId, role }));
      }
      onSaved();
    });
  if (userId && person.isPending) return <Loading />;
  return (
    <>
      <Field label={t("admin.account.name")} value={name} onChangeText={setName} maxLength={120} />
      <Field
        label={t("admin.account.email")}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <Choice
        label={t("admin.account.instanceRole")}
        value={role}
        options={[
          { value: "user", label: t("admin.account.user") },
          { value: "admin", label: t("admin.account.administrator") },
        ]}
        onChange={(value) => setRole(value === "admin" ? "admin" : "user")}
      />
      {!userId && (
        <Field
          label={t("admin.users.initialPassword")}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
      )}
      <ErrorNotice error={person.error ?? action.error ?? membership.error} />
      <Button
        title={t("common.action.save")}
        primary
        disabled={
          !name.trim() ||
          !email.includes("@") ||
          (!userId && password.length < 12) ||
          action.isPending
        }
        onPress={save}
      />
      {userId && person.data && (
        <>
          <Section title={t("admin.account.activeSessions")}>
            <Body>{t("admin.account.sessions", { count: person.data.sessionCount })}</Body>
            <Button
              title={t("admin.account.revokeSessions")}
              onPress={() =>
                Alert.alert(t("admin.account.revokeSessions"), t("admin.account.revokeConfirm"), [
                  { text: t("common.action.cancel"), style: "cancel" },
                  {
                    text: t("common.action.confirm"),
                    onPress: () =>
                      action.mutate(async () =>
                        authResult(await auth.admin.revokeUserSessions({ userId })),
                      ),
                  },
                ])
              }
            />
          </Section>
          <Button
            title={person.data.banned ? t("admin.account.enable") : t("admin.account.disable")}
            danger={!person.data.banned}
            onPress={() =>
              Alert.alert(
                person.data?.banned ? t("admin.account.enable") : t("admin.account.disable"),
                person.data?.banned
                  ? t("admin.account.enableConfirm")
                  : t("admin.account.disableConfirm"),
                [
                  { text: t("common.action.cancel"), style: "cancel" },
                  {
                    text: t("common.action.confirm"),
                    onPress: () =>
                      action.mutate(async () =>
                        authResult(
                          await (person.data?.banned
                            ? auth.admin.unbanUser({ userId })
                            : auth.admin.banUser({ userId })),
                        ),
                      ),
                  },
                ],
              )
            }
          />
          <Section title={t("admin.account.setPassword")}>
            <Field
              label={t("admin.account.newPassword")}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
            />
            <Field
              label={t("admin.account.confirmPassword")}
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry
              autoCapitalize="none"
            />
            <Button
              title={t("admin.account.setPassword")}
              disabled={password.length < 12 || password !== confirm || action.isPending}
              onPress={() =>
                action.mutate(() =>
                  api.request(
                    `/api/v1/admin/users/${encodeURIComponent(userId)}/password`,
                    okSchema,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(localPasswordSchema.parse({ password })),
                    },
                  ),
                )
              }
            />
          </Section>
          <Section title={t("admin.account.workspaces")}>
            {person.data.workspaces.map((space) => (
              <Body key={space.id}>
                {t("native.labelValue", { label: space.name, value: roleLabels[space.role] })}
              </Body>
            ))}
            <Choice
              label={t("admin.account.workspace")}
              value={workspaceId}
              options={[
                { value: "", label: t("admin.account.workspace") },
                ...workspace.workspaces.map((space) => ({ value: space.id, label: space.name })),
              ]}
              onChange={setWorkspaceId}
            />
            <Choice
              label={t("admin.account.workspaceRole")}
              value={workspaceRole}
              options={roles.map((value) => ({ value, label: roleLabels[value] }))}
              onChange={(value) => {
                const next = roles.find((item) => item === value);
                if (next) setWorkspaceRole(next);
              }}
            />
            <Button
              title={t("admin.account.addToWorkspace")}
              disabled={!workspaceId || membership.isPending}
              onPress={() => membership.mutate({ workspaceId, email, role: workspaceRole })}
            />
          </Section>
          <Section title={t("admin.account.projectAccess")}>
            {person.data.projects.map((project) => (
              <Row
                key={project.id}
                title={project.name}
                caption={roleLabels[project.role]}
                onPress={() => {
                  onSaved();
                  navigation.navigate("ProjectSettings", {
                    projectId: project.id,
                    section: "members",
                  });
                }}
              />
            ))}
          </Section>
          {person.data.id === identity.id ? (
            <Button
              title={t("settings.lifecycle.deleteAccount")}
              danger
              onPress={() => {
                onSaved();
                navigation.navigate("AccountSettings", { section: "account" });
              }}
            />
          ) : (
            <AccountDeletion user={person.data} onDeleted={onSaved} />
          )}
        </>
      )}
    </>
  );
}
