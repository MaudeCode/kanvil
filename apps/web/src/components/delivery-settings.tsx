import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
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
  repositoryProviderLabels,
  repositoryTriggerLabels,
  repositoryTriggers,
  type ChannelRoute,
  type DeliveryKind,
  type DestinationEvent,
  type NotificationChannel,
  type ProjectDestination,
  type RepositoryConnection,
  type RepositoryTrigger,
} from "@kanvil/contracts";
import { Badge } from "@/components/ui/badge";
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
  RelativeTime,
  SectionHeading,
  Select,
  SelectItem,
  reportError,
} from "../ui.tsx";
import { SettingRow } from "./settings-layout.tsx";
import { useWorkflow } from "./ticket-property.tsx";

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
  canAdmin,
  canChange = canAdmin,
}: {
  projectId: string;
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
    transitions: Partial<Record<RepositoryTrigger, string>>;
    commentOnLink: boolean;
  } | null>(null);
  const busy = create.isPending || update.isPending;
  function edit(connection: RepositoryConnection | null) {
    create.reset();
    update.reset();
    setDraft({
      connection,
      transitions: connection?.transitions ?? {},
      commentOnLink: connection?.commentOnLink ?? false,
    });
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const form = new FormData(event.currentTarget),
      repository = formText(form, "repository").trim(),
      token = formText(form, "token").trim(),
      webhookSecret = formText(form, "webhookSecret").trim(),
      fields = { transitions: draft.transitions, commentOnLink: draft.commentOnLink };
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
      : create.mutateAsync({ projectId, repository, token, webhookSecret, ...fields });
    void action
      .then(() => {
        setDraft(null);
        toast.success("Repository saved");
      })
      .catch(() => {});
  }
  if (!canAdmin) return null;
  const editing = draft?.connection;
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
            kind={repositoryProviderLabels[connection.provider]}
            paused={connection.paused}
            health={connection.health}
            description={
              <>
                <WebhookText connection={connection} /> ·{" "}
                <HealthText health={connection.health} words={accessWords} />
              </>
            }
            check={{
              label: `Check access to ${connection.repository}`,
              icon: <ShieldCheck />,
              queued: "Access check queued",
            }}
            actions={
              <CopyButton
                label={`Copy webhook URL for ${connection.repository}`}
                value={connection.webhookUrl}
              />
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
      <Modal
        title={editing ? "Edit repository" : "Connect repository"}
        open={!!draft}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
        busy={busy}
      >
        {draft && (
          <form onSubmit={save} onKeyDown={submitOnModEnter}>
            <FieldSet disabled={busy}>
              <Input
                label="GitHub repository"
                name="repository"
                required
                autoFocus
                placeholder="owner/repository"
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
                The token needs repository read access, and issue and pull request write access to
                comment. Add a GitHub webhook with the URL copied from this repository&apos;s row,
                content type application/json, this secret, and the Branch or tag creation, Branch
                or tag deletion, Issues, and Pull requests events.
              </p>
              <Check
                label="Comment on newly linked issues and pull requests"
                checked={draft.commentOnLink}
                onCheckedChange={(checked) => setDraft({ ...draft, commentOnLink: checked })}
              />
              <FieldSet className="gap-0">
                <FieldLegend variant="label">Move linked tickets</FieldLegend>
                {repositoryTriggers.map((trigger) => (
                  <Select
                    key={trigger}
                    label={repositoryTriggerLabels[trigger]}
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
