import { toast } from "sonner";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import {
  adminInstanceSchema,
  initialInstanceDraft as initial,
  instanceDraftInput,
  searchAuthenticationSchema,
  type AdminInstance,
} from "@kanvil/contracts/instance";
import { okSchema } from "@kanvil/contracts";
import { formatList, t } from "@kanvil/contracts/i18n";
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
    const payload = instanceDraftInput(draft, section === "authentication");
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
    <SettingsLayout title={t("admin.instance.title")} section={section}>
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
            ? t("admin.instance.edit")
            : section === "storage"
              ? t("admin.configure.storageTitle")
              : section === "search"
                ? t("admin.configure.searchTitle")
                : t("admin.configure.eventsTitle")
        }
        open={editing}
        onOpenChange={setEditing}
        busy={pending}
      >
        <form
          className="[&_section]:py-0 [&>[data-slot=field-set]>section:first-child]:pt-0"
          onSubmit={(event) => {
            event.preventDefault();
            if (!locked) void action(save, t("admin.configure.saved"), true);
          }}
        >
          <FieldSet disabled={pending} className="gap-0">
            {section === "general" && (
              <>
                <section>
                  <h2>{t("admin.instance.heading")}</h2>
                  <Input
                    label={t("admin.configure.instanceName")}
                    required
                    maxLength={100}
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                  <Textarea
                    label={t("admin.configure.instanceDescription")}
                    maxLength={500}
                    value={draft.description}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  />
                  <CopyValue label={t("admin.instance.publicUrl")} value={data.deployment.url} />
                  <p className="text-xs text-muted-foreground">
                    {t("admin.configure.publicUrlSource")}
                  </p>
                </section>
              </>
            )}
            {section === "storage" && (
              <>
                <section>
                  <div className="mb-5 flex items-center gap-3">
                    <h2 className="mb-0">{t("admin.instance.section.storage")}</h2>
                    <Badge variant="secondary">
                      {s3Locked
                        ? t("admin.instance.deploymentManaged")
                        : t("admin.instance.instanceManaged")}
                    </Badge>
                  </div>
                  <p>{t("admin.configure.storageIntro")}</p>
                  <Select
                    label={t("admin.configure.storageProvider")}
                    disabled={s3Locked}
                    value={draft.storageProvider}
                    onValueChange={(value) =>
                      setDraft({ ...draft, storageProvider: value === "s3" ? "s3" : "local" })
                    }
                  >
                    <SelectItem value="local">{t("admin.instance.provider.local")}</SelectItem>
                    <SelectItem value="s3">{t("admin.instance.provider.s3")}</SelectItem>
                  </Select>
                  {draft.storageProvider === "local" ? (
                    <p>{t("admin.configure.localDescription")}</p>
                  ) : (
                    <FieldSet disabled={s3Locked} className="gap-0">
                      <Input
                        label={t("admin.configure.s3Endpoint")}
                        type="url"
                        placeholder="https://s3.example.com"
                        value={draft.s3.endpoint}
                        onChange={(event) => setS3({ endpoint: event.target.value })}
                      />
                      <p className="-mt-2 text-xs">{t("admin.configure.s3EndpointHint")}</p>
                      <div className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
                        <Input
                          label={t("admin.instance.bucket")}
                          value={draft.s3.bucket}
                          required
                          onChange={(event) => setS3({ bucket: event.target.value })}
                        />
                        <Input
                          label={t("admin.configure.region")}
                          value={draft.s3.region}
                          required
                          onChange={(event) => setS3({ region: event.target.value })}
                        />
                      </div>
                      <Input
                        label={t("admin.configure.prefix")}
                        value={draft.s3.prefix}
                        onChange={(event) => setS3({ prefix: event.target.value })}
                      />
                      <Input
                        label={t("admin.configure.accessKeyId")}
                        autoComplete="off"
                        value={draft.s3.accessKeyId}
                        onChange={(event) => setS3({ accessKeyId: event.target.value })}
                      />
                      <Input
                        label={t("admin.configure.secretAccessKey")}
                        type="password"
                        autoComplete="new-password"
                        value={draft.s3.secretAccessKey}
                        placeholder={
                          data.storage.secretConfigured
                            ? t("admin.configure.savedSecret")
                            : t("admin.configure.deploymentCredentials")
                        }
                        onChange={(event) => setS3({ secretAccessKey: event.target.value })}
                      />
                      <Check
                        label={t("admin.configure.pathStyle")}
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
                          t("admin.configure.storageVerified"),
                        );
                      }}
                    >
                      {t("admin.configure.testStorage")}
                    </Button>
                  )}
                  <p className="mt-4 text-xs" role="status">
                    {data.storage.pending
                      ? t("admin.configure.filesWaiting", { count: data.storage.pending })
                      : t("admin.configure.transfersComplete")}
                  </p>
                  {data.storage.error && <ErrorNotice error={new Error(data.storage.error)} />}
                  {s3Locked && (
                    <p className="mt-4 text-xs">{t("admin.configure.storageDeployment")}</p>
                  )}
                </section>
                {data.locations.length > 0 && (
                  <section>
                    <h2>{t("admin.configure.locations")}</h2>
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
                        <span>
                          {t("admin.configure.locationFiles", { count: location.objects })}
                        </span>
                      </div>
                    ))}
                    <div className="mt-4">
                      <Confirm
                        label={t("admin.configure.cleanUp")}
                        description={t("admin.configure.cleanUpConfirm")}
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
                    <p className="mt-3 text-xs">{t("admin.configure.cleanUpNote")}</p>
                  </section>
                )}
              </>
            )}
            {section === "search" && (
              <>
                <section>
                  <div className="mb-5 flex items-center gap-3">
                    <h2 className="mb-0">{t("admin.instance.section.search")}</h2>
                    <Badge variant="secondary">
                      {data.search.status === "builtin"
                        ? "PostgreSQL"
                        : t(`admin.instance.status.${data.search.status}`)}
                    </Badge>
                  </div>
                  <Select
                    label={t("admin.configure.searchProvider")}
                    disabled={searchLocked}
                    value={draft.searchProvider}
                    onValueChange={(value) =>
                      setDraft({
                        ...draft,
                        searchProvider: value === "elasticsearch" ? "elasticsearch" : "postgres",
                      })
                    }
                  >
                    <SelectItem value="postgres">{t("admin.configure.searchBuiltIn")}</SelectItem>
                    <SelectItem value="elasticsearch">
                      {t("admin.instance.provider.elasticsearch")}
                    </SelectItem>
                  </Select>
                  {draft.searchProvider === "elasticsearch" && (
                    <>
                      <FieldSet disabled={searchLocked} className="gap-0">
                        <Input
                          label={t("admin.instance.searchEndpoint")}
                          type="url"
                          required
                          value={draft.elastic.url}
                          onChange={(event) => setElastic({ url: event.target.value })}
                        />
                        <Input
                          label={t("admin.configure.indexName")}
                          required
                          value={draft.elastic.index}
                          onChange={(event) => setElastic({ index: event.target.value })}
                        />
                        <Select
                          label={t("admin.configure.searchAuthentication")}
                          value={draft.elastic.auth}
                          onValueChange={(value) =>
                            setElastic({ auth: searchAuthenticationSchema.parse(value) })
                          }
                        >
                          <SelectItem value="none">
                            {t("admin.configure.noAuthentication")}
                          </SelectItem>
                          <SelectItem value="apiKey">{t("admin.configure.apiKey")}</SelectItem>
                          <SelectItem value="basic">{t("admin.configure.basic")}</SelectItem>
                        </Select>
                        {draft.elastic.auth === "apiKey" && (
                          <Input
                            label={t("admin.configure.searchApiKey")}
                            type="password"
                            autoComplete="new-password"
                            placeholder={
                              data.search.secretConfigured
                                ? t("admin.configure.savedSecret")
                                : t("admin.configure.optional")
                            }
                            value={draft.elastic.apiKey}
                            onChange={(event) => setElastic({ apiKey: event.target.value })}
                          />
                        )}
                        {draft.elastic.auth === "basic" && (
                          <div className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
                            <Input
                              label={t("admin.configure.searchUsername")}
                              autoComplete="off"
                              value={draft.elastic.username}
                              onChange={(event) => setElastic({ username: event.target.value })}
                            />
                            <Input
                              label={t("admin.configure.searchPassword")}
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
                              t("admin.configure.searchVerified"),
                            );
                          }}
                        >
                          {t("admin.configure.testSearch")}
                        </Button>
                        {data.search.provider === "elasticsearch" && (
                          <Button
                            onClick={() => {
                              void action(
                                () =>
                                  api.request("/api/v1/admin/search/reindex", okSchema, {
                                    method: "POST",
                                  }),
                                t("admin.configure.rebuildQueued"),
                              );
                            }}
                          >
                            {t("admin.configure.rebuild")}
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                  <p className="mt-5">{t("admin.configure.searchNote")}</p>
                  {data.search.error && <ErrorNotice error={new Error(data.search.error)} />}
                </section>
              </>
            )}
            {section === "events" && (
              <>
                <section>
                  <div className="mb-5 flex items-center gap-3">
                    <h2 className="mb-0">{t("admin.instance.section.events")}</h2>
                    <Badge variant="secondary">
                      {data.broker.status === "builtin"
                        ? "PostgreSQL"
                        : t(`admin.instance.status.${data.broker.status}`)}
                    </Badge>
                  </div>
                  <Select
                    label={t("admin.configure.brokerProvider")}
                    disabled={brokerLocked}
                    value={draft.brokerProvider}
                    onValueChange={(value) =>
                      setDraft({
                        ...draft,
                        brokerProvider: value === "rabbitmq" ? "rabbitmq" : "postgres",
                      })
                    }
                  >
                    <SelectItem value="postgres">{t("admin.configure.brokerBuiltIn")}</SelectItem>
                    <SelectItem value="rabbitmq">RabbitMQ</SelectItem>
                  </Select>
                  {draft.brokerProvider === "rabbitmq" && (
                    <>
                      <FieldSet disabled={brokerLocked} className="gap-0">
                        <Input
                          label={t("admin.configure.rabbitUrl")}
                          type="password"
                          autoComplete="new-password"
                          value={draft.rabbit.url}
                          placeholder={
                            data.broker.secretConfigured
                              ? t("admin.configure.savedSecret")
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
                            label={t("admin.configure.savedBrokerEndpoint")}
                            value={data.broker.settings.endpoint}
                          />
                        )}
                        <Input
                          label={t("admin.configure.rabbitExchange")}
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
                            t("admin.configure.brokerVerified"),
                          );
                        }}
                      >
                        {t("admin.configure.testBroker")}
                      </Button>
                    </>
                  )}
                  <p className="mt-5">{t("admin.configure.brokerNote")}</p>
                  {brokerLocked && (
                    <p className="mt-4 text-xs">{t("admin.configure.brokerDeployment")}</p>
                  )}
                  {data.broker.error && <ErrorNotice error={new Error(data.broker.error)} />}
                </section>
              </>
            )}
          </FieldSet>
          {["general", "storage", "search", "events"].includes(section) && (
            <div className="sticky bottom-0 mt-6 flex flex-wrap items-center gap-3 border-t bg-background/95 py-4 backdrop-blur">
              <Button disabled={pending} onClick={() => setEditing(false)}>
                {locked ? t("common.action.done") : t("common.action.cancel")}
              </Button>
              {!locked && (
                <Button variant="default" type="submit" disabled={pending}>
                  {pending ? t("common.state.saving") : t("admin.configure.save")}
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
          <SectionHeading title={t("admin.authentication.title")} />
          <form
            className="mb-6"
            onSubmit={(event) => {
              event.preventDefault();
              void action(save, t("admin.authentication.saved"), true);
            }}
          >
            <SettingRow
              title={t("admin.authentication.emailPassword")}
              description={t("admin.authentication.emailPasswordDescription")}
            >
              <Switch
                aria-label={t("admin.authentication.emailPassword")}
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
              title={t("admin.authentication.ssoProvision")}
              description={t("admin.authentication.ssoProvisionDescription")}
            >
              <Switch
                aria-label={t("admin.authentication.ssoProvision")}
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
            <SettingRow title={t("admin.authentication.registration")}>
              {t("admin.authentication.registrationClosed")}
            </SettingRow>
            <SettingRow title={t("admin.authentication.identityProvider")}>
              {data.deployment.oidc?.name ?? t("admin.authentication.notConfigured")}
            </SettingRow>
            <SettingRow
              title={t("admin.authentication.linkedProviders")}
              description={t("admin.authentication.linkedProvidersDescription")}
            >
              {formatList(
                info.data?.providers
                  .filter((provider) => provider.id !== "oidc")
                  .map((provider) => provider.name) ?? [],
              ) || t("admin.authentication.notConfigured")}
            </SettingRow>
            <FormActions
              layout="inline"
              error={error}
              pending={pending}
              submitLabel={t("admin.authentication.save")}
              pendingLabel={t("common.state.saving")}
              submitDisabled={
                draft.authentication.emailPasswordEnabled ===
                  data.authentication.emailPasswordEnabled &&
                draft.authentication.ssoAutoProvision === data.authentication.ssoAutoProvision
              }
            />
          </form>
          {data.deployment.oidc && (
            <>
              <CopyValue
                label={t("admin.authentication.discoveryUrl")}
                value={data.deployment.oidc.discoveryUrl}
              />
              <CopyValue
                label={t("admin.authentication.clientId")}
                value={data.deployment.oidc.clientId}
              />
            </>
          )}
          <p>{t("admin.authentication.oidcSetup")}</p>
          <h3>{t("admin.authentication.consumers")}</h3>
          <CopyValue label="HTTP API" value={`${data.deployment.url}/api/v1`} />
          <CopyValue
            label={t("admin.authentication.mcpEndpoint")}
            value={`${data.deployment.url}/mcp`}
          />
          <CopyValue
            label={t("admin.authentication.eventFeed")}
            value={`${data.deployment.url}/api/v1/events`}
          />
          <a
            className="inline-flex items-center gap-2 text-primary"
            href="/api/openapi.json"
            target="_blank"
            rel="noreferrer"
          >
            {t("admin.authentication.openApi")}
            <ExternalLink className="size-4" />
          </a>
        </section>
      </SettingsPanel>
    </SettingsLayout>
  );
}
