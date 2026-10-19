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
const kindFields: Record<DeliveryKind, FieldSpec[]> = {
  email: [{ name: "address", label: "Email address", type: "email" }],
  ntfy: [
    {
      name: "server",
      label: "Server",
      type: "url",
      placeholder: "https://ntfy.sh",
      optional: true,
    },
    { name: "topic", label: "Topic" },
    { name: "token", label: "Access token", optional: true },
  ],
  gotify: [
    { name: "server", label: "Server", type: "url", placeholder: "https://gotify.example.com" },
    { name: "token", label: "Application token" },
  ],
  webhook: [
    { name: "url", label: "Endpoint URL", type: "url", placeholder: "https://" },
    { name: "secret", label: "Signing secret", optional: true },
  ],
  slack: [{ name: "url", label: "Incoming webhook URL", type: "url" }],
  discord: [{ name: "url", label: "Webhook URL", type: "url" }],
  mattermost: [
    { name: "url", label: "Incoming webhook URL", type: "url" },
    { name: "channel", label: "Channel", placeholder: "town-square", optional: true },
  ],
  telegram: [
    { name: "token", label: "Bot token" },
    { name: "chatId", label: "Chat ID", placeholder: "-1001234567890 or @channel" },
    { name: "topicId", label: "Topic ID", type: "number", optional: true },
  ],
};
const failures: Record<string, string> = {
  blocked_address: "This address is not allowed",
  redirect_blocked: "The endpoint redirected",
  dns_error: "Host not found",
  network_error: "Could not connect",
  timeout: "Timed out",
  invalid_endpoint: "Invalid endpoint",
  email_unavailable: "Email is not configured on this server",
  smtp_error: "Mail server unavailable",
  // Repository connections.
  access_revoked: "The administrator who connected it lost access; reconnect",
  repository_mismatch: "A delivery came from another repository",
};
const failureText = (code: string) =>
  failures[code] ??
  (code.startsWith("http_")
    ? `Rejected with HTTP ${code.slice(5)}`
    : code.startsWith("smtp_")
      ? `Mail server replied ${code.slice(5)}`
      : code.replaceAll("_", " "));
// Health refreshes while a send is queued, so a test shows its result without a reload; a failed
// send waiting for its retry refreshes slowly.
const refreshWhilePending = (query: { state: { data?: { health: Health }[] | undefined } }) => {
  const pending = query.state.data?.filter((target) => target.health.pending > 0) ?? [];
  if (!pending.length) return false;
  return pending.some((target) => target.health.status !== "failing") ? 2000 : 30_000;
};

