import { createContext, useContext, useEffect, useState } from "react";
import { createAuthClient } from "better-auth/react";
import { adminClient, emailOTPClient } from "better-auth/client/plugins";
import { expoClient } from "@better-auth/expo/client";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { fetch as expoFetch } from "expo/fetch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@kanvil/client";
import { type Operation } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";

export async function connect(url: string) {
  const parsed = new URL(url.trim());
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(t("native.server.invalidOrigin"));
  if (parsed.protocol === "http:" && !__DEV__) throw new Error(t("native.server.httpsRequired"));
  const baseUrl = parsed.origin;
  const prefix = `kanvil_${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, baseUrl)}`;
  const auth = createAuthClient({
    baseURL: baseUrl,
    plugins: [
      adminClient(),
      emailOTPClient(),
      expoClient({ scheme: "kanvil", storagePrefix: prefix, storage: SecureStore }),
    ],
  });
  const headers = async () => ({ Cookie: await auth.getCookie(), Origin: "kanvil://" });
  const api = createClient({
    baseUrl,
    credentials: "omit",
    fetch: expoFetch,
    requestId: Crypto.randomUUID,
    headers,
  });
  return { baseUrl, prefix, auth, api, headers };
}
export type Connection = Awaited<ReturnType<typeof connect>>;
export const ConnectionContext = createContext<Connection | null>(null);
export const Identity = createContext({ id: "", name: "", email: "", admin: false });
export const useIdentity = () => useContext(Identity);
export function useConnection() {
  const connection = useContext(ConnectionContext);
  if (!connection) throw new Error("Connect to a Kanvil server first");
  return connection;
}
export function useOperation<K extends Operation>(name: K) {
  const { api } = useConnection(),
    cache = useQueryClient();
  return useMutation({
    ...api.action(name),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["kanvil"] }),
  });
}
export function useProjects() {
  const { api } = useConnection();
  return useQuery(api.query("list_projects", {}));
}
export function useLive() {
  const { api } = useConnection(),
    cache = useQueryClient(),
    [state, setState] = useState<"connecting" | "connected" | "offline" | "closed" | "signedOut">(
      "connecting",
    );
  useEffect(() => {
    const controller = new AbortController();
    void api
      .watch({
        signal: controller.signal,
        invalidate: () => cache.invalidateQueries({ queryKey: ["kanvil"] }),
        onState: setState,
      })
      .catch(() => setState("signedOut"));
    return () => controller.abort();
  }, [api, cache]);
  return state;
}
