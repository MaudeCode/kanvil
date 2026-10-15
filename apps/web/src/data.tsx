import { createContext, useContext, useEffect, useState } from "react";
import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createClient } from "@kanvil/client";
import { type Operation } from "@kanvil/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
    void api
      .watch({
        ...(projectId ? { projectId } : {}),
        signal: controller.signal,
        invalidate: () => cache.invalidateQueries({ queryKey: ["kanvil"] }),
        onState: setState,
      })
      .catch(() => setState("Sign in to reconnect"));
    return () => controller.abort();
  }, [cache, projectId]);
  return state;
}
export function clearPrivateStorage(userId: string) {
  for (const key of Object.keys(localStorage))
    if (key.startsWith(`kanvil:${userId}:`)) localStorage.removeItem(key);
}
export { formatTimestamp as date } from "@kanvil/contracts";

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