const deliveryWords = {
  done: "Delivered",
  pending: "Sending…",
  none: "Nothing sent yet",
  failed: "",
};
function HealthText({
  health,
  words = deliveryWords,
}: {
  health: Health;
  words?: typeof deliveryWords;
}) {
  if (health.status === "failing" && health.lastAttemptAt)
    return (
      <span className="text-destructive">
        {words.failed}
        {failureText(health.error ?? "")} · <RelativeTime value={health.lastAttemptAt} />
        {health.pending > 0 && " · retrying"}
      </span>
    );
  if (health.pending) return <>{words.pending}</>;
  if (health.lastSuccessAt)
    return (
      <>
        {words.done} <RelativeTime value={health.lastSuccessAt} />
      </>
    );
  return <>{words.none}</>;
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
  check = { label: `Send test to ${name}`, icon: <Send />, queued: "Test queued" },
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
          <span className="wrap-anywhere">{name}</span>
          <Badge variant="outline">{kind}</Badge>
          {paused && <Badge variant="secondary">Paused</Badge>}
          {health.status === "failing" && <Badge variant="destructive">Failing</Badge>}
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
            label={`${paused ? "Resume" : "Pause"} ${name}`}
            onClick={() => {
              void onPause(!paused).catch(reportError);
            }}
          >
            {paused ? <Play /> : <Pause />}
          </IconButton>
          <IconButton label={`Edit ${name}`} onClick={onEdit}>
            <Pencil />
          </IconButton>
        </>
      )}
      <Confirm
        label={`Disconnect ${name}`}
        icon={<Trash2 />}
        danger
        description={removal}
        onConfirm={async () => {
          await onDelete();
          toast.success(`${name} disconnected`);
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
        label="Name"
        name="name"
        required
        maxLength={80}
        defaultValue={target?.name}
        autoFocus
      />
      {!target && (
        <Select
          label="Type"
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
      {kindFields[kind].map((field) => {
        const secret = deliverySecretFields[kind].includes(field.name),
          saved = !!target?.secrets.includes(field.name);
        return (
          <div key={`${kind}-${field.name}`}>
            <Input
              label={field.optional ? `${field.label} (optional)` : field.label}
              name={`settings.${field.name}`}
              type={secret ? "password" : (field.type ?? "text")}
              autoComplete="off"
              required={!field.optional && !saved}
              placeholder={saved ? "Saved · leave blank to keep" : field.placeholder}
              defaultValue={secret ? undefined : target?.settings[field.name]}
            />
            {saved && field.optional && (
              <Check
                label={`Remove saved ${field.label.toLowerCase()}`}
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
  for (const field of kindFields[kind]) {
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
        toast.success("Channel saved");
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
        title="Channels"
        addLabel="Add channel"
        count={channels.data?.length ?? 0}
        loading={channels.isPending}
        error={channels.error}
        onAdd={() => edit(null)}
        empty="No channels"
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
            removal={`Disconnect ${channel.name}? Its settings and queued notifications are discarded.`}
          />
        ))}
      </DeliveryList>
      <Modal
        title={draft?.channel ? "Edit channel" : "Add channel"}
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
                <FieldLegend variant="label">Send notifications from</FieldLegend>
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
                        <SelectItem value="off">Nothing</SelectItem>
                        <SelectItem value="all">All projects</SelectItem>
                        <SelectItem value="selected">Selected projects</SelectItem>
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
                submitLabel="Save channel"
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
        toast.success("Destination saved");
      })
      .catch(() => {});
  }
  if (!canAdmin)
    return (
      <EmptyState
        title="Project administrators manage integrations"
        icon={Webhook}
        className="py-16"
      />
    );
  return (
    <>
      <DeliveryList
        title="Destinations"
        addLabel="Add destination"
        count={destinations.data?.length ?? 0}
        loading={destinations.isPending}
        error={destinations.error}
        onAdd={canChange ? () => edit(null) : undefined}
        empty="No destinations"
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
            removal={`Disconnect ${destination.name}? Its settings and queued messages are discarded.`}
          />
        ))}
      </DeliveryList>
      <Modal
        title={draft?.destination ? "Edit destination" : "Add destination"}
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
                <FieldLegend variant="label">Send</FieldLegend>
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
                submitLabel="Save destination"
                onCancel={() => setDraft(null)}
              />
            </FieldSet>
          </form>
        )}
      </Modal>
    </>
  );
}

