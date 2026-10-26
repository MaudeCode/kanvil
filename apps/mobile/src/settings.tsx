import { formatEvent, formatTimestamp } from "@kanvil/contracts";
import {
  localeDetails,
  localePreference,
  locales,
  t,
  formatRelativeTime,
  type LocalePreference,
} from "@kanvil/contracts/i18n";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Alert, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigation } from "@react-navigation/native";
import {
  infoSchema,
  notificationCategories,
  notificationCategoryLabels,
  reminderUnits,
  reminderUnitSchema,
} from "@kanvil/contracts";
import { useConnection, useIdentity, useProjects, useWorkspace, useAllProjects } from "./data.tsx";
import {
  accountSections,
  settingsSectionLabel,
  settingsSectionSymbols,
} from "@kanvil/contracts/navigation";
import { ProjectIcon } from "./project-icon.tsx";
import { UserAvatar } from "./ticket-values.tsx";
import { useProjectNavigation } from "./navigation.ts";
import { AppearanceSettings, CredentialsSettings, ProfileSettings } from "./account-settings.tsx";
import { createHeaderAction, createHeaderMenu } from "./navigation-actions.tsx";
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { DeliverySettings } from "./delivery-settings.tsx";
import {
  devicePushToken,
  disableDevicePush,
  enableDevicePush,
  forgetDevicePush,
  pushProjectId,
} from "./push.tsx";
import { savedLocalePreference, setLocalePreference } from "./locale.tsx";
import {
  nativeHeaderOptions,
  Body,
  List,
  Button,
  Check,
  Choice,
  ErrorNotice,
  Field,
  Loading,
  Row,
  Screen,
  WorkspaceScope,
  Section,
  Sheet,
  TicketGlyph,
  usePalette,
} from "./ui.tsx";

