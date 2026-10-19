import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  GitBranch,
  Pause,
  Pencil,
  Play,
  Plus,
  Send,
  ShieldCheck,
  Trash2,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Trans } from "react-i18next";
import {
  channelKinds,
  channelRouteModes,
  deliveryKindLabels,
  deliverySecretFields,
  destinationEventLabels,
  destinationEvents,
  destinationKinds,
  issueLinkStateLabels,
  repositoryProviderDefinitions,
  repositoryProviders,
  repositoryTriggerLabel,
  repositoryTriggers,
  type ChannelRoute,
  type DeliveryKind,
  type DestinationEvent,
  type IssueLink,
  type NotificationChannel,
  type ProjectDestination,
  type RepositoryConnection,
  type RepositoryProvider,
  type RepositoryTrigger,
  type SyncPreview,
  type SyncRule,
} from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { api, useAllProjects, useOperation, useWorkspace, useWorkspaces } from "../data.tsx";
import { formText, submitOnModEnter } from "../forms.ts";
import {
  Check,
  Confirm,
  CopyButton,
  EmptyState,
  ErrorNotice,
  FormActions,
  IconButton,
  Input,
  Loading,
  Modal,
  ModalActions,
  RelativeTime,
  SectionHeading,
  Select,
  SelectItem,
  reportError,
} from "../ui.tsx";
import { SettingRow } from "./settings-layout.tsx";
import { useWorkflow } from "./ticket-property.tsx";
import { ProjectLabelProvider } from "./project-label-provider.tsx";
import { TagInput } from "./tag-input.tsx";
import { TicketLink } from "./ticket-link.tsx";

type Target = NotificationChannel | ProjectDestination;
type Health = Target["health"];
type FieldSpec = {
  name: string;
  label: string;
  type?: "url" | "email" | "number";
  placeholder?: string;
  optional?: boolean;
};
// The inputs each kind needs; fields named in `deliverySecretFields` are write-only.
const kindFields = (): Record<DeliveryKind, FieldSpec[]> => ({
  email: [{ name: "address", label: t("admin.delivery.field.address"), type: "email" }],
  ntfy: [
    {
      name: "server",
      label: t("admin.delivery.field.server"),
      type: "url",
      placeholder: "https://ntfy.sh",
      optional: true,
    },
    { name: "topic", label: t("admin.delivery.field.topic") },
    { name: "token", label: t("admin.delivery.field.accessToken"), optional: true },
  ],
  gotify: [
    {
      name: "server",
      label: t("admin.delivery.field.server"),
      type: "url",
      placeholder: "https://gotify.example.com",
    },
    { name: "token", label: t("admin.delivery.field.applicationToken") },
  ],
  webhook: [
    {
      name: "url",
      label: t("admin.delivery.field.endpointUrl"),
      type: "url",
      placeholder: "https://",
    },
    { name: "secret", label: t("admin.delivery.field.signingSecret"), optional: true },
  ],
  slack: [{ name: "url", label: t("admin.delivery.field.incomingWebhookUrl"), type: "url" }],
  discord: [{ name: "url", label: t("admin.delivery.field.webhookUrl"), type: "url" }],
  mattermost: [
    { name: "url", label: t("admin.delivery.field.incomingWebhookUrl"), type: "url" },
    {
      name: "channel",
      label: t("admin.delivery.field.channel"),
      placeholder: "town-square",
      optional: true,
    },
  ],
  telegram: [
    { name: "token", label: t("admin.delivery.field.botToken") },
    {
      name: "chatId",
      label: t("admin.delivery.field.chatId"),
      placeholder: t("admin.delivery.field.chatIdPlaceholder"),
    },
    { name: "topicId", label: t("admin.delivery.field.topicId"), type: "number", optional: true },
  ],
});
const failures: Record<string, string> = {
  get blocked_address() {
    return t("admin.delivery.failure.blockedAddress");
  },
  get redirect_blocked() {
    return t("admin.delivery.failure.redirectBlocked");
  },
  get dns_error() {
    return t("admin.delivery.failure.dnsError");
  },
  get network_error() {
    return t("admin.delivery.failure.networkError");
  },
  get timeout() {
    return t("admin.delivery.failure.timeout");
  },
  get invalid_endpoint() {
    return t("admin.delivery.failure.invalidEndpoint");
  },
  get email_unavailable() {
    return t("admin.delivery.failure.emailUnavailable");
  },
  get smtp_error() {
    return t("admin.delivery.failure.smtpError");
  },
  // Repository connections.
  get access_revoked() {
    return t("admin.delivery.failure.accessRevoked");
  },
  get repository_mismatch() {
    return t("admin.delivery.failure.repositoryMismatch");
  },
};
const failureText = (code: string) =>
  failures[code] ??
  (code.startsWith("http_")
    ? t("admin.delivery.failure.http", { status: code.slice(5) })
    : code.startsWith("smtp_")
      ? t("admin.delivery.failure.smtp", { code: code.slice(5) })
      : code.replaceAll("_", " "));
// Health refreshes while a send is queued, so a test shows its result without a reload; a failed
// send waiting for its retry refreshes slowly.
const refreshWhilePending = (query: { state: { data?: { health: Health }[] | undefined } }) => {
  const pending = query.state.data?.filter((target) => target.health.pending > 0) ?? [];
  if (!pending.length) return false;
  return pending.some((target) => target.health.status !== "failing") ? 2000 : 30_000;
};

