import { toast } from "sonner";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import {
  adminInstanceSchema,
  instanceUpdateSchema,
  searchAuthenticationSchema,
  type AdminInstance,
} from "@kanvil/contracts/instance";
import { okSchema } from "@kanvil/contracts";
import { z } from "zod";
import { api, useInfo } from "../data.tsx";
import {
  Button,
  Check,
  Confirm,
  ErrorNotice,
  Input,
  Loading,
  Select,
  SelectItem,
  Textarea,
  Modal,
  CopyValue,
  SectionHeading,
  FormActions,
} from "../ui.tsx";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { FieldSet } from "@/components/ui/field";
import { InstanceOverview } from "./instance-overview.tsx";
import { SettingRow, SettingsLayout, SettingsPanel } from "./settings-layout.tsx";
import { UsersSettings } from "./users-settings.tsx";
import { WorkspacesSettings } from "./workspaces-settings.tsx";
import type { adminSections } from "../search.ts";
const query = {
  queryKey: ["kanvil", "instance"],
  queryFn: () => api.request("/api/v1/admin/instance", adminInstanceSchema),
};
export function AdminSettings({ section }: { section: (typeof adminSections)[number] }) {
  // Rendering waits for a read made after mount, so a cached copy still counts as fresh only once
  // it has been refetched; without "always", returning within the stale time stayed on Loading.
  const result = useQuery({
    ...query,
    refetchOnMount: "always",
    refetchInterval: ["search", "storage", "events"].includes(section) ? 5000 : false,
  });
  return result.data && result.isFetchedAfterMount ? (
    <InstanceSettings key={section} data={result.data} section={section} />
  ) : result.isPending || result.isFetching ? (
    <Loading />
  ) : (
    <ErrorNotice error={result.error} />
  );
}
function initial(data: AdminInstance) {
  return {
    expectedVersion: data.version,
    authentication: data.authentication,
    name: data.name,
    description: data.description,
    storageProvider: data.storage.provider,
    s3: {
      endpoint: "",
      region: "us-east-1",
      bucket: "",
      prefix: "kanvil/",
      forcePathStyle: true,
      accessKeyId: "",
      ...data.storage.settings,
      secretAccessKey: "",
    },
    brokerProvider: data.broker.provider,
    rabbit: { url: "", exchange: data.broker.settings?.exchange ?? "kanvil.events" },
    searchProvider: data.search.provider,
    elastic: {
      url: "",
      index: `kanvil-${data.id}`,
      username: "",
      ...data.search.settings,
      auth: data.search.settings?.auth ?? "none",
      apiKey: "",
      password: "",
    },
  };
}
function InstanceSettings({ data, section }: { data: AdminInstance; section: string }) {
  const cache = useQueryClient(),
    info = useInfo(),
    [draft, setDraft] = useState(() => initial(data)),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(),
    [message, setMessage] = useState(""),
    [editing, setEditing] = useState(false);
  const s3Locked = data.storage.source === "deployment",
    searchLocked = data.search.source === "deployment",
    brokerLocked = data.broker.source === "deployment";
  const locked =
    section === "storage"
      ? s3Locked
      : section === "search"
        ? searchLocked
        : section === "events"
          ? brokerLocked
          : false;
  const setS3 = (patch: Partial<typeof draft.s3>) =>
    setDraft((current) => ({ ...current, s3: { ...current.s3, ...patch } }));
  const setElastic = (patch: Partial<typeof draft.elastic>) =>
    setDraft((current) => ({ ...current, elastic: { ...current.elastic, ...patch } }));
  async function action(run: () => Promise<unknown>, success: string, complete = false) {
    setError(undefined);
    setMessage("");
    setPending(true);
    try {
      await run();
      if (complete) toast.success(success, { id: "instance-settings" });
      else setMessage(success);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  async function save() {
    const payload = instanceUpdateSchema.parse({
      expectedVersion: draft.expectedVersion,
      ...(section === "authentication" ? { authentication: draft.authentication } : {}),
      name: draft.name,
      description: draft.description,
      storage:
        draft.storageProvider === "s3" ? { provider: "s3", ...draft.s3 } : { provider: "local" },
      broker:
        draft.brokerProvider === "rabbitmq"
          ? { provider: "rabbitmq", ...draft.rabbit, url: draft.rabbit.url || undefined }
          : { provider: "postgres" },
      search:
        draft.searchProvider === "elasticsearch"
          ? { provider: "elasticsearch", ...draft.elastic }
          : { provider: "postgres" },
    });
    await api.request("/api/v1/admin/instance", okSchema, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setDraft((current) => ({
      ...current,
      expectedVersion: current.expectedVersion + 1,
      s3: { ...current.s3, secretAccessKey: "" },
      elastic: { ...current.elastic, apiKey: "", password: "" },
      rabbit: { ...current.rabbit, url: "" },
    }));
    await cache.invalidateQueries({ queryKey: ["kanvil", "instance"] });
    await cache.invalidateQueries({ queryKey: ["info"] });
    setEditing(false);
  }
  return (
    <SettingsLayout title="Administration" section={section}>
      {(["general", "storage", "search", "events"] as const).map((value) => (
        <SettingsPanel value={value} key={value}>
          <InstanceOverview
            data={data}
            section={value}
            onConfigure={() => {
              setDraft(initial(data));
              setError(undefined);
              setMessage("");
              setEditing(true);
            }}
          />
        </SettingsPanel>
      ))}
      {!editing && section !== "authentication" && <ErrorNotice error={error} />}
      <Modal
        title={
          section === "general"
            ? "Edit instance"
            : section === "storage"
              ? "Configure file storage"
              : section === "search"
                ? "Configure ticket search"
                : "Configure event delivery"
        }
        open={editing}
        onOpenChange={setEditing}
        busy={pending}
      >
        <form
          className="[&_section]:py-0 [&>[data-slot=field-set]>section:first-child]:pt-0"
          onSubmit={(event) => {
            event.preventDefault();
            if (!locked) void action(save, "Instance settings saved", true);
          }}
        >
          <FieldSet disabled={pending} className="gap-0">
            {section === "general" && (
              <>
                <section>
                  <h2>Instance</h2>
                  <Input
                    label="Instance name"
                    required
                    maxLength={100}
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                  <Textarea
                    label="Instance description"
                    maxLength={500}
                    value={draft.description}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  />
                  <CopyValue label="Public URL" value={data.deployment.url} />
                  <p className="text-xs text-muted-foreground">
                    The public URL is set by KANVIL_URL in your deployment.
                  </p>
                </section>
              </>
            )}
            {section === "storage" && (
              <>
                <section>
                  <div className="mb-5 flex items-center gap-3">
                    <h2 className="mb-0">File storage</h2>
                    <Badge variant="secondary">
                      {s3Locked ? "Deployment managed" : "Instance managed"}
                    </Badge>
                  </div>
                  <p>
                    Attachments and profile photos use this provider. Existing files keep their
                    original storage location.
                  </p>
                  <Select
                    label="Storage provider"
                    disabled={s3Locked}
                    value={draft.storageProvider}
                    onValueChange={(value) =>
                      setDraft({ ...draft, storageProvider: value === "s3" ? "s3" : "local" })
                    }
                  >
                    <SelectItem value="local">Local PostgreSQL storage</SelectItem>
                    <SelectItem value="s3">S3-compatible object storage</SelectItem>
                  </Select>
                  {draft.storageProvider === "local" ? (
                    <p>
                      File bytes are stored in the local database and included in PostgreSQL
                      backups.
                    </p>
                  ) : (
                    <FieldSet disabled={s3Locked} className="gap-0">
                      <Input
                        label="S3 endpoint"
                        type="url"
                        placeholder="https://s3.example.com"
                        value={draft.s3.endpoint}
                        onChange={(event) => setS3({ endpoint: event.target.value })}
                      />
                      <p className="-mt-2 text-xs">Leave the endpoint empty for Amazon S3.</p>
                      <div className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
                        <Input
                          label="Bucket"
                          value={draft.s3.bucket}
                          required
                          onChange={(event) => setS3({ bucket: event.target.value })}
                        />
                        <Input
                          label="Region"
                          value={draft.s3.region}
                          required
                          onChange={(event) => setS3({ region: event.target.value })}
                        />
                      </div>
                      <Input
                        label="Object key prefix"
                        value={draft.s3.prefix}
                        onChange={(event) => setS3({ prefix: event.target.value })}
                      />
                      <Input
                        label="Access key ID"
                        autoComplete="off"
                        value={draft.s3.accessKeyId}
                        onChange={(event) => setS3({ accessKeyId: event.target.value })}
                      />
                      <Input
                        label="Secret access key"
                        type="password"
                        autoComplete="new-password"
                        value={draft.s3.secretAccessKey}
                        placeholder={
                          data.storage.secretConfigured
                            ? "Saved. Leave empty to keep it."
                            : "Deployment credentials when omitted"
                        }
                        onChange={(event) => setS3({ secretAccessKey: event.target.value })}
                      />
                      <Check
                        label="Use path-style bucket URLs"
                        checked={draft.s3.forcePathStyle}
                        onCheckedChange={(value) => setS3({ forcePathStyle: value })}
                      />
                    </FieldSet>
                  )}
                  {draft.storageProvider === "s3" && (
                    <Button
                      disabled={pending}
                      onClick={() => {
                        void action(
                          () =>
                            api.request("/api/v1/admin/storage/test", okSchema, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify(draft.s3),
                            }),
                          "Storage connection verified",
                        );
                      }}
                    >
                      Test storage connection
                    </Button>
                  )}
                  <p className="mt-4 text-xs" role="status">
                    {data.storage.pending
                      ? `${data.storage.pending} files waiting for transfer. Pending files remain readable from PostgreSQL.`
                      : "All file transfers completed."}
                  </p>
                  {data.storage.error && <ErrorNotice error={new Error(data.storage.error)} />}
                  {s3Locked && (
                    <p className="mt-4 text-xs">
                      Storage is configured by KANVIL_STORAGE_PROVIDER and S3_* deployment
                      variables.
                    </p>
                  )}
                </section>
                {data.locations.length > 0 && (
                  <section>
                    <h2>Existing storage locations</h2>
                    {data.locations.map((location) => (
                      <div
                        className="flex flex-wrap items-center gap-3 border-b py-2.5 text-xs wrap-anywhere [&>:first-child]:min-w-24 [&>:first-child]:flex-1"
                        key={location.id}
                      >
                        <span className="grid gap-1">
                          <strong>{location.bucket}</strong>
                          <span className="text-muted-foreground">
                            {location.endpoint || "Amazon S3"} / {location.prefix}
                          </span>
                        </span>
                        <span>{location.objects} files</span>
                      </div>
                    ))}
                    <div className="mt-4">
                      <Confirm
                        label="Clean unused files"
                        description="Remove unreferenced files and failed uploads older than one day? Files attached to tickets or profiles are retained."
                        onConfirm={async () => {
                          await api.request(
                            "/api/v1/admin/storage/cleanup",
                            z.object({ removed: z.number() }),
                            { method: "POST" },
                          );
                          await cache.invalidateQueries({ queryKey: ["kanvil", "instance"] });
                        }}
                      />
                    </div>
                    <p className="mt-3 text-xs">
                      Cleanup also runs automatically. S3 objects require a bucket backup alongside
                      the database backup.
                    </p>
                  </section>
                )}
              </>
            )}
            {section === "search" && (
              <>
                <section>
                  <div className="mb-5 flex items-center gap-3">
                    <h2 className="mb-0">Ticket search</h2>
                    <Badge variant="secondary">
                      {data.search.status === "builtin" ? "PostgreSQL" : data.search.status}
                    </Badge>
                  </div>
                  <Select
                    label="Search provider"
                    disabled={searchLocked}
                    value={draft.searchProvider}
                    onValueChange={(value) =>
                      setDraft({
                        ...draft,
                        searchProvider: value === "elasticsearch" ? "elasticsearch" : "postgres",
                      })
                    }
                  >
                    <SelectItem value="postgres">Built-in PostgreSQL search</SelectItem>
                    <SelectItem value="elasticsearch">Elasticsearch-compatible search</SelectItem>
                  </Select>
                  {draft.searchProvider === "elasticsearch" && (
                    <>
                      <FieldSet disabled={searchLocked} className="gap-0">
                        <Input
                          label="Search endpoint"
                          type="url"
                          required
                          value={draft.elastic.url}
                          onChange={(event) => setElastic({ url: event.target.value })}
                        />
                        <Input
                          label="Kanvil index name"
                          required
                          value={draft.elastic.index}
                          onChange={(event) => setElastic({ index: event.target.value })}
                        />
                        <Select
                          label="Search authentication"
                          value={draft.elastic.auth}
                          onValueChange={(value) =>
                            setElastic({ auth: searchAuthenticationSchema.parse(value) })
                          }
                        >
                          <SelectItem value="none">No authentication</SelectItem>
                          <SelectItem value="apiKey">API key</SelectItem>
                          <SelectItem value="basic">Username and password</SelectItem>
                        </Select>
                        {draft.elastic.auth === "apiKey" && (
                          <Input
                            label="Search API key"
                            type="password"
                            autoComplete="new-password"
                            placeholder={
                              data.search.secretConfigured
                                ? "Saved. Leave empty to keep it."
                                : "Optional"
                            }
                            value={draft.elastic.apiKey}
                            onChange={(event) => setElastic({ apiKey: event.target.value })}
                          />
                        )}
                        {draft.elastic.auth === "basic" && (
                          <div className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
                            <Input
                              label="Search username"
                              autoComplete="off"
                              value={draft.elastic.username}
                              onChange={(event) => setElastic({ username: event.target.value })}
                            />
                            <Input
                              label="Search password"
                              type="password"
                              autoComplete="new-password"
                              value={draft.elastic.password}
                              onChange={(event) => setElastic({ password: event.target.value })}
                            />
                          </div>
                        )}
                      </FieldSet>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          onClick={() => {
                            void action(
                              () =>
                                api.request("/api/v1/admin/search/test", okSchema, {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify(draft.elastic),
                                }),
                              "Search connection verified",
                            );
                          }}
                        >
                          Test search connection
                        </Button>
                        {data.search.provider === "elasticsearch" && (
                          <Button
                            onClick={() => {
                              void action(
                                () =>
                                  api.request("/api/v1/admin/search/reindex", okSchema, {
                                    method: "POST",
                                  }),
                                "Search rebuild queued",
                              );
                            }}
                          >
                            Rebuild index
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                  <p className="mt-5">
                    PostgreSQL remains authoritative for permissions and filters. Search falls back
                    to PostgreSQL while an external index catches up or is unavailable.
                  </p>
                  {data.search.error && <ErrorNotice error={new Error(data.search.error)} />}
                </section>
              </>
            )}
            {section === "events" && (
              <>
                <section>
                  <div className="mb-5 flex items-center gap-3">
                    <h2 className="mb-0">Event delivery</h2>
                    <Badge variant="secondary">
                      {data.broker.status === "builtin" ? "PostgreSQL" : data.broker.status}
                    </Badge>
                  </div>
                  <Select
                    label="Event delivery provider"
                    disabled={brokerLocked}
                    value={draft.brokerProvider}
                    onValueChange={(value) =>
                      setDraft({
                        ...draft,
                        brokerProvider: value === "rabbitmq" ? "rabbitmq" : "postgres",
                      })
                    }
                  >
                    <SelectItem value="postgres">Built-in PostgreSQL notifications</SelectItem>
                    <SelectItem value="rabbitmq">RabbitMQ</SelectItem>
                  </Select>
                  {draft.brokerProvider === "rabbitmq" && (
                    <>
                      <FieldSet disabled={brokerLocked} className="gap-0">
                        <Input
                          label="RabbitMQ connection URL"
                          type="password"
                          autoComplete="new-password"
                          value={draft.rabbit.url}
                          placeholder={
                            data.broker.secretConfigured
                              ? "Saved. Leave empty to keep it."
                              : "amqps://user:password@host/vhost"
                          }
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              rabbit: { ...draft.rabbit, url: event.target.value },
                            })
                          }
                        />
                        {data.broker.settings && (
                          <CopyValue
                            label="Saved broker endpoint"
                            value={data.broker.settings.endpoint}
                          />
                        )}
                        <Input
                          label="RabbitMQ exchange"
                          required
                          value={draft.rabbit.exchange}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              rabbit: { ...draft.rabbit, exchange: event.target.value },
                            })
                          }
                        />
                      </FieldSet>
                      <Button
                        onClick={() => {
                          void action(
                            () =>
                              api.request("/api/v1/admin/broker/test", okSchema, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  ...draft.rabbit,
                                  url: draft.rabbit.url || undefined,
                                }),
                              }),
                            "RabbitMQ delivery verified",
                          );
                        }}
                      >
                        Test broker connection
                      </Button>
                    </>
                  )}
                  <p className="mt-5">
                    RabbitMQ fans out committed event wakeups to Kanvil instances and wakes
                    background workers. PostgreSQL keeps the durable events and pending work, and
                    delivers wakeups when the broker is unavailable.
                  </p>
                  {brokerLocked && (
                    <p className="mt-4 text-xs">
                      Event delivery is configured by KANVIL_BROKER_PROVIDER and RABBITMQ_*
                      deployment variables.
                    </p>
                  )}
                  {data.broker.error && <ErrorNotice error={new Error(data.broker.error)} />}
                </section>
              </>
            )}
          </FieldSet>
          {["general", "storage", "search", "events"].includes(section) && (
            <div className="sticky bottom-0 mt-6 flex flex-wrap items-center gap-3 border-t bg-background/95 py-4 backdrop-blur">
              <Button disabled={pending} onClick={() => setEditing(false)}>
                {locked ? "Done" : "Cancel"}
              </Button>
              {!locked && (
                <Button variant="default" type="submit" disabled={pending}>
                  {pending ? "Saving…" : "Save instance settings"}
                </Button>
              )}
              {message && (
                <span role="status" className="text-sm text-muted-foreground">
                  {message}
                </span>
              )}
              <ErrorNotice error={error} />
            </div>
          )}
        </form>
      </Modal>
      <SettingsPanel value="users">
        <UsersSettings />
      </SettingsPanel>
      <SettingsPanel value="workspaces">
        <WorkspacesSettings />
      </SettingsPanel>
      <SettingsPanel value="authentication">
        <section>
          <SectionHeading title="Authentication" />
          <form
            className="mb-6"
            onSubmit={(event) => {
              event.preventDefault();
              void action(save, "Authentication saved", true);
            }}
          >
            <SettingRow
              title="Email and password sign-in"
              description="Includes emailed sign-in codes and password reset."
            >
              <Switch
                aria-label="Email and password sign-in"
                checked={draft.authentication.emailPasswordEnabled}
                disabled={pending}
                onCheckedChange={(checked) =>
                  setDraft((current) => ({
                    ...current,
                    authentication: { ...current.authentication, emailPasswordEnabled: checked },
                  }))
                }
              />
            </SettingRow>
            <SettingRow
              title="Automatically create users from SSO"
              description="New SSO users have no workspace or project access until invited."
            >
              <Switch
                aria-label="Automatically create users from SSO"
                checked={draft.authentication.ssoAutoProvision}
                disabled={pending}
                onCheckedChange={(checked) =>
                  setDraft((current) => ({
                    ...current,
                    authentication: { ...current.authentication, ssoAutoProvision: checked },
                  }))
                }
              />
            </SettingRow>
            <SettingRow title="Public email registration">Closed</SettingRow>
            <SettingRow title="Identity provider">
              {data.deployment.oidc?.name ?? "Not configured"}
            </SettingRow>
            <SettingRow
              title="Linked-account providers"
              description="Sign in only accounts that linked them; they never create accounts."
            >
              {info.data?.providers
                .filter((provider) => provider.id !== "oidc")
                .map((provider) => provider.name)
                .join(", ") || "Not configured"}
            </SettingRow>
            <FormActions
              layout="inline"
              error={error}
              pending={pending}
              submitLabel="Save authentication"
              pendingLabel="Saving…"
              submitDisabled={
                draft.authentication.emailPasswordEnabled ===
                  data.authentication.emailPasswordEnabled &&
                draft.authentication.ssoAutoProvision === data.authentication.ssoAutoProvision
              }
            />
          </form>
          {data.deployment.oidc && (
            <>
              <CopyValue label="OIDC discovery URL" value={data.deployment.oidc.discoveryUrl} />
              <CopyValue label="OIDC client ID" value={data.deployment.oidc.clientId} />
            </>
          )}
          <p>
            Configure OIDC_DISCOVERY_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and OIDC_NAME, or a
            GITHUB_, GOOGLE_, or DISCORD_ CLIENT_ID and CLIENT_SECRET pair, in your deployment, then
            restart Kanvil. Provider secrets are never returned to the browser.
          </p>
          <h3>Consumer interfaces</h3>
          <CopyValue label="HTTP API" value={`${data.deployment.url}/api/v1`} />
          <CopyValue label="MCP endpoint" value={`${data.deployment.url}/mcp`} />
          <CopyValue label="Realtime event feed" value={`${data.deployment.url}/api/v1/events`} />
          <a
            className="inline-flex items-center gap-2 text-primary"
            href="/api/openapi.json"
            target="_blank"
            rel="noreferrer"
          >
            Open API specification
            <ExternalLink className="size-4" />
          </a>
        </section>
      </SettingsPanel>
    </SettingsLayout>
  );
}
