import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAuthClient } from "better-auth/react";
import { adminClient, emailOTPClient } from "better-auth/client/plugins";
import { expoClient } from "@better-auth/expo/client";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { fetch as expoFetch } from "expo/fetch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@kanvil/client";
import {
  capabilitiesOf,
  permissions,
  type Operation,
  type Permission,
  type Workspace,
} from "@kanvil/contracts";
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
export const Identity = createContext<{
  id: string;
  name: string;
  email: string;
  image: string | null;
  admin: boolean;
  clearPrivateData: () => Promise<void>;
}>({
  id: "",
  name: "",
  email: "",
  image: null,
  admin: false,
  clearPrivateData: async () => {},
});
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
const WorkspaceSelection = createContext<{
  active: Workspace | undefined;
  workspaces: Workspace[];
  pending: boolean;
  error: unknown;
  select: (id: string) => void;
}>({ active: undefined, workspaces: [], pending: true, error: undefined, select: () => {} });
export const useWorkspace = () => useContext(WorkspaceSelection);
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { api, prefix } = useConnection(),
    identity = useIdentity();
  const spaces = useQuery(api.query("list_workspaces", {}));
  const key = `${prefix}:${identity.id}:workspace`;
  const [selection, setSelection] = useState<string | null>(),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem(key)
      .then((value) => {
        if (mounted) {
          setSelection(value);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (mounted) setLoaded(true);
      });
    return () => {
      mounted = false;
    };
  }, [key]);
  const active = spaces.data?.find((space) => space.id === selection) ?? spaces.data?.[0];
  useEffect(() => {
    if (loaded && active) void AsyncStorage.setItem(key, active.id).catch(() => {});
  }, [key, loaded, active]);
  return (
    <WorkspaceSelection
      value={{
        active,
        workspaces: spaces.data ?? [],
        pending: !loaded || spaces.isPending,
        error: spaces.error,
        select: setSelection,
      }}
    >
      {children}
    </WorkspaceSelection>
  );
}
export function useAllProjects() {
  const { api } = useConnection();
  return useQuery(api.query("list_projects", { archived: "include" }));
}
export function useProjects(includeArchived = false) {
  const { active } = useWorkspace();
  const projects = useAllProjects();
  return {
    ...projects,
    data: projects.data?.filter(
      (project) => project.workspaceId === active?.id && (includeArchived || !project.archivedAt),
    ),
  };
}
export function useProjectAccess(projectId: string) {
  const identity = useIdentity();
  const projects = useAllProjects();
  const project = projects.data?.find(
    (item) => item.id === projectId || item.key === projectId.toUpperCase(),
  );
  const actions = identity.admin ? permissions : capabilitiesOf(project ?? { role: null });
  const holds = (action: Permission) => actions.includes(action);
  return {
    project,
    canWrite: !project?.archivedAt && holds("ticket.write"),
    canAdmin: !project?.archivedAt && holds("project.manage"),
    canManage: holds("project.manage"),
    canDelete: !project?.archivedAt && holds("ticket.delete"),
    canManageMembers: holds("member.manage"),
    canShare: holds("sharing.manage"),
    actions,
  };
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