const accessWords = {
  done: "Access checked",
  pending: "Checking access…",
  none: "Access not checked",
  failed: "Access check: ",
};
// What each host's token and webhook need; the form reads its other wording from the definitions.
const repositorySetup: Record<RepositoryProvider, string> = {
  github:
    "The token needs repository read access, and issue and pull request write access to comment or sync issues. Add a GitHub webhook with the URL copied from this repository's row, content type application/json, this secret, and the Branch or tag creation, Branch or tag deletion, Issues, Issue comments, and Pull requests events.",
  gitea:
    "The token needs the read:repository scope, and write:issue to comment or sync issues. Add a Gitea webhook with the URL copied from this repository's row, content type application/json, this secret, and the Create, Delete, Issues, Issue Label, Issue Comment, and Pull Request events.",
  gitlab:
    "The token needs the read_api scope, and api to comment or sync issues. Add a GitLab webhook with the URL copied from this repository's row, this secret token, and the Push, Issues, Comments, and Merge request events.",
};
const providerName = ({ provider, baseUrl }: RepositoryConnection) => {
  const { label } = repositoryProviderDefinitions[provider];
  return baseUrl ? `${label} · ${new URL(baseUrl).host}` : label;
};
function WebhookText({ connection }: { connection: RepositoryConnection }) {
  if (connection.lastEventError)
    return <span className="text-destructive">{failureText(connection.lastEventError)}</span>;
  if (!connection.lastEventAt) return <>No webhook received</>;
  return (
    <>
      Webhook received <RelativeTime value={connection.lastEventAt} />
    </>
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
        toast.success("Repository saved");
      })
      .catch(() => {});
  }
  if (!canAdmin) return null;
  const editing = draft?.connection,
    host = draft && repositoryProviderDefinitions[draft.provider];
  return (
    <>
      <DeliveryList
        title="Repositories"
        addLabel="Connect repository"
        count={connections.data?.length ?? 0}
        loading={connections.isPending}
        error={connections.error}
        onAdd={canChange ? () => edit(null) : undefined}
        empty="No repositories"
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
                <HealthText health={connection.health} words={accessWords} />
                <SyncText connection={connection} />
              </>
            }
            check={{
              label: `Check access to ${connection.repository}`,
              icon: <ShieldCheck />,
              queued: "Access check queued",
            }}
            actions={
              <>
                <CopyButton
                  label={`Copy webhook URL for ${connection.repository}`}
                  value={connection.webhookUrl}
                />
                {canChange && (
                  <IconButton
                    label={`Issue sync for ${connection.repository}`}
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
            removal={`Disconnect ${connection.repository}? Its webhook stops working at once. Links it added stay on their tickets.`}
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
        title={editing ? "Edit repository" : "Connect repository"}
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
                  label="Host"
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
                  label={host.baseUrl.default ? "Server URL (optional)" : "Server URL"}
                  name="baseUrl"
                  type="url"
                  required={!host.baseUrl.default}
                  placeholder={host.baseUrl.default ?? "https://git.example.com"}
                  defaultValue={editing?.baseUrl ?? undefined}
                />
              )}
              <Input
                label={`${host.label} repository`}
                name="repository"
                required
                autoFocus
                placeholder={host.nested ? "group/project" : "owner/repository"}
                defaultValue={editing?.repository}
              />
              {(["token", "webhookSecret"] as const).map((field) => (
                <Input
                  key={field}
                  label={field === "token" ? "Access token" : "Webhook secret"}
                  name={field}
                  type="password"
                  autoComplete="off"
                  required={!editing?.secrets.includes(field)}
                  placeholder={
                    editing?.secrets.includes(field) ? "Saved · leave blank to keep" : undefined
                  }
                />
              ))}
              <p className="-mt-2 mb-4 text-xs text-muted-foreground">
                {repositorySetup[draft.provider]}
              </p>
              <Check
                label={`Comment on newly linked issues and ${host.change.toLowerCase()}s`}
                checked={draft.commentOnLink}
                onCheckedChange={(checked) => setDraft({ ...draft, commentOnLink: checked })}
              />
              <FieldSet className="gap-0">
                <FieldLegend variant="label">Move linked tickets</FieldLegend>
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
                    <SelectItem value="none">No move</SelectItem>
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
                submitLabel="Save repository"
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
  labels: "Its sync labels changed",
  conflict: "Changed on both sides",
  changed_while_paused: "The issue changed while the repository was paused",
  unverified: "The host's answer did not confirm the change",
  claim_conflict: "The ticket is claimed",
  invalid_content: "The issue's content does not fit a ticket",
};
const syncReason = (reason: string | null) =>
  reason ? (syncReasons[reason] ?? failureText(reason)) : null;
