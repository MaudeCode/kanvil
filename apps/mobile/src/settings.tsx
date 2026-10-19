import { formatEvent, formatTimestamp } from "@kanvil/contracts";
import {
  localeDetails,
  localePreference,
  locales,
  t,
  type LocalePreference,
} from "@kanvil/contracts/i18n";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigation } from "@react-navigation/native";
import { infoSchema } from "@kanvil/contracts";
import { useConnection, useIdentity } from "./data.tsx";
import {
  devicePushToken,
  disableDevicePush,
  enableDevicePush,
  forgetDevicePush,
  pushProjectId,
} from "./push.tsx";
import { savedLocalePreference, setLocalePreference } from "./locale.tsx";
import {
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
  Section,
} from "./ui.tsx";

export function Inbox() {
  const { api } = useConnection(),
    cache = useQueryClient(),
    navigation = useNavigation(),
    [error, setError] = useState<unknown>();
  const notifications = api.notifications(),
    items = useQuery(notifications);
  async function read() {
    const ids = items.data?.filter((item) => !item.readAt).map((item) => item.id);
    if (!ids?.length) return;
    await api.markNotifications({ ids });
    await cache.invalidateQueries({ queryKey: notifications.queryKey });
  }
  return (
    <Screen scroll={false}>
      <View style={{ padding: 16 }}>
        <Button
          title={t("native.inbox.markAllRead")}
          disabled={!items.data?.some((item) => !item.readAt)}
          onPress={() => {
            void read().catch(setError);
          }}
        />
        <ErrorNotice error={error ?? items.error} />
      </View>
      {items.isPending ? (
        <Loading />
      ) : (
        <List
          data={items.data ?? []}
          keyExtractor={(item) => item.id}
          onRefresh={() => {
            void items.refetch();
          }}
          refreshing={items.isRefetching}
          ListEmptyComponent={
            <View style={{ padding: 20 }}>
              <Body muted>{t("native.inbox.empty")}</Body>
            </View>
          }
          renderItem={({ item }) => (
            <Row
              title={`${item.readAt ? "" : "● "}${formatEvent(item.event, true)}`}
              caption={formatTimestamp(item.event.createdAt)}
              onPress={() => {
                if (item.event.ticketId)
                  navigation.navigate("Ticket", {
                    projectId: item.event.projectId,
                    ticketId: item.event.ticketId,
                  });
              }}
            />
          )}
        />
      )}
    </Screen>
  );
}
function NotificationPreferences({ pushAvailable }: { pushAvailable: boolean }) {
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
            checked={update.isPending ? (update.variables.push ?? false) : preferences.data.push}
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
  );
}
export function Settings({ onDisconnect }: { onDisconnect: () => Promise<void> }) {
  const connection = useConnection(),
    { api, auth, baseUrl, prefix } = connection,
    identity = useIdentity(),
    cache = useQueryClient();
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
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
    queryFn: async () => {
      const result = await auth.listAccounts();
      if (result.error) throw new Error(result.error.message);
      return result.data;
    },
  });
  async function logout(disconnect = false) {
    setError(undefined);
    setPending(true);
    // Clear the query cache before Better Auth unmounts this account's provider.
    cache.clear();
    try {
      const result = await auth.signOut();
      if (result.error) throw new Error(result.error.message);
    } catch (cause) {
      setError(cause);
    } finally {
      try {
        await forgetDevicePush(connection, identity.id);
        const keys = await AsyncStorage.getAllKeys();
        await AsyncStorage.multiRemove(
          keys.filter((key) => key.startsWith(`${prefix}:${identity.id}:`)),
        );
        if (disconnect) await onDisconnect();
      } catch (cause) {
        setError(cause);
      }
      setPending(false);
    }
  }
  async function changePassword() {
    setError(undefined);
    setPending(true);
    try {
      const result = await auth.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });
      if (result.error) throw new Error(result.error.message);
      setCurrent("");
      setNext("");
      setMessage(t("native.settings.password.updated"));
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <Screen>
      <Body>{identity.name}</Body>
      <Body muted>{identity.email}</Body>
      <Body muted>{baseUrl}</Body>
      <ErrorNotice error={error} />
      {message && <Body>{message}</Body>}
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
        <Button
          title={t("native.settings.password.change")}
          disabled={pending || !current || next.length < 12}
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
            <>
              <Body>{t("native.settings.oidc.explanation")}</Body>
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
            </>
          )}
          <ErrorNotice error={accounts.error} />
        </Section>
      ))}
      <NotificationPreferences pushAvailable={info.data?.push ?? false} />
      <Button
        title={t("native.settings.signOut.action")}
        disabled={pending}
        onPress={() =>
          Alert.alert(t("native.settings.signOut.title"), t("native.settings.signOut.message"), [
            { text: t("common.action.cancel"), style: "cancel" },
            {
              text: t("native.settings.signOut.action"),
              onPress: () => {
                void logout();
              },
            },
          ])
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
    </Screen>
  );
}
