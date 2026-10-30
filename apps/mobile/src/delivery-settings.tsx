import { useState } from "react";
import { Alert, Share, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  channelKinds,
  channelRouteModes,
  deliveryKindLabels,
  deliverySecretFields,
  destinationKinds,
  destinationEvents,
  destinationEventLabels,
  repositoryProviders,
  repositoryProviderDefinitions,
  repositoryTriggers,
  repositoryTriggerLabel,
  issueLinkStateLabels,
  type DeliveryKind,
  type NotificationChannel,
  type ProjectDestination,
  type RepositoryConnection,
  type SyncRule,
  type SyncPreview,
} from "@kanvil/contracts";
import {
  deliveryFields,
  deliverySettingsInput,
  failureText,
} from "@kanvil/contracts/configuration";
import { formatNumber, t } from "@kanvil/contracts/i18n";
import { useAllProjects, useConnection, useOperation, useWorkspace } from "./data.tsx";
import {
  Body,
  Button,
  Check,
  Choice,
  ErrorNotice,
  Field,
  Loading,
  Row,
  Section,
  Sheet,
  TicketGlyph,
  usePalette,
} from "./ui.tsx";

export function CalendarFeeds({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { api, baseUrl } = useConnection();
  const feeds = useQuery({
    ...api.query("list_calendar_feeds", { projectId }),
    enabled: canManage,
  });
  const labels = useQuery(api.query("list_ticket_labels", { projectId }));
  const create = useOperation("create_calendar_feed"),
    revoke = useOperation("revoke_calendar_feed");
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [created, setCreated] = useState("");
  if (!canManage) return <Body muted>{t("settings.calendarFeeds.adminOnly")}</Body>;
  return (
    <Section title={t("settings.calendarFeeds.title")}>
      <ErrorNotice error={feeds.error ?? revoke.error} />
      {feeds.isPending ? (
        <Loading />
      ) : (
        feeds.data?.map((feed) => (
          <View key={feed.id} style={{ gap: 8 }}>
            <Body>{feed.name}</Body>
            <Body muted small>
              {feed.timeZone} ·{" "}
              {feed.active
                ? feed.labels.join(", ") || t("settings.calendarFeeds.everyLabel")
                : t("settings.calendarFeeds.stopped")}
            </Body>
            {feed.active && (
              <Button
                title={t("settings.calendarFeeds.revoke", { name: feed.name })}
                danger
                onPress={() =>
                  Alert.alert(
                    t("settings.calendarFeeds.revoke", { name: feed.name }),
                    t("settings.calendarFeeds.revokeDescription", { name: feed.name }),
                    [
                      { text: t("common.action.cancel"), style: "cancel" },
                      {
                        text: t("common.action.confirm"),
                        style: "destructive",
                        onPress: () => revoke.mutate({ projectId, feedId: feed.id }),
                      },
                    ],
                  )
                }
              />
            )}
          </View>
        ))
      )}
      <Button
        title={t("settings.calendarFeeds.new")}
        onPress={() => {
          setCreated("");
          setName("");
          setSelected([]);
          setOpen(true);
        }}
      />
      <Sheet
        title={created ? t("settings.calendarFeeds.created") : t("settings.calendarFeeds.new")}
        open={open}
        onClose={() => {
          if (!create.isPending) setOpen(false);
        }}
      >
        {created ? (
          <>
            <Body>{t("settings.calendarFeeds.copyNow")}</Body>
            <Body>{created}</Body>
            <Button
              title={t("native.detail.share")}
              onPress={() => {
                void Share.share({ message: created });
              }}
            />
          </>
        ) : (
          <>
            <Field
              label={t("settings.calendarFeeds.name")}
              value={name}
              onChangeText={setName}
              maxLength={80}
            />
            <Choice
              label={t("settings.calendarFeeds.onlyLabels")}
              value=""
              selected={selected}
              onToggle={(value) =>
                setSelected((previous) =>
                  previous.includes(value)
                    ? previous.filter((item) => item !== value)
                    : [...previous, value],
                )
              }
              onChange={() => {}}
              options={(labels.data ?? []).map((item) => ({ value: item.name, label: item.name }))}
            />
            <Body muted>{t("settings.calendarFeeds.explanation")}</Body>
            <ErrorNotice error={create.error} />
            <Button
              title={t("settings.calendarFeeds.create")}
              primary
              disabled={!name.trim() || create.isPending}
              onPress={() => {
                void create
                  .mutateAsync({
                    projectId,
                    name,
                    labels: selected,
                    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                  })
                  .then((feed) => setCreated(new URL(feed.path, baseUrl).href))
                  .catch(() => {});
              }}
            />
          </>
        )}
      </Sheet>
    </Section>
  );
}

function DeliveryStatus({ target }: { target: Pick<NotificationChannel, "paused" | "health"> }) {
  return (
    <Body muted small>
      {target.paused
        ? t("admin.delivery.paused")
        : target.health.status === "failing"
          ? failureText(target.health.error ?? "")
          : target.health.pending
            ? t("admin.delivery.health.delivery.pending")
            : target.health.lastSuccessAt
              ? t("common.evidenceOutcome.passed")
              : t("admin.delivery.health.delivery.none")}
    </Body>
  );
}

// Account channels and project destinations have one editor, as on the web.
export function DeliverySettings({ projectId }: { projectId?: string }) {
  const { api } = useConnection(),
    color = usePalette();
  const [acting, setActing] = useState<NotificationChannel | ProjectDestination>();
  const list = useQuery<(NotificationChannel | ProjectDestination)[]>({
    ...(projectId
      ? api.query("list_project_destinations", { projectId })
      : api.query("list_notification_channels", {})),
    refetchInterval: (query) =>
      query.state.data?.some((target) => target.health.pending) ? 2000 : false,
  });
  const [editing, setEditing] = useState<
    NotificationChannel | ProjectDestination | null | undefined
  >();
  const updateChannel = useOperation("update_notification_channel"),
    updateDestination = useOperation("update_project_destination"),
    deleteChannel = useOperation("delete_notification_channel"),
    deleteDestination = useOperation("delete_project_destination"),
    testChannel = useOperation("test_notification_channel"),
    testDestination = useOperation("test_project_destination");
  function pause(target: NotificationChannel | ProjectDestination) {
    if (projectId)
      updateDestination.mutate({
        projectId,
        destinationId: target.id,
        expectedVersion: target.version,
        paused: !target.paused,
      });
    else
      updateChannel.mutate({
        channelId: target.id,
        expectedVersion: target.version,
        paused: !target.paused,
      });
  }
  function remove(target: NotificationChannel | ProjectDestination) {
    Alert.alert(t("admin.delivery.disconnect"), target.name, [
      { text: t("common.action.cancel"), style: "cancel" },
      {
        text: t("common.action.confirm"),
        style: "destructive",
        onPress: () => {
          if (projectId)
            deleteDestination.mutate(
              {
                projectId,
                destinationId: target.id,
                expectedVersion: target.version,
              },
              { onSuccess: () => setActing(undefined) },
            );
          else
            deleteChannel.mutate(
              { channelId: target.id, expectedVersion: target.version },
              { onSuccess: () => setActing(undefined) },
            );
        },
      },
    ]);
  }
  return (
    <Section title={projectId ? t("admin.delivery.destinations") : t("admin.delivery.channels")}>
      <ErrorNotice
        error={
          list.error ??
          updateChannel.error ??
          updateDestination.error ??
          deleteChannel.error ??
          deleteDestination.error ??
          testChannel.error ??
          testDestination.error
        }
      />
      {list.isPending ? (
        <Loading />
      ) : (
        list.data?.map((target) => (
          <Row
            key={target.id}
            title={target.name}
            caption={deliveryKindLabels[target.kind]}
            metadata={<DeliveryStatus target={target} />}
            onPress={() => setEditing(target)}
            onLongPress={() => setActing(target)}
            trailing={
              <Button
                compact
                title=""
                accessibilityLabel={t("ticket.selection.more")}
                leading={<TicketGlyph name="settings-2" color={color.muted} />}
                onPress={() => setActing(target)}
              />
            }
          />
        ))
      )}
      <Button
        title={projectId ? t("admin.delivery.addDestination") : t("admin.delivery.addChannel")}
        onPress={() => setEditing(null)}
      />
      <Sheet
        title={acting?.name ?? t("ticket.selection.more")}
        open={!!acting}
        onClose={() => setActing(undefined)}
      >
        {acting && (
          <>
            <Button
              title={t("admin.delivery.sendTest", { name: acting.name })}
              disabled={testChannel.isPending || testDestination.isPending}
              onPress={() => {
                if (projectId) testDestination.mutate({ projectId, destinationId: acting.id });
                else testChannel.mutate({ channelId: acting.id });
              }}
            />
            <Button
              title={acting.paused ? t("admin.delivery.resume") : t("admin.delivery.pause")}
              onPress={() => {
                pause(acting);
                setActing(undefined);
              }}
            />
            <Button danger title={t("admin.delivery.disconnect")} onPress={() => remove(acting)} />
          </>
        )}
      </Sheet>
      <Sheet
        title={projectId ? t("admin.delivery.editDestination") : t("admin.delivery.editChannel")}
        open={editing !== undefined}
        onClose={() => setEditing(undefined)}
      >
        {editing !== undefined && (
          <DeliveryEditor
            key={editing?.id ?? "new"}
            {...(projectId ? { projectId } : {})}
            target={editing}
            onSaved={() => setEditing(undefined)}
          />
        )}
      </Sheet>
    </Section>
  );
}

function DeliveryEditor({
  projectId,
  target,
  onSaved,
}: {
  projectId?: string;
  target: NotificationChannel | ProjectDestination | null;
  onSaved: () => void;
}) {
  const workspace = useWorkspace(),
    projects = useAllProjects();
  const [kind, setKind] = useState<DeliveryKind>(target?.kind ?? "webhook"),
    [cleared, setCleared] = useState<string[]>([]),
    [name, setName] = useState(target?.name ?? ""),
    [settings, setSettings] = useState<Record<string, string>>(
      Object.fromEntries(
        Object.entries(target?.settings ?? {}).map(([key, value]) => [key, String(value)]),
      ),
    ),
    [paused, setPaused] = useState(target?.paused ?? false),
    [events, setEvents] = useState<ProjectDestination["events"]>(
      target && "events" in target ? target.events : [...destinationEvents],
    ),
    [routes, setRoutes] = useState<NotificationChannel["routes"]>(
      target && "routes" in target ? target.routes : [],
    );
  const createChannel = useOperation("create_notification_channel"),
    createDestination = useOperation("create_project_destination"),
    updateChannel = useOperation("update_notification_channel"),
    updateDestination = useOperation("update_project_destination");
  const pending =
    createChannel.isPending ||
    createDestination.isPending ||
    updateChannel.isPending ||
    updateDestination.isPending;
  const fields = deliveryFields()[kind];
  return (
    <>
      <Field label={t("admin.delivery.name")} value={name} onChangeText={setName} maxLength={80} />
      {!target && (
        <Choice
          label={t("admin.delivery.type")}
          value={kind}
          options={(projectId ? destinationKinds : channelKinds).map((value) => ({
            value,
            label: deliveryKindLabels[value],
          }))}
          onChange={(value) => {
            const next = (projectId ? destinationKinds : channelKinds).find(
              (item) => item === value,
            );
            if (next) {
              setKind(next);
              setSettings({});
            }
          }}
        />
      )}
      {fields.map((field) => (
        <View key={field.name}>
          <Field
            label={field.label}
            value={settings[field.name] ?? ""}
            onChangeText={(value) =>
              setSettings((previous) => ({ ...previous, [field.name]: value }))
            }
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={deliverySecretFields[kind].includes(field.name)}
            keyboardType={
              field.type === "number"
                ? "number-pad"
                : field.type === "email"
                  ? "email-address"
                  : field.type === "url"
                    ? "url"
                    : "default"
            }
            placeholder={
              target?.secrets.includes(field.name)
                ? t("admin.delivery.field.savedSecret")
                : field.placeholder
            }
          />
          {field.optional && target?.secrets.includes(field.name) && (
            <Check
              label={t("admin.delivery.field.removeSaved", { label: field.label })}
              checked={cleared.includes(field.name)}
              onChange={(remove) =>
                setCleared((previous) =>
                  remove
                    ? [...previous, field.name]
                    : previous.filter((fieldName) => fieldName !== field.name),
                )
              }
            />
          )}
        </View>
      ))}
      <Check label={t("admin.delivery.paused")} checked={paused} onChange={setPaused} />
      {projectId ? (
        <Choice
          label={t("admin.delivery.send")}
          value=""
          selected={events}
          options={destinationEvents.map((value) => ({
            value,
            label: destinationEventLabels[value],
          }))}
          onChange={() => {}}
          onToggle={(value) => {
            const event = destinationEvents.find((item) => item === value);
            if (event)
              setEvents((previous) =>
                previous.includes(event)
                  ? previous.filter((item) => item !== event)
                  : [...previous, event],
              );
          }}
        />
      ) : (
        workspace.workspaces.map((space) => {
          const route = routes.find((item) => item.workspaceId === space.id) ?? {
            workspaceId: space.id,
            mode: "off" as const,
            projectIds: [],
          };
          const setRoute = (next: NotificationChannel["routes"][number]) =>
            setRoutes((previous) => [
              ...previous.filter((item) => item.workspaceId !== space.id),
              next,
            ]);
          return (
            <Section key={space.id} title={space.name}>
              <Choice
                label={t("admin.delivery.sendFrom")}
                value={route.mode}
                options={channelRouteModes.map((value) => ({
                  value,
                  label:
                    value === "off"
                      ? t("admin.delivery.routeOff")
                      : value === "all"
                        ? t("admin.delivery.routeAll")
                        : t("admin.delivery.routeSelected"),
                }))}
                onChange={(value) => {
                  const mode = channelRouteModes.find((item) => item === value);
                  if (mode) setRoute({ ...route, mode });
                }}
              />
              {route.mode === "selected" && (
                <Choice
                  label={t("shell.page.projects")}
                  value=""
                  selected={route.projectIds}
                  options={(projects.data ?? [])
                    .filter((item) => item.workspaceId === space.id)
                    .map((item) => ({ value: item.id, label: item.name }))}
                  onChange={() => {}}
                  onToggle={(value) =>
                    setRoute({
                      ...route,
                      projectIds: route.projectIds.includes(value)
                        ? route.projectIds.filter((item) => item !== value)
                        : [...route.projectIds, value],
                    })
                  }
                />
              )}
            </Section>
          );
        })
      )}
      <ErrorNotice
        error={
          createChannel.error ??
          createDestination.error ??
          updateChannel.error ??
          updateDestination.error
        }
      />
      <Button
        title={t("common.action.save")}
        primary
        disabled={!name.trim() || pending}
        onPress={() => {
          const values = deliverySettingsInput(kind, settings, !!target, cleared);
          const promise = projectId
            ? target
              ? updateDestination.mutateAsync({
                  projectId,
                  destinationId: target.id,
                  expectedVersion: target.version,
                  name,
                  settings: values,
                  events,
                  paused,
                })
              : createDestination.mutateAsync({ projectId, name, settings: values, events, paused })
            : target
              ? updateChannel.mutateAsync({
                  channelId: target.id,
                  expectedVersion: target.version,
                  name,
                  settings: values,
                  routes,
                  paused,
                })
              : createChannel.mutateAsync({ name, settings: values, routes, paused });
          void promise.then(onSaved).catch(() => {});
        }}
      />
    </>
  );
}

export function IntegrationSettings({
  projectId,
  canManage,
}: {
  projectId: string;
  canManage: boolean;
}) {
  if (!canManage) return <Body muted>{t("admin.delivery.adminsOnly")}</Body>;
  return (
    <>
      <Repositories projectId={projectId} />
      <DeliverySettings projectId={projectId} />
    </>
  );
}

function Repositories({ projectId }: { projectId: string }) {
  const { api } = useConnection(),
    repositories = useQuery({
      ...api.query("list_repository_connections", { projectId }),
      refetchInterval: (query) =>
        query.state.data?.some((item) => item.health.pending) ? 2000 : false,
    });
  const check = useOperation("verify_repository_connection"),
    update = useOperation("update_repository_connection"),
    remove = useOperation("delete_repository_connection");
  const [editing, setEditing] = useState<RepositoryConnection | null | undefined>(),
    [syncing, setSyncing] = useState<RepositoryConnection>();
  return (
    <Section title={t("admin.repository.title")}>
      <ErrorNotice error={repositories.error ?? check.error ?? update.error ?? remove.error} />
      {repositories.data?.map((item) => (
        <View key={item.id} style={{ gap: 8 }}>
          <Row
            title={item.repository}
            caption={repositoryProviderDefinitions[item.provider].label}
            onPress={() => setEditing(item)}
          />
          <DeliveryStatus target={item} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button
              compact
              title={t("admin.repository.checkAccess")}
              onPress={() => check.mutate({ projectId, connectionId: item.id })}
            />
            <Button
              compact
              title={t("admin.repository.copyWebhook")}
              onPress={() => {
                void Share.share({ message: item.webhookUrl });
              }}
            />
            <Button
              compact
              title={t("admin.repository.issueSync")}
              onPress={() => setSyncing(item)}
            />
            <Button
              compact
              title={item.paused ? t("admin.delivery.resume") : t("admin.delivery.pause")}
              onPress={() =>
                update.mutate({
                  projectId,
                  connectionId: item.id,
                  expectedVersion: item.version,
                  paused: !item.paused,
                })
              }
            />
            <Button
              compact
              title={t("admin.delivery.disconnect")}
              danger
              onPress={() =>
                Alert.alert(t("admin.delivery.disconnect"), item.repository, [
                  { text: t("common.action.cancel"), style: "cancel" },
                  {
                    text: t("common.action.confirm"),
                    style: "destructive",
                    onPress: () =>
                      remove.mutate({
                        projectId,
                        connectionId: item.id,
                        expectedVersion: item.version,
                      }),
                  },
                ])
              }
            />
          </View>
        </View>
      ))}
      <Button title={t("admin.repository.connect")} onPress={() => setEditing(null)} />
      <Sheet
        title={t("admin.repository.connect")}
        open={editing !== undefined}
        onClose={() => setEditing(undefined)}
      >
        {editing !== undefined && (
          <RepositoryEditor
            key={editing?.id ?? "new"}
            projectId={projectId}
            connection={editing}
            onSaved={() => setEditing(undefined)}
          />
        )}
      </Sheet>
      <Sheet
        title={t("admin.repository.issueSync")}
        open={!!syncing}
        onClose={() => setSyncing(undefined)}
      >
        {syncing && <IssueSync projectId={projectId} connection={syncing} />}
      </Sheet>
    </Section>
  );
}

function RepositoryEditor({
  projectId,
  connection,
  onSaved,
}: {
  projectId: string;
  connection: RepositoryConnection | null;
  onSaved: () => void;
}) {
  const { api } = useConnection(),
    workflow = useQuery(api.query("list_workflow_states", { projectId }));
  const [provider, setProvider] = useState(connection?.provider ?? "github"),
    [repository, setRepository] = useState(connection?.repository ?? ""),
    [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? ""),
    [token, setToken] = useState(""),
    [secret, setSecret] = useState(""),
    [comment, setComment] = useState(connection?.commentOnLink ?? false),
    [transitions, setTransitions] = useState(connection?.transitions ?? {});
  const create = useOperation("create_repository_connection"),
    update = useOperation("update_repository_connection");
  return (
    <>
      {!connection && (
        <Choice
          label={t("admin.repository.host")}
          value={provider}
          options={repositoryProviders.map((value) => ({
            value,
            label: repositoryProviderDefinitions[value].label,
          }))}
          onChange={(value) => {
            const next = repositoryProviders.find((item) => item === value);
            if (next) setProvider(next);
          }}
        />
      )}
      <Field
        label={t("admin.repository.repository")}
        value={repository}
        onChangeText={setRepository}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {provider !== "github" && (
        <Field
          label={t("admin.repository.serverUrl")}
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      )}
      <Field
        label={t("admin.repository.accessToken")}
        value={token}
        onChangeText={setToken}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Field
        label={t("admin.repository.webhookSecret")}
        value={secret}
        onChangeText={setSecret}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      {connection && (
        <Body muted small>
          {t("admin.repository.savedSecret")}
        </Body>
      )}
      <Check
        label={t(
          `admin.repository.commentOnLink.${repositoryProviderDefinitions[provider].changeKind}`,
        )}
        checked={comment}
        onChange={setComment}
      />
      {repositoryTriggers.map((trigger) => (
        <Choice
          key={trigger}
          label={repositoryTriggerLabel(trigger, provider)}
          value={transitions[trigger] ?? ""}
          options={[
            { value: "", label: t("admin.repository.noMove") },
            ...(workflow.data ?? []).map((state) => ({ value: state.id, label: state.name })),
          ]}
          onChange={(value) =>
            setTransitions((previous) => {
              const next = { ...previous };
              if (value) next[trigger] = value;
              else delete next[trigger];
              return next;
            })
          }
        />
      ))}
      <ErrorNotice error={create.error ?? update.error} />
      <Button
        title={t("admin.repository.save")}
        primary
        disabled={
          !repository.trim() ||
          (!connection && (!token || !secret)) ||
          create.isPending ||
          update.isPending
        }
        onPress={() => {
          const fields = {
            repository,
            commentOnLink: comment,
            transitions,
            ...(baseUrl ? { baseUrl } : {}),
            ...(token ? { token } : {}),
            ...(secret ? { webhookSecret: secret } : {}),
          };
          const promise = connection
            ? update.mutateAsync({
                projectId,
                connectionId: connection.id,
                expectedVersion: connection.version,
                ...fields,
              })
            : create.mutateAsync({ projectId, provider, ...fields, token, webhookSecret: secret });
          void promise.then(onSaved).catch(() => {});
        }}
      />
    </>
  );
}

function IssueSync({
  projectId,
  connection,
}: {
  projectId: string;
  connection: RepositoryConnection;
}) {
  const { api } = useConnection();
  const projects = useAllProjects();
  const workspaceId = projects.data?.find((project) => project.id === projectId)?.workspaceId;
  const labels = useQuery({
    ...api.query("list_workspace_labels", { workspaceId: workspaceId ?? "" }),
    enabled: !!workspaceId,
  });
  const links = useQuery(api.query("list_issue_links", { projectId, connectionId: connection.id }));
  const preview = useOperation("preview_repository_sync"),
    apply = useOperation("apply_repository_sync");
  const [outbound, setOutbound] = useState(connection.outbound),
    [version, setVersion] = useState(connection.version),
    [inbound, setInbound] = useState(connection.inbound),
    [receipt, setReceipt] = useState<SyncPreview>(),
    [review, setReview] = useState<string>();
  const change = (side: "outbound" | "inbound", rule: SyncRule) => {
    (side === "outbound" ? setOutbound : setInbound)(rule);
    setReceipt(undefined);
  };
  return (
    <>
      {(["outbound", "inbound"] as const).map((side) => {
        const rule = side === "outbound" ? outbound : inbound;
        return (
          <Section key={side} title={t(`admin.issueSync.${side}`)}>
            <Check
              label={
                side === "outbound"
                  ? t("admin.issueSync.exportTickets")
                  : t("admin.issueSync.importIssues")
              }
              checked={rule.enabled}
              onChange={(enabled) => change(side, { ...rule, enabled })}
            />
            <Choice
              label={t("admin.issueSync.match")}
              value={rule.match}
              options={[
                { value: "any", label: t("admin.issueSync.matchAny") },
                { value: "all", label: t("admin.issueSync.matchAll") },
              ]}
              onChange={(value) =>
                change(side, { ...rule, match: value === "all" ? "all" : "any" })
              }
            />
            <Choice
              label={t("admin.issueSync.ticketLabels")}
              value=""
              selected={rule.labels}
              options={(labels.data ?? []).map((label) => ({ value: label.id, label: label.name }))}
              onChange={() => {}}
              onToggle={(value) =>
                change(side, {
                  ...rule,
                  labels: rule.labels.includes(value)
                    ? rule.labels.filter((item) => item !== value)
                    : [...rule.labels, value],
                })
              }
            />
          </Section>
        );
      })}
      <ErrorNotice error={preview.error ?? apply.error ?? labels.error ?? links.error} />
      <Button
        title={t("admin.issueSync.previewAction")}
        disabled={preview.isPending}
        onPress={() => {
          void preview
            .mutateAsync({ projectId, connectionId: connection.id, outbound, inbound })
            .then(setReceipt)
            .catch(() => {});
        }}
      />
      {receipt && (
        <>
          {(["matching", "export", "pause", "review"] as const).map((key) => (
            <Body key={key}>
              {t("native.labelValue", {
                label: t(`admin.issueSync.preview.${key}`),
                value: formatNumber(receipt[key]),
              })}
            </Body>
          ))}
          <Button
            title={t("common.action.confirm")}
            primary
            disabled={apply.isPending}
            onPress={() => {
              void apply
                .mutateAsync({
                  projectId,
                  connectionId: connection.id,
                  expectedVersion: version,
                  outbound,
                  inbound,
                  fingerprint: receipt.fingerprint,
                })
                .then((saved) => {
                  setVersion(saved.version);
                  setReceipt(undefined);
                })
                .catch(() => {});
            }}
          />
        </>
      )}
      {links.data?.map((link) => (
        <Row
          key={link.id}
          title={`${link.ticketKey} · ${link.ticketTitle}`}
          caption={issueLinkStateLabels[link.state]}
          onPress={() => setReview(link.id)}
        />
      ))}
      <Sheet
        title={t("admin.issueSync.reviewTitle")}
        open={!!review}
        onClose={() => setReview(undefined)}
      >
        {review && (
          <IssueReview projectId={projectId} linkId={review} onSaved={() => setReview(undefined)} />
        )}
      </Sheet>
    </>
  );
}

function IssueReview({
  projectId,
  linkId,
  onSaved,
}: {
  projectId: string;
  linkId: string;
  onSaved: () => void;
}) {
  const { api } = useConnection(),
    compare = useQuery(api.query("compare_issue_link", { projectId, linkId })),
    reconcile = useOperation("reconcile_issue_link");
  return (
    <>
      <ErrorNotice error={compare.error ?? reconcile.error} />
      {compare.data ? (
        <>
          <Section title="Kanvil">
            <Body>{compare.data.local.title}</Body>
            <Body>{compare.data.local.description}</Body>
          </Section>
          <Section title={t("admin.issueSync.comparison")}>
            <Body>{compare.data.remote?.title ?? t("admin.issueSync.notReported")}</Body>
            <Body>{compare.data.remote?.description}</Body>
          </Section>
          {(["kanvil", "remote", "unlink"] as const).map((resolution) => (
            <Button
              key={resolution}
              title={
                resolution === "kanvil"
                  ? t("admin.issueSync.keepKanvil")
                  : resolution === "remote"
                    ? t("admin.issueSync.keepHost")
                    : t("admin.issueSync.unlink")
              }
              danger={resolution === "unlink"}
              disabled={reconcile.isPending || (resolution === "remote" && !compare.data.remote)}
              onPress={() => {
                const data = compare.data;
                if (data)
                  void reconcile
                    .mutateAsync({
                      projectId,
                      linkId,
                      expectedVersion: data.link.version,
                      ticketVersion: data.ticketVersion,
                      resolution,
                    })
                    .then(onSaved)
                    .catch(() => {});
              }}
            />
          ))}
        </>
      ) : (
        <Loading />
      )}
    </>
  );
}
