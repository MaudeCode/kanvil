import { formatEvent, formatTimestamp } from "@kanvil/contracts";
import { notificationCategorySymbols } from "@kanvil/contracts/icons";
import {
  localeDetails,
  localePreference,
  locales,
  t,
  formatRelativeTime,
  formatNumber,
  type LocalePreference,
} from "@kanvil/contracts/i18n";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Alert } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import {
  infoSchema,
  notificationCategories,
  notificationCategoryLabels,
  reminderUnits,
  reminderUnitSchema,
} from "@kanvil/contracts";
import {
  useConnection,
  useIdentity,
  useProjects,
  useWorkspace,
  useAllProjects,
  useProjectAccess,
} from "./data.tsx";
import {
  accountSections,
  adminSections,
  workspaceSections,
  settingsSectionLabel,
  settingsSectionSymbols,
  type SettingsSection,
} from "@kanvil/contracts/navigation";
import { startupDiagnosticsEnabled, shareStartupDiagnostics } from "./media.ts";
import { ProjectIcon } from "./project-icon.tsx";
import { UserAvatar } from "./ticket-values.tsx";
import { useProjectNavigation, projectSettingsSections, type Routes } from "./navigation.ts";
import { AppearanceSettings, CredentialsSettings, ProfileSettings } from "./account-settings.tsx";
import { createHeaderAction, createHeaderMenu } from "./navigation-actions.tsx";
import type {
  NativeStackHeaderItem,
  NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import { DeliverySettings } from "./delivery-settings.tsx";
import { SplitView } from "./split-view.tsx";
import type { ReactNode } from "react";
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
  EmptyState,
  Field,
  Loading,
  Row,
  Screen,
  WorkspaceScope,
  Section,
  Sheet,
  TicketGlyph,
  usePalette,
  GroupedSurface,
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
    <Screen
      scroll={false}
      scrollInsets
      header={
        <>
          <WorkspaceScope />
          <ErrorNotice error={items.error} background={!!items.data} />
        </>
      }
    >
      <ErrorNotice error={action.error} />
      <List
        data={visible}
        keyExtractor={(item) => item.id}
        onRefresh={() => items.refetch()}
        ListEmptyComponent={
          items.isPending || projects.isPending ? (
            <Loading />
          ) : (
            <EmptyState
              icon="inbox"
              title={
                view === "unread"
                  ? t("shell.inbox.noUnread")
                  : view === "mentions"
                    ? t("shell.inbox.noMentions")
                    : t("shell.inbox.noNotifications")
              }
            />
          )
        }
        renderItem={({ item }) => (
          <Row
            title={
              typeof item.event.data.title === "string"
                ? item.event.data.title
                : formatEvent(item.event)
            }
            {...(typeof item.event.data.key === "string" ? { overline: item.event.data.key } : {})}
            emphasized={!item.readAt}
            interaction="action"
            leading={
              <TicketGlyph
                name={notificationCategorySymbols[item.category]}
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
              typeof item.event.data.title === "string" ? formatEvent(item.event) : "",
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
  const color = usePalette();
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
    <>
      <ErrorNotice
        error={preferences.error ?? update.error ?? registration.error ?? device.error}
      />
      {preferences.isPending && <Loading />}
      <Section>
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
      </Section>
      {preferences.data && (
        <>
          <Section title={t("settings.notifications.categories")}>
            {notificationCategories.map((category) => (
              <Check
                key={category}
                label={notificationCategoryLabels[category]}
                accessibilityLabel={t("settings.notifications.categorySwitch", {
                  label: notificationCategoryLabels[category],
                })}
                leading={
                  <TicketGlyph
                    name={notificationCategorySymbols[category]}
                    color={color.muted}
                    size={20}
                  />
                }
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
          <Section>
            <Row
              title={t("settings.notifications.reminder")}
              leading={<TicketGlyph name="clock" color={color.muted} size={20} />}
              caption={formatNumber(preferences.data.reminderLead.amount, {
                style: "unit",
                unit: preferences.data.reminderLead.unit.slice(0, -1),
                unitDisplay: "long",
              })}
              onPress={() => setReminderOpen(true)}
            />
          </Section>
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
    </>
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
      <Section>
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
      </Section>
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
// The directory and adaptive Settings sidebar render the same destinations.
export function SettingsNavigation() {
  const identity = useIdentity(),
    workspace = useWorkspace(),
    projects = useProjects(),
    color = usePalette(),
    navigation = useNavigation<NativeStackNavigationProp<Routes>>(),
    route = useRoute<RouteProp<Routes>>();
  const { currentProjectId } = useProjectNavigation();
  const params = route.params;
  const section = params && "section" in params ? params.section : undefined;
  const projectId = params && "projectId" in params ? params.projectId : undefined;
  const workspaceId = params && "workspaceId" in params ? params.workspaceId : undefined;
  const access = useProjectAccess(projectId ?? "");
  const projectOptions = projectSettingsSections(access);
  function sections(
    values: readonly SettingsSection[],
    active: string | undefined,
    onSelect: (value: SettingsSection) => void,
  ) {
    return values.map((value) => (
      <Row
        key={value}
        title={settingsSectionLabel(value)}
        leading={<TicketGlyph name={settingsSectionSymbols[value]} color={color.accent} />}
        active={value === active}
        interaction="action"
        onPress={() => onSelect(value)}
      />
    ));
  }
  const accountNavigation = (
    <>
      <Section>
        <Row
          title={identity.name}
          leading={<UserAvatar name={identity.name} image={identity.image} size={36} />}
          caption={identity.email}
          active={route.name === "AccountSettings" && section === "account"}
          onPress={() => navigation.navigate("AccountSettings", { section: "account" })}
        />
      </Section>
      <Section title={t("shell.settingsNav.account")}>
        {sections(
          accountSections.filter((value) => value !== "account"),
          route.name === "AccountSettings" ? section : undefined,
          (value) => navigation.navigate("AccountSettings", { section: value }),
        )}
      </Section>
    </>
  );
  const workspaceNavigation = (
    <>
      {workspace.active && (
        <Section
          title={
            workspaceId
              ? (workspace.workspaces.find((space) => space.id === workspaceId)?.name ??
                t("shell.workspace.settings"))
              : workspace.active.name
          }
        >
          {route.name === "WorkspaceSettings" && workspaceId ? (
            sections(workspaceSections, section ?? workspaceSections[0], (value) =>
              navigation.navigate("WorkspaceSettings", { workspaceId, section: value }),
            )
          ) : (
            <Row
              title={t("shell.workspace.settings")}
              leading={<TicketGlyph name="building-2" color={color.accent} />}
              onPress={() => {
                if (workspace.active)
                  navigation.navigate("WorkspaceSettings", { workspaceId: workspace.active.id });
              }}
            />
          )}
        </Section>
      )}
    </>
  );
  const projectNavigation = (
    <>
      <Section title={t("shell.page.projects")}>
        <Choice
          label={t("shell.settingsNav.projectSettings")}
          value={
            projects.data?.some((project) => project.id === (projectId ?? currentProjectId))
              ? (projectId ?? currentProjectId ?? "")
              : ""
          }
          emptyLabel={t("ticket.tagInput.choose", { label: t("ticket.project.label") })}
          options={(projects.data ?? []).map((project) => ({
            value: project.id,
            label: project.name,
            leading: <ProjectIcon project={project} size={20} />,
          }))}
          onChange={(chosenProjectId) =>
            navigation.navigate("ProjectSettings", { projectId: chosenProjectId })
          }
        />
        {route.name === "ProjectSettings" &&
          projectId &&
          sections(projectOptions, section ?? projectOptions[0], (value) =>
            navigation.navigate("ProjectSettings", { projectId, section: value }),
          )}
      </Section>
    </>
  );
  const adminNavigation = (
    <>
      {identity.admin && (
        <Section>
          {route.name === "Administration" ? (
            sections(adminSections, section ?? adminSections[0], (value) =>
              navigation.navigate("Administration", { section: value }),
            )
          ) : (
            <Row
              title={t("shell.settingsNav.administration")}
              leading={<TicketGlyph name="shield-check" color={color.accent} />}
              onPress={() => navigation.navigate("Administration", {})}
            />
          )}
        </Section>
      )}
    </>
  );
  return (
    <>
      {route.name === "WorkspaceSettings" && workspaceNavigation}
      {route.name === "ProjectSettings" && projectNavigation}
      {route.name === "Administration" && adminNavigation}
      {accountNavigation}
      {route.name !== "WorkspaceSettings" && workspaceNavigation}
      {route.name !== "ProjectSettings" && projectNavigation}
      {route.name !== "Administration" && adminNavigation}
    </>
  );
}

// The selected form stays mounted while folding; only the measured pane geometry changes.
export function SettingsLayout({
  children,
  root = false,
}: {
  children: ReactNode;
  root?: boolean;
}) {
  const navigation = useNavigation();
  const [layout, setLayout] = useState({ collapsed: true, secondaryVisible: !root });
  useLayoutEffect(() => {
    navigation.setOptions({ headerBackVisible: !root && layout.collapsed });
  }, [navigation, root, layout.collapsed]);
  return (
    <GroupedSurface value>
      <Screen scroll={false} scrollInsets allowDivision>
        <SplitView
          secondaryActive={!root}
          onChange={setLayout}
          primary={
            root ? (
              children
            ) : (
              <Screen>
                <SettingsNavigation />
              </Screen>
            )
          }
          secondary={
            root ? (
              <Screen>
                <EmptyState
                  icon="settings-2"
                  title={t("ticket.tagInput.choose", { label: t("settings.layout.section") })}
                />
              </Screen>
            ) : (
              children
            )
          }
        />
      </Screen>
    </GroupedSurface>
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
    navigation = useNavigation();
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
        <SettingsNavigation />
        <Section title={baseUrl}>
          {startupDiagnosticsEnabled && (
            <Button
              title={t("native.detail.share")}
              onPress={() => {
                void shareStartupDiagnostics().catch(setError);
              }}
            />
          )}
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
    <Screen form={activeSection === "account"}>
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
        <Section>
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
        </Section>
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
