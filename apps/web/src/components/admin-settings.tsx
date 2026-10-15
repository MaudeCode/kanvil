import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  HardDrive,
  Search,
  Settings2,
  ShieldCheck,
  Users,
  ExternalLink,
  Network,
} from "lucide-react";
import {
  adminInstanceSchema,
  instanceUpdateSchema,
  searchAuthenticationSchema,
  type AdminInstance,
} from "@kanvil/contracts/instance";
import { okSchema } from "@kanvil/contracts";
import { z } from "zod";
import { api } from "../data.tsx";
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
} from "../ui.tsx";
import { TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { FieldSet } from "@/components/ui/field";
import { SettingsLayout } from "./settings-layout.tsx";
import { UsersSettings } from "./users-settings.tsx";
import type { adminSections } from "../search.ts";
const sections = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "storage", label: "File storage", icon: HardDrive },
  { id: "search", label: "Search", icon: Search },
  { id: "events", label: "Event delivery", icon: Network },
  { id: "users", label: "Users", icon: Users },
  { id: "authentication", label: "Authentication", icon: ShieldCheck },
];
const query = {
  queryKey: ["kanvil", "instance"],
  queryFn: () => api.request("/api/v1/admin/instance", adminInstanceSchema),
};
export function AdminSettings({
  section,
  onSectionChange,
}: {
  section: (typeof adminSections)[number];
  onSectionChange: (value: string) => void;
}) {
  const result = useQuery({
    ...query,
    refetchInterval: ["search", "storage", "events"].includes(section) ? 5000 : false,
  });
  return result.data ? (
    <InstanceSettings data={result.data} section={section} onSectionChange={onSectionChange} />
  ) : result.isPending ? (
    <Loading />
  ) : (
    <ErrorNotice error={result.error} />
  );
}
function initial(data: AdminInstance) {
  return {
    expectedVersion: data.version,
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
function InstanceSettings({
  data,
  section,
  onSectionChange,
}: {
  data: AdminInstance;
  section: string;
  onSectionChange: (value: string) => void;
}) {
  const cache = useQueryClient(),
    [draft, setDraft] = useState(() => initial(data)),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(),
    [message, setMessage] = useState("");
  const s3Locked = data.storage.source === "deployment",
    searchLocked = data.search.source === "deployment",
    brokerLocked = data.broker.source === "deployment";
  const setS3 = (patch: Partial<typeof draft.s3>) =>
    setDraft((current) => ({ ...current, s3: { ...current.s3, ...patch } }));
  const setElastic = (patch: Partial<typeof draft.elastic>) =>
    setDraft((current) => ({ ...current, elastic: { ...current.elastic, ...patch } }));
  async function action(run: () => Promise<unknown>, success: string) {
    setError(undefined);
    setMessage("");
    setPending(true);
    try {
      await run();
      setMessage(success);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  async function save() {
    const payload = instanceUpdateSchema.parse({
      expectedVersion: draft.expectedVersion,
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
  }
  return (
    <SettingsLayout
      title="Administration"
      value={section}
      onChange={onSectionChange}
      sections={sections}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action(save, "Instance settings saved");
        }}
      >
        <FieldSet disabled={pending} className="gap-0">
          <TabsContent value="general">
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
              <Input label="Public URL" value={data.deployment.url} readOnly />
              <p className="text-xs text-muted-foreground">
                The public URL is set by KANVIL_URL in your deployment.
              </p>
            </section>
          </TabsContent>
          <TabsContent value="storage">
            <section>
              <div className="mb-5 flex items-center gap-3">
                <h2 className="mb-0">File storage</h2>
                <Badge variant="secondary">
                  {s3Locked ? "Deployment managed" : "Instance managed"}
                </Badge>
              </div>
              <p>
                Attachments and profile photos use this provider. Existing files keep their original
                storage location.
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
                  File bytes are stored in the local database and included in PostgreSQL backups.
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
                  <div className="form-grid">
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
                  Storage is configured by KANVIL_STORAGE_PROVIDER and S3_* deployment variables.
                </p>
              )}
            </section>
            {data.locations.length > 0 && (
              <section>
                <h2>Existing storage locations</h2>
                {data.locations.map((location) => (
                  <div className="resource-row" key={location.id}>
                    <span className="grid gap-1">
                      <strong>{location.bucket}</strong>
                      <span className="muted">
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
                  Cleanup also runs automatically. S3 objects require a bucket backup alongside the
                  database backup.
                </p>
              </section>
            )}
          </TabsContent>
          <TabsContent value="search">
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
                      <div className="form-grid">
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
                  <div className="actions">
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
                PostgreSQL remains authoritative for permissions and filters. Search falls back to
                PostgreSQL while an external index catches up or is unavailable.
              </p>
              {data.search.error && <ErrorNotice error={new Error(data.search.error)} />}
            </section>
          </TabsContent>
          <TabsContent value="events">
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
                        setDraft({ ...draft, rabbit: { ...draft.rabbit, url: event.target.value } })
                      }
                    />
                    {data.broker.settings && (
                      <Input
                        label="Saved broker endpoint"
                        value={data.broker.settings.endpoint}
                        readOnly
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
                RabbitMQ fans out committed event wakeups to Kanvil instances and wakes background
                workers. PostgreSQL keeps the durable events and pending work, and delivers wakeups
                when the broker is unavailable.
              </p>
              {brokerLocked && (
                <p className="mt-4 text-xs">
                  Event delivery is configured by KANVIL_BROKER_PROVIDER and RABBITMQ_* deployment
                  variables.
                </p>
              )}
              {data.broker.error && <ErrorNotice error={new Error(data.broker.error)} />}
            </section>
          </TabsContent>
        </FieldSet>
        {["general", "storage", "search", "events"].includes(section) && (
          <div className="sticky bottom-0 mt-6 flex flex-wrap items-center gap-3 border-t bg-background/95 py-4 backdrop-blur">
            <Button variant="default" type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save instance settings"}
            </Button>
            {message && (
              <span role="status" className="text-sm text-muted-foreground">
                {message}
              </span>
            )}
            <ErrorNotice error={error} />
          </div>
        )}
      </form>
      <TabsContent value="users">
        <UsersSettings />
      </TabsContent>
      <TabsContent value="authentication">
        <section>
          <h2>Authentication</h2>
          <dl className="settings-facts">
            <div>
              <dt>Local email and password</dt>
              <dd>
                <Badge variant="secondary">Enabled</Badge>
              </dd>
            </div>
            <div>
              <dt>Public registration</dt>
              <dd>Closed. Administrators create accounts.</dd>
            </div>
            <div>
              <dt>Identity provider</dt>
              <dd>{data.deployment.oidc?.name ?? "Not configured"}</dd>
            </div>
          </dl>
          {data.deployment.oidc && (
            <>
              <Input
                label="OIDC discovery URL"
                value={data.deployment.oidc.discoveryUrl}
                readOnly
              />
              <Input label="OIDC client ID" value={data.deployment.oidc.clientId} readOnly />
            </>
          )}
          <p>
            Configure OIDC_DISCOVERY_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and OIDC_NAME in your
            deployment, then restart Kanvil. Provider secrets are never returned to the browser.
          </p>
          <h3>Consumer interfaces</h3>
          <Input label="HTTP API" value={`${data.deployment.url}/api/v1`} readOnly />
          <Input label="MCP endpoint" value={`${data.deployment.url}/mcp`} readOnly />
          <Input
            label="Realtime event feed"
            value={`${data.deployment.url}/api/v1/events`}
            readOnly
          />
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
      </TabsContent>
    </SettingsLayout>
  );
}
