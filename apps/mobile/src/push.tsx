import { useCallback, useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { useQueryClient } from "@tanstack/react-query";
import type { NavigationContainerRefWithCurrent } from "@react-navigation/native";
import { okSchema } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { z } from "zod";
import { type Connection, useConnection, useIdentity } from "./data.tsx";
import type { Routes } from "./navigation.ts";

export const pushProjectId =
  Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
const tokenKey = (connection: Connection, userId: string) => `${connection.prefix}_${userId}_push`;
export const devicePushToken = (connection: Connection, userId: string) =>
  SecureStore.getItemAsync(tokenKey(connection, userId));
export const forgetDevicePush = (connection: Connection, userId: string) =>
  SecureStore.deleteItemAsync(tokenKey(connection, userId));
export async function enableDevicePush(connection: Connection, userId: string) {
  if (typeof pushProjectId !== "string") throw new Error(t("native.notifications.noProjectId"));
  if (Platform.OS === "android")
    await Notifications.setNotificationChannelAsync("tickets", {
      name: t("native.notifications.channel"),
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) throw new Error(t("native.notifications.permissionDenied"));
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: pushProjectId });
  await connection.api.request("/api/v1/notifications/device", okSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  await SecureStore.setItemAsync(tokenKey(connection, userId), token);
}
export async function disableDevicePush(connection: Connection, userId: string) {
  const token = await devicePushToken(connection, userId);
  if (token)
    await connection.api.request("/api/v1/notifications/device", okSchema, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  await forgetDevicePush(connection, userId);
}

const destination = z.object({ server: z.string(), projectId: z.uuid(), ticketId: z.uuid() });
export function usePushNavigation(navigation: NavigationContainerRefWithCurrent<Routes>) {
  const connection = useConnection(),
    { baseUrl } = connection,
    identity = useIdentity(),
    cache = useQueryClient();
  const pending = useRef<Notifications.NotificationResponse | null>(null);
  const handled = useRef("");
  const open = useCallback(
    (response: Notifications.NotificationResponse | null) => {
      if (!response || handled.current === response.notification.request.identifier) return;
      const target = destination.safeParse(response.notification.request.content.data);
      if (!target.success || target.data.server !== baseUrl) return;
      if (!navigation.isReady()) {
        pending.current = response;
        return;
      }
      handled.current = response.notification.request.identifier;
      pending.current = null;
      void cache.invalidateQueries({ queryKey: ["kanvil"] });
      navigation.navigate("Ticket", {
        projectId: target.data.projectId,
        ticketId: target.data.ticketId,
      });
      void Notifications.clearLastNotificationResponseAsync().catch(() => {});
    },
    [baseUrl, cache, navigation],
  );
  useEffect(() => {
    const listener = Notifications.addNotificationResponseReceivedListener(open);
    void Notifications.getLastNotificationResponseAsync()
      .then(open)
      .catch(() => {});
    return () => listener.remove();
  }, [open]);
  useEffect(() => {
    const refresh = () => {
      void (async () => {
        if (!(await devicePushToken(connection, identity.id))) return;
        if ((await Notifications.getPermissionsAsync()).granted)
          await enableDevicePush(connection, identity.id);
        else await disableDevicePush(connection, identity.id);
      })().catch(() => {});
    };
    refresh();
    const state = AppState.addEventListener("change", (value) => {
      if (value === "active") refresh();
    });
    const token = Notifications.addPushTokenListener(refresh);
    return () => {
      state.remove();
      token.remove();
    };
  }, [connection, identity.id]);
  return () => open(pending.current);
}
