import { createContext, useContext, useEffect, useState } from "react";
import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createClient } from "@kanvil/client";
import { checkpointSchema, snapshotSchema, type Operation } from "@kanvil/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { palettes, type ThemeMode } from "@kanvil/contracts/theme";

export const auth = createAuthClient({ plugins: [adminClient(), oauthProviderClient()] });
export const api = createClient({ baseUrl: window.location.origin });
export const Identity = createContext({ id: "", name: "", email: "", admin: false });
export const useIdentity = () => useContext(Identity);
export function useOperation<K extends Operation>(name: K) {
  const cache = useQueryClient();
  return useMutation({
    ...api.action(name),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["kanvil"] }),
  });
}
export const useProjects = () => useQuery(api.query("list_projects", {}));
export function useLive(projectId?: string) {
  const cache = useQueryClient();
  const [state, setState] = useState("connecting");
  useEffect(() => {
    const controller = new AbortController();
    let initialCheckpoint = true;
    const reset = async () => {
      const snapshot = projectId
        ? await api.request(
            `/api/v1/snapshot?projectId=${encodeURIComponent(projectId)}`,
            snapshotSchema,
          )
        : await api.request("/api/v1/checkpoint", checkpointSchema);
      await cache.invalidateQueries({ queryKey: ["kanvil"] });
      return snapshot.cursor;
    };
    void api
      .subscribe({
        ...(projectId ? { projectId } : {}),
        signal: controller.signal,
        onEvent: () => cache.invalidateQueries({ queryKey: ["kanvil"] }),
        onState: setState,
        onCursor: async () => {
          if (initialCheckpoint) {
            initialCheckpoint = false;
            await cache.invalidateQueries({ queryKey: ["kanvil"] });
          }
        },
        onReset: reset,
      })
      .catch(() => setState("Sign in to reconnect"));
    return () => controller.abort();
  }, [cache, projectId]);
  return state;
}
export const ThemeContext = createContext<{ mode: ThemeMode; setMode: (mode: ThemeMode) => void }>({
  mode: "system",
  setMode: () => {},
});
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem("kanvil:theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = mode === "system" ? (media.matches ? "dark" : "light") : mode;
      for (const [name, value] of Object.entries(palettes[resolved]))
        document.documentElement.style.setProperty(`--${name}`, value);
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    media.addEventListener("change", apply);
    localStorage.setItem("kanvil:theme", mode);
    return () => media.removeEventListener("change", apply);
  }, [mode]);
  return { mode, setMode };
}
export function clearPrivateStorage(userId: string) {
  for (const key of Object.keys(localStorage))
    if (key.startsWith(`kanvil:${userId}:`)) localStorage.removeItem(key);
}
export const date = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function useProjectAccess(projectId: string) {
  const identity = useIdentity(),
    members = useQuery(api.query("list_members", { projectId }));
  const role = identity.admin
    ? "admin"
    : members.data?.find((member) => member.userId === identity.id)?.role;
  return { role, canWrite: role === "writer" || role === "admin", canAdmin: role === "admin" };
}
export function ActorName({ projectId, actorId }: { projectId: string; actorId: string }) {
  const identity = useIdentity(),
    members = useQuery(api.query("list_members", { projectId }));
  return (
    <span title={actorId}>
      {actorId === identity.id
        ? "You"
        : (members.data?.find((member) => member.userId === actorId)?.name ?? "Former member")}
    </span>
  );
}
