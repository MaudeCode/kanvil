import { formatEvent, formatTimestamp } from "@kanvil/contracts";
import { useState } from "react";
import { Alert, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigation } from "@react-navigation/native";
import { infoSchema, notificationsSchema, okSchema } from "@kanvil/contracts";
import { useConnection, useIdentity } from "./data.tsx";
import {
  Body,
  List,
  Button,
  Check,
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
  const items = useQuery({
    queryKey: ["kanvil", "notifications"],
    queryFn: () => api.request("/api/v1/notifications", notificationsSchema),
  });
  async function read() {
    const ids = items.data?.filter((item) => !item.readAt).map((item) => item.id);
    if (!ids?.length) return;
    await api.request("/api/v1/notifications/read", okSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    await cache.invalidateQueries({ queryKey: ["kanvil", "notifications"] });
  }
  return (
    <Screen scroll={false}>
      <View style={{ padding: 16 }}>
        <Button
          title="Mark all read"
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
              <Body muted>No notifications</Body>
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
function NotificationPreferences() {
  const { api } = useConnection(),
    cache = useQueryClient(),
    options = api.notificationPreferences();
  const preferences = useQuery(options);
  const update = useMutation({
    mutationFn: api.setNotificationPreferences,
    networkMode: "always",
    retry: false,
    onSuccess: (value) => cache.setQueryData(options.queryKey, value),
  });
  return (
    <Section title="Notifications">
      <ErrorNotice error={preferences.error ?? update.error} />
      {preferences.data && (
        <Check
          label="Subscribed ticket updates in Inbox"
          checked={update.isPending ? update.variables.inApp : preferences.data.inApp}
          disabled={update.isPending}
          onChange={(inApp) => {
            if (!update.isPending) update.mutate({ inApp });
          }}
        />
      )}
    </Section>
  );
}
export function Settings({ onDisconnect }: { onDisconnect: () => Promise<void> }) {
  const { api, auth, baseUrl, prefix } = useConnection(),
    identity = useIdentity(),
    cache = useQueryClient();
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
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
      setMessage("Password updated; other sessions revoked");
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
      <Section title="Local password">
        <Field
          label="Current password"
          value={current}
          onChangeText={setCurrent}
          secureTextEntry
          autoComplete="current-password"
        />
        <Field
          label="New password"
          value={next}
          onChangeText={setNext}
          secureTextEntry
          autoComplete="new-password"
        />
        <Button
          title="Change password"
          disabled={pending || !current || next.length < 12}
          onPress={() => {
            void changePassword();
          }}
        />
      </Section>
      {info.data?.oidc && (
        <Section title={info.data.oidc.name}>
          {accounts.data?.some((account) => account.providerId === "oidc") ? (
            <Body>Account linked</Body>
          ) : (
            <>
              <Body>Link this account before signing in with your identity provider.</Body>
              <Button
                title={`Link ${info.data.oidc.name}`}
                onPress={() => {
                  void auth
                    .linkSocial({ provider: "oidc", callbackURL: "kanvil://auth/callback" })
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
      )}
      <NotificationPreferences />
      <Button
        title="Sign out"
        disabled={pending}
        onPress={() =>
          Alert.alert(
            "Sign out?",
            "Cached tickets and drafts for this account will be removed from this device.",
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Sign out",
                onPress: () => {
                  void logout();
                },
              },
            ],
          )
        }
      />
      <Button
        title="Change server"
        disabled={pending}
        onPress={() =>
          Alert.alert(
            "Change server?",
            "Sign out and clear this account's local cache and drafts?",
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Change server",
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