const stoppedStates = ["paused", "review", "unknown"] as const;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
function SyncText({ connection }: { connection: RepositoryConnection }) {
  const links = connection.issueLinks,
    syncing = (links.active ?? 0) + (links.creating ?? 0),
    stopped = stoppedStates.reduce((total, state) => total + (links[state] ?? 0), 0);
  return (
    <>
      {syncing > 0 && ` · ${plural(syncing, "issue")} syncing`}
      {stopped > 0 && (
        <span className="text-[var(--warning)]"> · {plural(stopped, "link")} stopped</span>
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
              label="Match"
              value={rule.match}
              onValueChange={(value) =>
                onChange({ ...rule, match: value === "all" ? "all" : "any" })
              }
            >
              <SelectItem value="any">Any of these labels</SelectItem>
              <SelectItem value="all">All of these labels</SelectItem>
            </Select>
          )}
        </>
      )}
    </FieldSet>
  );
}
const previewRows: [keyof Omit<SyncPreview, "fingerprint">, string][] = [
  ["matching", "Keep syncing"],
  ["export", "New issues to create"],
  ["pause", "Links to pause"],
  ["review", "Links to review"],
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
  const [rules, setRules] = useState({
    outbound: connection.outbound,
    inbound: connection.inbound,
  });
  const [previewed, setPreviewed] = useState<SyncPreview | null>(null);
  const busy = preview.isPending || apply.isPending;
  const change = (next: Partial<typeof rules>) => {
    setRules({ ...rules, ...next });
    setPreviewed(null);
    apply.reset();
  };
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!previewed) {
      void preview
        .mutateAsync({ projectId, connectionId: connection.id, ...rules })
        .then(setPreviewed)
        .catch(() => {});
      return;
    }
    void apply
      .mutateAsync({
        projectId,
        connectionId: connection.id,
        expectedVersion: connection.version,
        ...rules,
        fingerprint: previewed.fingerprint,
      })
      .then(() => {
        onClose();
        toast.success("Issue sync applied");
      })
      .catch(() => setPreviewed(null));
  }
  const catalog = labels.data ?? [];
  return (
    <Modal
      title={`Issue sync · ${connection.repository}`}
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
                legend={`Kanvil to ${host}`}
                enableLabel="Export tickets as issues"
                description="Open tickets get a new issue; title, description, state, and new comments stay in step."
                labelsLabel="Only tickets with these labels"
                emptyText="Every open ticket"
                rule={rules.outbound}
                labels={catalog}
                onChange={(outbound) => change({ outbound })}
              />
              <SyncRuleFields
                legend={`${host} to Kanvil`}
                enableLabel="Import issues as tickets"
                description={`Open issues import when ${host} next reports them.`}
                labelsLabel="Only issues with these labels"
                emptyText="Every open issue"
                rule={rules.inbound}
                labels={catalog}
                onChange={(inbound) => change({ inbound })}
              />
              {previewed && (
                <dl
                  aria-label="Preview"
                  className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t pt-3 text-sm animate-in fade-in-0"
                >
                  {previewRows.map(([key, label]) => (
                    <div key={key} className="contents">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="text-right tabular-nums">{previewed[key]}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <FormActions
                error={preview.error ?? apply.error}
                pending={busy}
                submitLabel={previewed ? "Apply" : "Preview"}
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
      <SectionHeading title={`Stopped links · ${connection.repository}`} />
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
                Review
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
        toast.success(resolution === "unlink" ? "Link removed" : "Sync resumed");
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
          state: content.open ? "Open" : "Closed",
        }
      : null;
  };
  const local = values("local"),
    remote = values("remote");
  return (
    <Modal
      title={`Review ${link.ticketKey}`}
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
                {!created &&
                  ` · ${host} may already have this issue; check before creating it again.`}
              </p>
              <Table aria-label="Comparison">
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
                      <TableHead className="align-top capitalize">{field}</TableHead>
                      {[local, remote].map((side, index) => (
                        <TableCell
                          key={index}
                          className={cn(
                            "max-w-0 align-top whitespace-pre-wrap break-words",
                            local?.[field] === remote?.[field] && "text-muted-foreground",
                          )}
                        >
                          <div className="max-h-40 overflow-auto">
                            {side ? side[field] || "—" : "Not reported"}
                          </div>
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <ModalActions>
                <Button disabled={reconcile.isPending} onClick={() => setUnlinking(true)}>
                  Unlink
                </Button>
                <Button
                  variant="outline"
                  disabled={reconcile.isPending || !remote}
                  onClick={() => void resolve("remote").catch(() => {})}
                >
                  Keep {host}
                </Button>
                <Button
                  disabled={reconcile.isPending}
                  onClick={() => void resolve("kanvil").catch(() => {})}
                >
                  {created ? "Keep Kanvil" : "Create issue again"}
                </Button>
              </ModalActions>
              <Confirm
                trigger={false}
                open={unlinking}
                onOpenChange={setUnlinking}
                label={`Unlink ${link.ticketKey}`}
                description={`Stop syncing ${link.ticketKey}? The ticket and the issue both stay.`}
                onConfirm={() => resolve("unlink")}
              />
            </>
          )}
        </>
      )}
    </Modal>
  );
}