// `words` picks the wording: a send for channels and destinations, an access check for repositories.
function HealthText({
  health,
  words = "delivery",
}: {
  health: Health;
  words?: "delivery" | "access";
}) {
  if (health.status === "failing" && health.lastAttemptAt)
    return (
      <span className="text-destructive">
        {t(`admin.delivery.health.${words}.failed`, { reason: failureText(health.error ?? "") })} ·{" "}
        <RelativeTime value={health.lastAttemptAt} />
        {health.pending > 0 && ` · ${t("admin.delivery.health.retrying")}`}
      </span>
    );
  if (health.pending) return <>{t(`admin.delivery.health.${words}.pending`)}</>;
  if (health.lastSuccessAt)
    return (
      <Trans
        i18nKey={`admin.delivery.health.${words}.done`}
        components={{ time: <RelativeTime value={health.lastSuccessAt} /> }}
      />
    );
  return <>{t(`admin.delivery.health.${words}.none`)}</>;
}
// One outbound target: channel, destination, or repository connection. `check` is its test send.
// Without `canChange`, as on an archived project, only disconnecting remains.
function DeliveryRow({
  canChange = true,
  name,
  kind,
  paused,
  health,
  description,
  check = {
    label: t("admin.delivery.sendTest", { name }),
    icon: <Send />,
    queued: t("admin.delivery.testQueued"),
  },
  actions,
  onEdit,
  onTest,
  onPause,
  onDelete,
  removal,
}: {
  name: string;
  kind: string;
  paused: boolean;
  health: Health;
  description: ReactNode;
  check?: { label: string; icon: ReactNode; queued: string };
  actions?: ReactNode;
  onEdit: () => void;
  onTest: () => Promise<unknown>;
  onPause: (paused: boolean) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  removal: string;
  canChange?: boolean;
}) {
  return (
    <SettingRow
      title={
        <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
          <span className="wrap-anywhere" dir="auto">
            {name}
          </span>
          <Badge variant="outline">{kind}</Badge>
          {paused && <Badge variant="secondary">{t("admin.delivery.paused")}</Badge>}
          {health.status === "failing" && (
            <Badge variant="destructive">{t("admin.delivery.failing")}</Badge>
          )}
        </span>
      }
      description={description}
    >
      {actions}
      {canChange && (
        <>
          <IconButton
            label={check.label}
            onClick={() => {
              void onTest()
                .then(() => toast.success(check.queued))
                .catch(reportError);
            }}
          >
            {check.icon}
          </IconButton>
          <IconButton
            label={
              paused ? t("admin.delivery.resume", { name }) : t("admin.delivery.pause", { name })
            }
            onClick={() => {
              void onPause(!paused).catch(reportError);
            }}
          >
            {paused ? <Play /> : <Pause />}
          </IconButton>
          <IconButton label={t("admin.delivery.edit", { name })} onClick={onEdit}>
            <Pencil />
          </IconButton>
        </>
      )}
      <Confirm
        label={t("admin.delivery.disconnect", { name })}
        icon={<Trash2 />}
        danger
        description={removal}
        onConfirm={async () => {
          await onDelete();
          toast.success(t("admin.delivery.disconnected", { name }));
        }}
      />
    </SettingRow>
  );
}
// A channel's or destination's row fields.
const targetRow = (target: Target) => ({
  name: target.name,
  kind: deliveryKindLabels[target.kind],
  paused: target.paused,
  health: target.health,
  description: (
    <>
      <span className="wrap-anywhere">{target.endpoint}</span> ·{" "}
      <HealthText health={target.health} />
    </>
  ),
});
// Name, kind, and the kind's fields. Saved secrets show as kept unless replaced or removed.
function DeliveryFields({
  kinds,
  kind,
  onKindChange,
  target,
}: {
  kinds: readonly DeliveryKind[];
  kind: DeliveryKind;
  onKindChange: (kind: DeliveryKind) => void;
  target: Target | null;
}) {
  return (
    <>
      <Input
        label={t("admin.delivery.name")}
        name="name"
        required
        maxLength={80}
        defaultValue={target?.name}
        autoFocus
      />
      {!target && (
        <Select
          label={t("admin.delivery.type")}
          value={kind}
          onValueChange={(value) => {
            const next = kinds.find((item) => item === value);
            if (next) onKindChange(next);
          }}
        >
          {kinds.map((item) => (
            <SelectItem key={item} value={item}>
              {deliveryKindLabels[item]}
            </SelectItem>
          ))}
        </Select>
      )}
      {kindFields()[kind].map((field) => {
        const secret = deliverySecretFields[kind].includes(field.name),
          saved = !!target?.secrets.includes(field.name);
        return (
          <div key={`${kind}-${field.name}`}>
            <Input
              label={
                field.optional
                  ? t("admin.delivery.field.optional", { label: field.label })
                  : field.label
              }
              name={`settings.${field.name}`}
              type={secret ? "password" : (field.type ?? "text")}
              autoComplete="off"
              required={!field.optional && !saved}
              placeholder={saved ? t("admin.delivery.field.savedSecret") : field.placeholder}
              defaultValue={secret ? undefined : target?.settings[field.name]}
            />
            {saved && field.optional && (
              <Check
                label={t("admin.delivery.field.removeSaved", { label: field.label })}
                name={`clear.${field.name}`}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
// Submitted settings: blank secrets stay saved, blank fields clear on edit, numbers parse.
function readSettings(form: FormData, kind: DeliveryKind, editing: boolean) {
  const settings: { kind: DeliveryKind; [field: string]: string | number | null } = { kind };
  for (const field of kindFields()[kind]) {
    const value = formText(form, `settings.${field.name}`).trim();
    if (form.get(`clear.${field.name}`)) settings[field.name] = "";
    else if (value) settings[field.name] = field.type === "number" ? Number(value) : value;
    else if (editing && !deliverySecretFields[kind].includes(field.name)) settings[field.name] = "";
  }
  return settings;
}
function DeliveryList({
  title,
  addLabel,
  count,
  loading,
  error,
  onAdd,
  empty,
  icon = Webhook,
  children,
}: {
  title: string;
  addLabel: string;
  count: number;
  loading: boolean;
  error: unknown;
  onAdd?: (() => void) | undefined;
  empty: string;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section className="[&>.setting-row:last-child]:border-b-0">
      <SectionHeading
        title={title}
        action={
          onAdd && (
            <IconButton label={addLabel} variant="default" onClick={onAdd}>
              <Plus />
            </IconButton>
          )
        }
      />
      <ErrorNotice error={error} />
      {loading ? (
        <Loading />
      ) : count ? (
        children
      ) : (
        !error && <EmptyState title={empty} icon={icon} className="py-10" />
      )}
    </section>
  );
}

// Personal channels: email, ntfy, Gotify, or a signed webhook, routed per workspace.
export function NotificationChannels({ emailAvailable }: { emailAvailable: boolean }) {
  const channels = useQuery({
    ...api.query("list_notification_channels", {}),
    refetchInterval: refreshWhilePending,
  });
  const create = useOperation("create_notification_channel"),
    update = useOperation("update_notification_channel"),
    remove = useOperation("delete_notification_channel"),
    test = useOperation("test_notification_channel");
  const workspaces = useWorkspaces(),
    projects = useAllProjects(),
    active = useWorkspace().active;
  const kinds = channelKinds.filter((kind) => kind !== "email" || emailAvailable);
  const [draft, setDraft] = useState<{
    channel: NotificationChannel | null;
    kind: DeliveryKind;
    routes: ChannelRoute[];
  } | null>(null);
  const busy = create.isPending || update.isPending;
  function edit(channel: NotificationChannel | null) {
    create.reset();
    update.reset();
    setDraft({
      channel,
      kind: channel?.kind ?? kinds[0] ?? "webhook",
      routes:
        channel?.routes ??
        (active ? [{ workspaceId: active.id, mode: "all", projectIds: [] }] : []),
    });
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const form = new FormData(event.currentTarget),
      name = formText(form, "name"),
      settings = readSettings(form, draft.kind, !!draft.channel);
    const action = draft.channel
      ? update.mutateAsync({
          channelId: draft.channel.id,
          expectedVersion: draft.channel.version,
          name,
          settings,
          routes: draft.routes,
        })
      : create.mutateAsync({ name, settings, routes: draft.routes });
    void action
      .then(() => {
        setDraft(null);
        toast.success(t("admin.delivery.channelSaved"));
      })
      .catch(() => {});
  }
  const setRoute = (workspaceId: string, change: Partial<ChannelRoute>) =>
    setDraft(
      (current) =>
        current && {
          ...current,
          routes: [
            ...current.routes.filter((route) => route.workspaceId !== workspaceId),
            {
              ...(current.routes.find((route) => route.workspaceId === workspaceId) ?? {
                workspaceId,
                mode: "off",
                projectIds: [],
              }),
              ...change,
            },
          ],
        },
    );
  return (
    <>
      <DeliveryList
        title={t("admin.delivery.channels")}
        addLabel={t("admin.delivery.addChannel")}
        count={channels.data?.length ?? 0}
        loading={channels.isPending}
        error={channels.error}
        onAdd={() => edit(null)}
        empty={t("admin.delivery.noChannels")}
      >
        {channels.data?.map((channel) => (
          <DeliveryRow
            key={channel.id}
            {...targetRow(channel)}
            onEdit={() => edit(channel)}
            onTest={() => test.mutateAsync({ channelId: channel.id })}
            onPause={(paused) =>
              update.mutateAsync({
                channelId: channel.id,
                expectedVersion: channel.version,
                paused,
              })
            }
            onDelete={() =>
              remove.mutateAsync({ channelId: channel.id, expectedVersion: channel.version })
            }
            removal={t("admin.delivery.channelRemoval", { name: channel.name })}
          />
        ))}
      </DeliveryList>
      <Modal
        title={draft?.channel ? t("admin.delivery.editChannel") : t("admin.delivery.addChannel")}
        open={!!draft}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
        busy={busy}
      >
        {draft && (
          <form onSubmit={save} onKeyDown={submitOnModEnter}>
            <FieldSet disabled={busy}>
              <DeliveryFields
                kinds={kinds}
                kind={draft.kind}
                onKindChange={(kind) => setDraft({ ...draft, kind })}
                target={draft.channel}
              />
              <FieldSet className="gap-0">
                <FieldLegend variant="label">{t("admin.delivery.sendFrom")}</FieldLegend>
                {workspaces.data?.map((workspace) => {
                  const route = draft.routes.find((item) => item.workspaceId === workspace.id),
                    mode = route?.mode ?? "off",
                    choices = projects.data?.filter((item) => item.workspaceId === workspace.id);
                  return (
                    <div key={workspace.id} className="border-b py-2 last:border-b-0">
                      <Select
                        label={workspace.name}
                        layout="property"
                        className="grid-cols-[minmax(0,1fr)_12rem]"
                        value={mode}
                        onValueChange={(value) => {
                          const next = channelRouteModes.find((item) => item === value);
                          if (next) setRoute(workspace.id, { mode: next });
                        }}
                      >
                        <SelectItem value="off">{t("admin.delivery.routeOff")}</SelectItem>
                        <SelectItem value="all">{t("admin.delivery.routeAll")}</SelectItem>
                        <SelectItem value="selected">
                          {t("admin.delivery.routeSelected")}
                        </SelectItem>
                      </Select>
                      {mode === "selected" && (
                        <div className="max-h-40 overflow-y-auto pl-3">
                          {choices?.map((project) => (
                            <Check
                              key={project.id}
                              label={project.name}
                              checked={!!route?.projectIds.includes(project.id)}
                              onCheckedChange={(checked) =>
                                setRoute(workspace.id, {
                                  projectIds: checked
                                    ? [...(route?.projectIds ?? []), project.id]
                                    : (route?.projectIds ?? []).filter((id) => id !== project.id),
                                })
                              }
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </FieldSet>
              <FormActions
                error={create.error ?? update.error}
                pending={busy}
                submitLabel={t("admin.delivery.saveChannel")}
                onCancel={() => setDraft(null)}
              />
            </FieldSet>
          </form>
        )}
      </Modal>
    </>
  );
}

// A project's activity feed to chat or a signed webhook. Only project administrators see it;
// while the project is archived (`canChange` false) they can only disconnect destinations.
export function ProjectDestinations({
  projectId,
  canAdmin,
  canChange = canAdmin,
}: {
  projectId: string;
  canAdmin: boolean;
  canChange?: boolean;
}) {
  const destinations = useQuery({
    ...api.query("list_project_destinations", { projectId }),
    enabled: canAdmin,
    refetchInterval: refreshWhilePending,
  });
  const create = useOperation("create_project_destination"),
    update = useOperation("update_project_destination"),
    remove = useOperation("delete_project_destination"),
    test = useOperation("test_project_destination");
  const [draft, setDraft] = useState<{
    destination: ProjectDestination | null;
    kind: DeliveryKind;
    events: DestinationEvent[];
  } | null>(null);
  const busy = create.isPending || update.isPending;
  function edit(destination: ProjectDestination | null) {
    create.reset();
    update.reset();
    setDraft({
      destination,
      kind: destination?.kind ?? "slack",
      events: destination?.events ?? ["created", "assignment", "status", "comment"],
    });
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const form = new FormData(event.currentTarget),
      name = formText(form, "name"),
      settings = readSettings(form, draft.kind, !!draft.destination);
    const action = draft.destination
      ? update.mutateAsync({
          projectId,
          destinationId: draft.destination.id,
          expectedVersion: draft.destination.version,
          name,
          settings,
          events: draft.events,
        })
      : create.mutateAsync({ projectId, name, settings, events: draft.events });
    void action
      .then(() => {
        setDraft(null);
        toast.success(t("admin.delivery.destinationSaved"));
      })
      .catch(() => {});
  }
  if (!canAdmin)
    return <EmptyState title={t("admin.delivery.adminsOnly")} icon={Webhook} className="py-16" />;
  return (
    <>
      <DeliveryList
        title={t("admin.delivery.destinations")}
        addLabel={t("admin.delivery.addDestination")}
        count={destinations.data?.length ?? 0}
        loading={destinations.isPending}
        error={destinations.error}
        onAdd={canChange ? () => edit(null) : undefined}
        empty={t("admin.delivery.noDestinations")}
      >
        {destinations.data?.map((destination) => (
          <DeliveryRow
            key={destination.id}
            {...targetRow(destination)}
            canChange={canChange}
            onEdit={() => edit(destination)}
            onTest={() => test.mutateAsync({ projectId, destinationId: destination.id })}
            onPause={(paused) =>
              update.mutateAsync({
                projectId,
                destinationId: destination.id,
                expectedVersion: destination.version,
                paused,
              })
            }
            onDelete={() =>
              remove.mutateAsync({
                projectId,
                destinationId: destination.id,
                expectedVersion: destination.version,
              })
            }
            removal={t("admin.delivery.destinationRemoval", { name: destination.name })}
          />
        ))}
      </DeliveryList>
      <Modal
        title={
          draft?.destination
            ? t("admin.delivery.editDestination")
            : t("admin.delivery.addDestination")
        }
        open={!!draft}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
        busy={busy}
      >
        {draft && (
          <form onSubmit={save} onKeyDown={submitOnModEnter}>
            <FieldSet disabled={busy}>
              <DeliveryFields
                kinds={destinationKinds}
                kind={draft.kind}
                onKindChange={(kind) => setDraft({ ...draft, kind })}
                target={draft.destination}
              />
              <FieldSet className="gap-0">
                <FieldLegend variant="label">{t("admin.delivery.send")}</FieldLegend>
                {destinationEvents.map((name) => (
                  <Check
                    key={name}
                    label={destinationEventLabels[name]}
                    checked={draft.events.includes(name)}
                    onCheckedChange={(checked) =>
                      setDraft({
                        ...draft,
                        events: checked
                          ? [...draft.events, name]
                          : draft.events.filter((item) => item !== name),
                      })
                    }
                  />
                ))}
              </FieldSet>
              <FormActions
                error={create.error ?? update.error}
                pending={busy}
                submitLabel={t("admin.delivery.saveDestination")}
                onCancel={() => setDraft(null)}
              />
            </FieldSet>
          </form>
        )}
      </Modal>
    </>
  );
}

// What each host's token and webhook need (`admin.repository.setup`); the form reads its other
// wording from the definitions.
const providerName = ({ provider, baseUrl }: RepositoryConnection) => {
  const { label } = repositoryProviderDefinitions[provider];
  return baseUrl ? `${label} · ${new URL(baseUrl).host}` : label;
};
function WebhookText({ connection }: { connection: RepositoryConnection }) {
  if (connection.lastEventError)
    return <span className="text-destructive">{failureText(connection.lastEventError)}</span>;
  if (!connection.lastEventAt) return <>{t("admin.repository.noWebhook")}</>;
  return (
    <Trans
      i18nKey="admin.repository.webhookReceived"
      components={{ time: <RelativeTime value={connection.lastEventAt} /> }}
    />
  );
}
// A project's code-host repositories. Signed webhooks link the tickets they name and move them
// through the mapped workflow states. Only project administrators see it; while the project is
// archived (`canChange` false) they can only disconnect.
export function RepositoryConnections({
  projectId,
  workspaceId,
  canAdmin,
  canChange = canAdmin,
}: {
  projectId: string;
  workspaceId: string;
  canAdmin: boolean;
  canChange?: boolean;
}) {
  const connections = useQuery({
    ...api.query("list_repository_connections", { projectId }),
    enabled: canAdmin,
    refetchInterval: refreshWhilePending,
  });
  const workflow = useWorkflow(projectId, canAdmin);
  const create = useOperation("create_repository_connection"),
    update = useOperation("update_repository_connection"),
    remove = useOperation("delete_repository_connection"),
    verify = useOperation("verify_repository_connection");
  const [draft, setDraft] = useState<{
    connection: RepositoryConnection | null;
    provider: RepositoryProvider;
    transitions: Partial<Record<RepositoryTrigger, string>>;
    commentOnLink: boolean;
  } | null>(null);
  const [syncing, setSyncing] = useState<RepositoryConnection | null>(null);
  const busy = create.isPending || update.isPending;
  function edit(connection: RepositoryConnection | null) {
    create.reset();
    update.reset();
    setDraft({
      connection,
      provider: connection?.provider ?? "github",
      transitions: connection?.transitions ?? {},
      commentOnLink: connection?.commentOnLink ?? false,
    });
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const form = new FormData(event.currentTarget),
      repository = formText(form, "repository").trim(),
      // A cleared server URL falls back to the host's default instance.
      baseUrl =
        formText(form, "baseUrl").trim() ||
        repositoryProviderDefinitions[draft.provider].baseUrl?.default,
      token = formText(form, "token").trim(),
      webhookSecret = formText(form, "webhookSecret").trim(),
      fields = {
        transitions: draft.transitions,
        commentOnLink: draft.commentOnLink,
        ...(baseUrl && { baseUrl }),
      };
    const action = draft.connection
      ? update.mutateAsync({
          projectId,
          connectionId: draft.connection.id,
          expectedVersion: draft.connection.version,
          repository,
          ...(token && { token }),
          ...(webhookSecret && { webhookSecret }),
          ...fields,
        })
      : create.mutateAsync({
          projectId,
          provider: draft.provider,
          repository,
          token,
          webhookSecret,
          ...fields,
        });
    void action
      .then(() => {
        setDraft(null);
        toast.success(t("admin.repository.saved"));
      })
      .catch(() => {});
  }
  if (!canAdmin) return null;
  const editing = draft?.connection,
    host = draft && repositoryProviderDefinitions[draft.provider];
  return (
    <>
      <DeliveryList
        title={t("admin.repository.title")}
        addLabel={t("admin.repository.connect")}
        count={connections.data?.length ?? 0}
        loading={connections.isPending}
        error={connections.error}
        onAdd={canChange ? () => edit(null) : undefined}
        empty={t("admin.repository.empty")}
        icon={GitBranch}
      >
        {connections.data?.map((connection) => (
          <DeliveryRow
            key={connection.id}
            canChange={canChange}
            name={connection.repository}
            kind={providerName(connection)}
            paused={connection.paused}
            health={connection.health}
            description={
              <>
                <WebhookText connection={connection} /> ·{" "}
                <HealthText health={connection.health} words="access" />
                <SyncText connection={connection} />
              </>
            }
            check={{
              label: t("admin.repository.checkAccess", { repository: connection.repository }),
              icon: <ShieldCheck />,
              queued: t("admin.repository.accessQueued"),
            }}
            actions={
              <>
                <CopyButton
                  label={t("admin.repository.copyWebhook", { repository: connection.repository })}
                  value={connection.webhookUrl}
                />
                {canChange && (
                  <IconButton
                    label={t("admin.repository.issueSync", { repository: connection.repository })}
                    onClick={() => setSyncing(connection)}
                  >
                    <ArrowLeftRight />
                  </IconButton>
                )}
              </>
            }
            onEdit={() => edit(connection)}
            onTest={() => verify.mutateAsync({ projectId, connectionId: connection.id })}
            onPause={(paused) =>
              update.mutateAsync({
                projectId,
                connectionId: connection.id,
                expectedVersion: connection.version,
                paused,
              })
            }
            onDelete={() =>
              remove.mutateAsync({
                projectId,
                connectionId: connection.id,
                expectedVersion: connection.version,
              })
            }
            removal={t("admin.repository.removal", { repository: connection.repository })}
          />
        ))}
      </DeliveryList>
      {connections.data?.map((connection) => (
        <IssueLinkReview
          key={connection.id}
          projectId={projectId}
          connection={connection}
          canChange={canChange}
        />
      ))}
      {syncing && (
        <IssueSyncRules
          projectId={projectId}
          workspaceId={workspaceId}
          connection={syncing}
          onClose={() => setSyncing(null)}
        />
      )}
      <Modal
        title={editing ? t("admin.repository.edit") : t("admin.repository.connect")}
        open={!!draft}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
        busy={busy}
      >
        {draft && host && (
          <form onSubmit={save} onKeyDown={submitOnModEnter}>
            <FieldSet disabled={busy}>
              {!editing && (
                <Select
                  label={t("admin.repository.host")}
                  value={draft.provider}
                  onValueChange={(value) => {
                    const next = repositoryProviders.find((item) => item === value);
                    if (next) setDraft({ ...draft, provider: next });
                  }}
                >
                  {repositoryProviders.map((item) => (
                    <SelectItem key={item} value={item}>
                      {repositoryProviderDefinitions[item].label}
                    </SelectItem>
                  ))}
                </Select>
              )}
              {host.baseUrl && (
                <Input
                  key={`${draft.provider}-baseUrl`}
                  label={
                    host.baseUrl.default
                      ? t("admin.repository.serverUrlOptional")
                      : t("admin.repository.serverUrl")
                  }
                  name="baseUrl"
                  type="url"
                  required={!host.baseUrl.default}
                  placeholder={host.baseUrl.default ?? "https://git.example.com"}
                  defaultValue={editing?.baseUrl ?? undefined}
                />
              )}
              <Input
                label={t("admin.repository.repository", { host: host.label })}
                name="repository"
                required
                autoFocus
                placeholder={
                  host.nested
                    ? t("admin.repository.nestedPlaceholder")
                    : t("admin.repository.placeholder")
                }
                defaultValue={editing?.repository}
              />
              {(["token", "webhookSecret"] as const).map((field) => (
                <Input
                  key={field}
                  label={
                    field === "token"
                      ? t("admin.repository.accessToken")
                      : t("admin.repository.webhookSecret")
                  }
                  name={field}
                  type="password"
                  autoComplete="off"
                  required={!editing?.secrets.includes(field)}
                  placeholder={
                    editing?.secrets.includes(field) ? t("admin.repository.savedSecret") : undefined
                  }
                />
              ))}
              <p className="-mt-2 mb-4 text-xs text-muted-foreground">
                {t(`admin.repository.setup.${draft.provider}`)}
              </p>
              <Check
                label={t(`admin.repository.commentOnLink.${host.changeKind}`)}
                checked={draft.commentOnLink}
                onCheckedChange={(checked) => setDraft({ ...draft, commentOnLink: checked })}
              />
              <FieldSet className="gap-0">
                <FieldLegend variant="label">{t("admin.repository.moveTickets")}</FieldLegend>
                {repositoryTriggers.map((trigger) => (
                  <Select
                    key={trigger}
                    label={repositoryTriggerLabel(trigger, draft.provider)}
                    layout="property"
                    className="grid-cols-[minmax(0,1fr)_12rem] border-b py-1 last:border-b-0"
                    value={draft.transitions[trigger] ?? "none"}
                    onValueChange={(value) => {
                      const { [trigger]: _, ...rest } = draft.transitions;
                      setDraft({
                        ...draft,
                        transitions:
                          value && value !== "none" ? { ...rest, [trigger]: value } : rest,
                      });
                    }}
                  >
                    <SelectItem value="none">{t("admin.repository.noMove")}</SelectItem>
                    {workflow.data?.map((state) => (
                      <SelectItem key={state.id} value={state.id}>
                        {state.name}
                      </SelectItem>
                    ))}
                  </Select>
                ))}
              </FieldSet>
              <FormActions
                error={create.error ?? update.error}
                pending={busy}
                submitLabel={t("admin.repository.save")}
                onCancel={() => setDraft(null)}
              />
            </FieldSet>
          </form>
        )}
      </Modal>
    </>
  );
}

// Why a link stopped syncing; host failures read like delivery failures.
const syncReasons: Record<string, string> = {
  get labels() {
    return t("admin.issueSync.reason.labels");
  },
  get conflict() {
    return t("admin.issueSync.reason.conflict");
  },
  get changed_while_paused() {
    return t("admin.issueSync.reason.changedWhilePaused");
  },
  get unverified() {
    return t("admin.issueSync.reason.unverified");
  },
  get claim_conflict() {
    return t("admin.issueSync.reason.claimConflict");
  },
  get invalid_content() {
    return t("admin.issueSync.reason.invalidContent");
  },
};
const syncReason = (reason: string | null) =>
  reason ? (syncReasons[reason] ?? failureText(reason)) : null;
const stoppedStates = ["paused", "review", "unknown"] as const;
function SyncText({ connection }: { connection: RepositoryConnection }) {
  const links = connection.issueLinks,
    syncing = (links.active ?? 0) + (links.creating ?? 0),
    stopped = stoppedStates.reduce((total, state) => total + (links[state] ?? 0), 0);
  return (
    <>
      {syncing > 0 && ` · ${t("admin.issueSync.issuesSyncing", { count: syncing })}`}
      {stopped > 0 && (
        <span className="text-[var(--warning)]">
          {" "}
          · {t("admin.issueSync.linksStopped", { count: stopped })}
        </span>
      )}
    </>
  );
}

// One direction's rule: on or off, and the workspace labels it requires.
function SyncRuleFields({
  legend,
  enableLabel,
  description,
  labelsLabel,
  emptyText,
  rule,
  labels,
  onChange,
}: {
  legend: string;
  enableLabel: string;
  description: string;
  labelsLabel: string;
  emptyText: string;
  rule: SyncRule;
  labels: { id: string; name: string }[];
  onChange: (rule: SyncRule) => void;
}) {
  return (
    <FieldSet className="gap-0">
      <FieldLegend variant="label">{legend}</FieldLegend>
      <Check
        label={enableLabel}
        description={description}
        checked={rule.enabled}
        onCheckedChange={(enabled) => onChange({ ...rule, enabled })}
      />
      {rule.enabled && (
        <>
          <TagInput
            choicesOnly
            label={labelsLabel}
            emptyText={emptyText}
            value={rule.labels.flatMap((id) => labels.find((item) => item.id === id)?.name ?? [])}
            onChange={(names) =>
              onChange({
                ...rule,
                labels: names.flatMap(
                  (name) => labels.find((item) => item.name === name)?.id ?? [],
                ),
              })
            }
          />
          {rule.labels.length > 1 && (
            <Select
              label={t("admin.issueSync.match")}
              value={rule.match}
              onValueChange={(value) =>
                onChange({ ...rule, match: value === "all" ? "all" : "any" })
              }
            >
              <SelectItem value="any">{t("admin.issueSync.matchAny")}</SelectItem>
              <SelectItem value="all">{t("admin.issueSync.matchAll")}</SelectItem>
            </Select>
          )}
        </>
      )}
    </FieldSet>
  );
}
const previewRows: (keyof Omit<SyncPreview, "fingerprint">)[] = [
  "matching",
  "export",
  "pause",
  "review",
];
// Which tickets export as issues and which issues import as tickets. Saving previews the effect
// first; applying sends that preview's fingerprint, so a changed project is previewed again.
function IssueSyncRules({
  projectId,
  workspaceId,
  connection,
  onClose,
}: {
  projectId: string;
  workspaceId: string;
  connection: RepositoryConnection;
  onClose: () => void;
}) {
  const host = repositoryProviderDefinitions[connection.provider].label;
  const labels = useQuery(api.query("list_workspace_labels", { workspaceId }));
  const preview = useOperation("preview_repository_sync"),
    apply = useOperation("apply_repository_sync");
  const [rules, setRules] = useState<{ outbound: SyncRule; inbound: SyncRule } | null>(null);
  const catalog = labels.data ?? [];
  // Labels deleted since the rules were saved, or left behind by a workspace move, are dropped.
  const known = (rule: SyncRule) => ({
    ...rule,
    labels: rule.labels.filter((id) => catalog.some((item) => item.id === id)),
  });
  const current = rules ?? {
    outbound: known(connection.outbound),
    inbound: known(connection.inbound),
  };
  const [previewed, setPreviewed] = useState<SyncPreview | null>(null);
  const busy = preview.isPending || apply.isPending;
  const change = (next: Partial<typeof current>) => {
    setRules({ ...current, ...next });
    setPreviewed(null);
    apply.reset();
  };
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!previewed) {
      void preview
        .mutateAsync({ projectId, connectionId: connection.id, ...current })
        .then(setPreviewed)
        .catch(() => {});
      return;
    }
    void apply
      .mutateAsync({
        projectId,
        connectionId: connection.id,
        expectedVersion: connection.version,
        ...current,
        fingerprint: previewed.fingerprint,
      })
      .then(() => {
        onClose();
        toast.success(t("admin.issueSync.applied"));
      })
      .catch(() => setPreviewed(null));
  }
  return (
    <Modal
      title={t("admin.issueSync.title", { repository: connection.repository })}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      busy={busy}
    >
      {labels.isPending ? (
        <Loading />
      ) : (
        <form onSubmit={save} onKeyDown={submitOnModEnter}>
          <ProjectLabelProvider projectId={undefined} labels={catalog}>
            <FieldSet disabled={busy}>
              <SyncRuleFields
                legend={t("admin.issueSync.outbound", { host })}
                enableLabel={t("admin.issueSync.exportTickets")}
                description={t("admin.issueSync.exportDescription")}
                labelsLabel={t("admin.issueSync.ticketLabels")}
                emptyText={t("admin.issueSync.everyTicket")}
                rule={current.outbound}
                labels={catalog}
                onChange={(outbound) => change({ outbound })}
              />
              <SyncRuleFields
                legend={t("admin.issueSync.inbound", { host })}
                enableLabel={t("admin.issueSync.importIssues")}
                description={t("admin.issueSync.importDescription", { host })}
                labelsLabel={t("admin.issueSync.issueLabels")}
                emptyText={t("admin.issueSync.everyIssue")}
                rule={current.inbound}
                labels={catalog}
                onChange={(inbound) => change({ inbound })}
              />
              {previewed && (
                <dl
                  aria-label={t("admin.issueSync.previewLabel")}
                  className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t pt-3 text-sm animate-in fade-in-0"
                >
                  {previewRows.map((key) => (
                    <div key={key} className="contents">
                      <dt className="text-muted-foreground">
                        {t(`admin.issueSync.preview.${key}`)}
                      </dt>
                      <dd className="text-right tabular-nums">{previewed[key]}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <FormActions
                error={preview.error ?? apply.error}
                pending={busy}
                submitLabel={
                  previewed ? t("common.action.apply") : t("admin.issueSync.previewAction")
                }
                onCancel={onClose}
              />
            </FieldSet>
          </ProjectLabelProvider>
        </form>
      )}
    </Modal>
  );
}

// Links that stopped syncing, each opening a side-by-side comparison to resume from one side.
function IssueLinkReview({
  projectId,
  connection,
  canChange,
}: {
  projectId: string;
  connection: RepositoryConnection;
  canChange: boolean;
}) {
  const stopped = stoppedStates.some((state) => (connection.issueLinks[state] ?? 0) > 0);
  const links = useQuery({
    ...api.query("list_issue_links", { projectId, connectionId: connection.id }),
    enabled: stopped,
  });
  const [reviewing, setReviewing] = useState<IssueLink | null>(null);
  if (!stopped) return null;
  const rows = links.data?.filter((link) => link.state !== "active" && link.state !== "creating");
  const host = repositoryProviderDefinitions[connection.provider].label;
  return (
    <section className="[&>.setting-row:last-child]:border-b-0">
      <SectionHeading title={t("admin.issueSync.stopped", { repository: connection.repository })} />
      <ErrorNotice error={links.error} />
      {links.isPending ? (
        <Loading />
      ) : (
        rows?.map((link) => (
          <SettingRow
            key={link.id}
            title={
              <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
                <TicketLink
                  projectId={projectId}
                  ticketId={link.ticketId}
                  ticket={{ key: link.ticketKey, title: link.ticketTitle }}
                />
                <Badge variant={link.state === "review" ? "destructive" : "secondary"}>
                  {issueLinkStateLabels[link.state]}
                </Badge>
              </span>
            }
            description={
              <>
                {syncReason(link.reason)}
                {link.url && (
                  <>
                    {" · "}
                    <a href={link.url} target="_blank" rel="noreferrer" className="underline">
                      {host} #{link.number}
                    </a>
                  </>
                )}
              </>
            }
          >
            {canChange && (
              <Button variant="outline" size="sm" onClick={() => setReviewing(link)}>
                {t("admin.issueSync.review")}
              </Button>
            )}
          </SettingRow>
        ))
      )}
      {reviewing && (
        <IssueLinkComparison
          projectId={projectId}
          link={reviewing}
          host={host}
          onClose={() => setReviewing(null)}
        />
      )}
    </section>
  );
}
function IssueLinkComparison({
  projectId,
  link,
  host,
  onClose,
}: {
  projectId: string;
  link: IssueLink;
  host: string;
  onClose: () => void;
}) {
  const comparison = useQuery(api.query("compare_issue_link", { projectId, linkId: link.id }));
  const reconcile = useOperation("reconcile_issue_link");
  const [unlinking, setUnlinking] = useState(false);
  const resolve = (resolution: "kanvil" | "remote" | "unlink") => {
    const current = comparison.data;
    if (!current) return Promise.resolve();
    return reconcile
      .mutateAsync({
        projectId,
        linkId: link.id,
        expectedVersion: current.link.version,
        ticketVersion: current.ticketVersion,
        resolution,
      })
      .then(() => {
        onClose();
        toast.success(
          resolution === "unlink" ? t("admin.issueSync.linkRemoved") : t("admin.issueSync.resumed"),
        );
      });
  };
  const data = comparison.data,
    created = data?.link.number !== null;
  const values = (side: "local" | "remote") => {
    const content = data?.[side];
    return content
      ? {
          title: content.title,
          description: content.description,
          state: content.open ? t("admin.issueSync.open") : t("admin.issueSync.closed"),
        }
      : null;
  };
  const local = values("local"),
    remote = values("remote");
  return (
    <Modal
      title={t("admin.issueSync.reviewTitle", { key: link.ticketKey })}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      busy={reconcile.isPending}
    >
      {comparison.isPending ? (
        <Loading />
      ) : (
        <>
          <ErrorNotice error={comparison.error ?? reconcile.error} />
          {data && (
            <>
              <p className="text-sm text-muted-foreground">
                {syncReason(data.link.reason)}
                {!created && ` · ${t("admin.issueSync.mayExist", { host })}`}
              </p>
              <Table aria-label={t("admin.issueSync.comparison")}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24" />
                    <TableHead>Kanvil</TableHead>
                    <TableHead>{host}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(["title", "description", "state"] as const).map((field) => (
                    <TableRow key={field}>
                      <TableHead className="align-top capitalize">
                        {t(`admin.issueSync.field.${field}`)}
                      </TableHead>
                      {[local, remote].map((side, index) => (
                        <TableCell
                          key={index}
                          className={cn(
                            "max-w-0 align-top whitespace-pre-wrap break-words",
                            local?.[field] === remote?.[field] && "text-muted-foreground",
                          )}
                        >
                          <div className="max-h-40 overflow-auto" dir="auto">
                            {side ? side[field] || "—" : t("admin.issueSync.notReported")}
                          </div>
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <ModalActions>
                <Button disabled={reconcile.isPending} onClick={() => setUnlinking(true)}>
                  {t("admin.issueSync.unlink")}
                </Button>
                <Button
                  variant="outline"
                  disabled={reconcile.isPending || !remote}
                  onClick={() => void resolve("remote").catch(() => {})}
                >
                  {t("admin.issueSync.keepHost", { host })}
                </Button>
                <Button
                  disabled={reconcile.isPending}
                  onClick={() => void resolve("kanvil").catch(() => {})}
                >
                  {created ? t("admin.issueSync.keepKanvil") : t("admin.issueSync.createAgain")}
                </Button>
              </ModalActions>
              <Confirm
                trigger={false}
                open={unlinking}
                onOpenChange={setUnlinking}
                label={t("admin.issueSync.unlinkTicket", { key: link.ticketKey })}
                description={t("admin.issueSync.unlinkConfirm", { key: link.ticketKey })}
                onConfirm={() => resolve("unlink")}
              />
            </>
          )}
        </>
      )}
    </Modal>
  );
}