export function Inbox() {
  const { api } = useConnection(),
    cache = useQueryClient(),
    navigation = useNavigation(),
    workspace = useWorkspace(),
    projects = useAllProjects(),
    color = usePalette();
  const [view, setView] = useState<"unread" | "mentions" | "all">("unread"),
    [focused, setFocused] = useState<string>();
  const items = useQuery(api.notifications());
  const scoped = useMemo(() => {
    const allowed = new Set(
      projects.data
        ?.filter((project) => project.workspaceId === workspace.active?.id)
        .map((project) => project.id),
    );
    return (items.data ?? []).filter((item) => allowed.has(item.event.projectId));
  }, [items.data, projects.data, workspace.active?.id]);
  const visible = useMemo(
    () =>
      scoped.filter((item) =>
        view === "unread" ? !item.readAt : view === "mentions" ? item.category === "mention" : true,
      ),
    [scoped, view],
  );
  const action = useMutation({
    mutationFn: async ({
      ids,
      read,
      dismiss,
    }: {
      ids: string[];
      read?: boolean;
      dismiss?: boolean;
    }) => {
      for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        if (dismiss) await api.dismissNotifications({ ids: batch });
        else await api.markNotifications({ ids: batch, ...(read !== undefined ? { read } : {}) });
      }
    },
    onSuccess: () => cache.invalidateQueries({ queryKey: ["kanvil"] }),
  });
  const mutate = action.mutate;
  useLayoutEffect(() => {
    navigation.setOptions(
      nativeHeaderOptions({
        unstable_headerRightItems: (): NativeStackHeaderItem[] => [
          createHeaderAction(
            t("shell.inbox.markAllRead"),
            () =>
              mutate({
                ids: visible.filter((item) => !item.readAt).map((item) => item.id),
                read: true,
              }),
            { type: "sfSymbol", name: "checkmark.circle" },
            action.isPending || !visible.some((item) => !item.readAt),
            { visibilityPriority: "default", identifier: "inbox-read-all" },
          ),
          createHeaderMenu(
            t("ticket.filter.filters"),
            { type: "sfSymbol", name: "line.3.horizontal.decrease" },
            [
              {
                type: "action",
                label: t("shell.settingsNav.section.notifications"),
                onPress: () => navigation.navigate("AccountSettings", { section: "notifications" }),
              },
              ...(["unread", "mentions", "all"] as const).map((value) => ({
                type: "action" as const,
                label: t(`shell.inbox.${value}`),
                state: value === view ? ("on" as const) : ("off" as const),
                onPress: () => setView(value),
              })),
              {
                type: "action",
                label: t("shell.inbox.clearRead"),
                onPress: () =>
                  mutate({
                    ids: scoped.filter((item) => item.readAt).map((item) => item.id),
                    dismiss: true,
                  }),
                disabled: action.isPending,
              },
            ],
            { identifier: "inbox-options", visibilityPriority: "low" },
          ),
        ],
      }),
    );
  }, [navigation, visible, view, mutate, action.isPending, scoped]);
  const target = items.data?.find((item) => item.id === focused);
  return (
    <Screen scroll={false}>
      <WorkspaceScope>
        <Choice
          compact
          label={t("shell.page.inbox")}
          value={view}
          options={["unread", "mentions", "all"].map((value) => ({
            value,
            label: t(
              value === "unread"
                ? "shell.inbox.unread"
                : value === "mentions"
                  ? "shell.inbox.mentions"
                  : "shell.inbox.all",
            ),
          }))}
          onChange={(value) =>
            setView(value === "mentions" ? "mentions" : value === "all" ? "all" : "unread")
          }
        />
      </WorkspaceScope>
      <ErrorNotice error={items.error ?? action.error} />
      {items.isPending || projects.isPending ? (
        <Loading />
      ) : (
        <List
          data={visible}
          keyExtractor={(item) => item.id}
          onRefresh={() => items.refetch()}
          ListEmptyComponent={
            <View style={{ padding: 20 }}>
              <Body muted>
                {view === "unread"
                  ? t("shell.inbox.noUnread")
                  : view === "mentions"
                    ? t("shell.inbox.noMentions")
                    : t("shell.inbox.noNotifications")}
              </Body>
            </View>
          }
          renderItem={({ item }) => (
            <Row
              title={
                typeof item.event.data.title === "string"
                  ? item.event.data.title
                  : formatEvent(item.event, true)
              }
              emphasized={!item.readAt}
              interaction="action"
              leading={
                <TicketGlyph
                  name={item.readAt ? "circle-check" : "circle-dot"}
                  color={item.readAt ? color.muted : color.accent}
                />
              }
              accessibilityLabel={t("native.labelValue", {
                label: t(item.readAt ? "native.inbox.read" : "shell.inbox.unread"),
                value: [formatEvent(item.event, true), formatTimestamp(item.event.createdAt)].join(
                  " · ",
                ),
              })}
              caption={[
                typeof item.event.data.key === "string" ? item.event.data.key : "",
                formatEvent(item.event),
                formatRelativeTime(item.event.createdAt),
              ]
                .filter(Boolean)
                .join(" · ")}
              onLongPress={() => setFocused(item.id)}
              onPress={() => {
                mutate({ ids: [item.id], read: true });
                if (item.event.ticketId)
                  navigation.navigate("Ticket", {
                    projectId: item.event.projectId,
                    ticketId: item.event.ticketId,
                  });
                else setFocused(item.id);
              }}
            />
          )}
        />
      )}
      <Sheet title={t("shell.page.inbox")} open={!!target} onClose={() => setFocused(undefined)}>
        {target && (
          <>
            <Button
              title={target.readAt ? t("shell.inbox.markUnread") : t("shell.inbox.markRead")}
              disabled={action.isPending}
              onPress={() => {
                mutate({ ids: [target.id], read: !target.readAt });
                setFocused(undefined);
              }}
            />
            <Button
              title={t("shell.inbox.dismiss")}
              danger
              disabled={action.isPending}
              onPress={() => {
                mutate({ ids: [target.id], dismiss: true });
                setFocused(undefined);
              }}
            />
          </>
        )}
      </Sheet>
    </Screen>
  );
}
function NotificationPreferences({ pushAvailable }: { pushAvailable: boolean }) {
  const [reminderOpen, setReminderOpen] = useState(false);
  const connection = useConnection(),
    { api } = connection,
    identity = useIdentity(),
    cache = useQueryClient(),
    options = api.notificationPreferences();
  const preferences = useQuery(options);
  const update = useMutation({
    mutationFn: api.setNotificationPreferences,
    networkMode: "always",
    retry: false,
    onSuccess: (value) => cache.setQueryData(options.queryKey, value),
  });
  const device = useQuery({
    queryKey: ["device-push", identity.id],
    queryFn: () => devicePushToken(connection, identity.id),
  });
  const registration = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (enabled) {
        await enableDevicePush(connection, identity.id);
        await api.setNotificationPreferences({
          inApp: preferences.data?.inApp ?? true,
          push: true,
        });
      } else await disableDevicePush(connection, identity.id);
    },
    onSuccess: async () => {
      await device.refetch();
      await preferences.refetch();
    },
  });
  return (
    <Section title={t("native.notifications.title")}>
      <ErrorNotice
        error={preferences.error ?? update.error ?? registration.error ?? device.error}
      />
      {preferences.data && (
        <Check
          label={t("native.notifications.inApp")}
          checked={update.isPending ? update.variables.inApp : preferences.data.inApp}
          disabled={update.isPending || registration.isPending}
          onChange={(inApp) => {
            if (!update.isPending) update.mutate({ ...preferences.data, inApp });
          }}
        />
      )}
      {pushAvailable && preferences.data && (
        <>
          <Check
            label={t("native.notifications.push")}
            checked={
              update.isPending
                ? (update.variables.push ?? preferences.data.push)
                : preferences.data.push
            }
            disabled={update.isPending || registration.isPending}
            onChange={(push) => update.mutate({ inApp: preferences.data?.inApp ?? true, push })}
          />
          {typeof pushProjectId === "string" ? (
            <Button
              title={
                device.data
                  ? t("native.notifications.disableDevice")
                  : t("native.notifications.enableDevice")
              }
              disabled={registration.isPending || update.isPending || device.isPending}
              onPress={() => registration.mutate(!device.data)}
            />
          ) : (
            <Body muted>{t("native.notifications.unconfigured")}</Body>
          )}
        </>
      )}
      {preferences.data && (
        <>
          <Section title={t("settings.notifications.categories")}>
            {notificationCategories.map((category) => (
              <Check
                key={category}
                label={t("settings.notifications.categorySwitch", {
                  label: notificationCategoryLabels[category],
                })}
                checked={
                  update.isPending
                    ? (update.variables.categories?.[category] ??
                      preferences.data.categories[category])
                    : preferences.data.categories[category]
                }
                disabled={update.isPending}
                onChange={(enabled) =>
                  update.mutate({
                    inApp: preferences.data?.inApp ?? true,
                    categories: { [category]: enabled },
                  })
                }
              />
            ))}
          </Section>
          <Button
            title={t("settings.notifications.reminder")}
            onPress={() => setReminderOpen(true)}
          />
          <Sheet
            title={t("settings.notifications.reminder")}
            open={reminderOpen}
            onClose={() => {
              if (!update.isPending) setReminderOpen(false);
            }}
          >
            <ReminderPreference
              initial={preferences.data.reminderLead}
              onSave={async (reminderLead) => {
                await update.mutateAsync({ inApp: preferences.data?.inApp ?? true, reminderLead });
                setReminderOpen(false);
              }}
            />
          </Sheet>
        </>
      )}
    </Section>
  );
}
function ReminderPreference({
  initial,
  onSave,
}: {
  initial: { amount: number; unit: (typeof reminderUnits)[number] };
  onSave: (value: { amount: number; unit: (typeof reminderUnits)[number] }) => Promise<void>;
}) {
  const [amount, setAmount] = useState(String(initial.amount)),
    [unit, setUnit] = useState(initial.unit),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>();
  return (
    <>
      <Field
        label={t("settings.notifications.reminderAmount")}
        value={amount}
        onChangeText={setAmount}
        keyboardType="number-pad"
      />
      <Choice
        label={t("settings.notifications.reminderUnit")}
        value={unit}
        options={reminderUnits.map((value) => ({
          value,
          label: t(`settings.notifications.unit.${value}`),
        }))}
        onChange={(value) => setUnit(reminderUnitSchema.parse(value))}
      />
      <ErrorNotice error={error} />
      <Button
        title={t("common.action.save")}
        primary
        disabled={!/^\d+$/.test(amount) || Number(amount) < 1 || Number(amount) > 999 || pending}
        onPress={() => {
          setPending(true);
          void onSave({ amount: Number(amount), unit })
            .catch(setError)
            .finally(() => setPending(false));
        }}
      />
    </>
  );
}
export function Settings({
  onDisconnect,
  section,
}: {
  onDisconnect: () => Promise<void>;
  section?: string;
}) {
  const connection = useConnection(),
    { api, auth, baseUrl } = connection,
    identity = useIdentity(),
    workspace = useWorkspace(),
    projects = useProjects(),
    color = usePalette(),
    navigation = useNavigation();
  const { currentProjectId } = useProjectNavigation();
  const activeSection = accountSections.find((value) => value === section);
  useLayoutEffect(() => {
    navigation.setOptions({
      title: activeSection ? settingsSectionLabel(activeSection) : t("native.screen.settings"),
    });
  }, [navigation, activeSection]);
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [confirm, setConfirm] = useState(""),
    [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState(""),
    [language, setLanguage] = useState<LocalePreference>("system");
  useEffect(() => {
    let mounted = true;
    void savedLocalePreference().then((value) => {
      if (mounted) setLanguage(value);
    });
    return () => {
      mounted = false;
    };
  }, []);
  const info = useQuery({
    queryKey: ["info", baseUrl],
    queryFn: () => api.request("/api/v1/info", infoSchema),
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    enabled: activeSection === "account",
    queryFn: async () => {
      const result = await auth.listAccounts();
      if (result.error) throw new Error(result.error.message);
      return result.data;
    },
  });
  async function logout(disconnect = false) {
    setError(undefined);
    setPending(true);
    try {
      await identity.clearPrivateData();
      const result = await auth.signOut();
      if (result.error) throw new Error(result.error.message);
      await forgetDevicePush(connection, identity.id);
      if (disconnect) await onDisconnect();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  async function changePassword() {
    setError(undefined);
    setPending(true);
    try {
      if (next !== confirm) throw new Error(t("settings.account.passwordMismatch"));
      const result = await auth.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });
      if (result.error) throw new Error(result.error.message);
      setCurrent("");
      setNext("");
      setConfirm("");
      setMessage(t("native.settings.password.updated"));
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  if (!activeSection)
    return (
      <Screen>
        <Row
          title={identity.name}
          leading={<UserAvatar name={identity.name} image={identity.image} size={36} />}
          caption={identity.email}
          onPress={() => navigation.navigate("AccountSettings", { section: "account" })}
        />
        <Section title={t("shell.settingsNav.account")}>
          {accountSections
            .filter((value) => value !== "account")
            .map((value) => (
              <Row
                key={value}
                title={settingsSectionLabel(value)}
                leading={<TicketGlyph name={settingsSectionSymbols[value]} color={color.accent} />}
                onPress={() => navigation.navigate("AccountSettings", { section: value })}
              />
            ))}
        </Section>
        {workspace.active && (
          <Section title={workspace.active.name}>
            <Row
              title={t("shell.workspace.settings")}
              leading={<TicketGlyph name="building-2" color={color.accent} />}
              onPress={() => {
                if (workspace.active)
                  navigation.navigate("WorkspaceSettings", { workspaceId: workspace.active.id });
              }}
            />
          </Section>
        )}
        <Section title={t("shell.page.projects")}>
          <Choice
            label={t("shell.settingsNav.projectSettings")}
            value={
              projects.data?.some((project) => project.id === currentProjectId)
                ? (currentProjectId ?? "")
                : ""
            }
            emptyLabel={t("ticket.tagInput.choose", { label: t("ticket.project.label") })}
            options={(projects.data ?? []).map((project) => ({
              value: project.id,
              label: project.name,
              leading: <ProjectIcon project={project} size={20} />,
            }))}
            onChange={(projectId) => navigation.navigate("ProjectSettings", { projectId })}
          />
        </Section>
        {identity.admin && (
          <Row
            title={t("shell.settingsNav.administration")}
            leading={<TicketGlyph name="shield-check" color={color.accent} />}
            onPress={() => navigation.navigate("Administration", {})}
          />
        )}
        <Section title={baseUrl}>
          <Button
            title={t("native.settings.signOut.action")}
            disabled={pending}
            onPress={() =>
              Alert.alert(
                t("native.settings.signOut.title"),
                t("native.settings.signOut.message"),
                [
                  { text: t("common.action.cancel"), style: "cancel" },
                  {
                    text: t("native.settings.signOut.action"),
                    onPress: () => {
                      void logout();
                    },
                  },
                ],
              )
            }
          />
          <Button
            title={t("native.server.change")}
            disabled={pending}
            onPress={() =>
              Alert.alert(
                t("native.settings.changeServer.title"),
                t("native.settings.changeServer.message"),
                [
                  { text: t("common.action.cancel"), style: "cancel" },
                  {
                    text: t("native.server.change"),
                    onPress: () => {
                      void logout(true);
                    },
                  },
                ],
              )
            }
          />
          <ErrorNotice error={error} />
        </Section>
      </Screen>
    );
  return (
    <Screen>
      <ErrorNotice error={error} />
      {message && <Body>{message}</Body>}
      {activeSection === "account" && (
        <>
          <ProfileSettings onDeleted={() => logout()} />
          <Section title={t("native.settings.password.title")}>
            <Field
              label={t("native.settings.password.current")}
              value={current}
              onChangeText={setCurrent}
              secureTextEntry
              autoComplete="current-password"
            />
            <Field
              label={t("native.settings.password.new")}
              value={next}
              onChangeText={setNext}
              secureTextEntry
              autoComplete="new-password"
            />
            <Field
              label={t("settings.account.confirmPassword")}
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry
              autoComplete="new-password"
            />
            <Button
              title={t("native.settings.password.change")}
              disabled={pending || !current || next.length < 12 || next !== confirm}
              onPress={() => {
                void changePassword();
              }}
            />
          </Section>
          {info.data?.providers.map((provider) => (
            <Section key={provider.id} title={provider.name}>
              {accounts.data?.some((account) => account.providerId === provider.id) ? (
                <Body>{t("native.settings.oidc.linked")}</Body>
              ) : (
                <Button
                  title={t("native.settings.oidc.link", { provider: provider.name })}
                  onPress={() => {
                    void auth
                      .linkSocial({ provider: provider.id, callbackURL: "kanvil://auth/callback" })
                      .then(async (result) => {
                        if (result.error) throw new Error(result.error.message);
                        await accounts.refetch();
                      })
                      .catch(setError);
                  }}
                />
              )}
              <ErrorNotice error={accounts.error} />
            </Section>
          ))}
        </>
      )}
      {activeSection === "appearance" && <AppearanceSettings />}
      {activeSection === "preferences" && (
        <Choice
          label={t("common.language.label")}
          value={language}
          options={[
            { value: "system", label: t("common.language.system") },
            ...locales.map((locale) => ({ value: locale, label: localeDetails[locale].name })),
          ]}
          onChange={(value) => {
            const choice = localePreference.parse(value);
            setLanguage(choice);
            setError(undefined);
            void setLocalePreference(choice).catch(setError);
          }}
        />
      )}
      {activeSection === "credentials" && <CredentialsSettings />}
      {activeSection === "notifications" && (
        <>
          <NotificationPreferences pushAvailable={info.data?.push ?? false} />
          <DeliverySettings />
        </>
      )}
    </Screen>
  );
}
