import { UserAvatar } from "./components/user-avatar.tsx";
import { createContext, useContext, useEffect, useState } from "react";
import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createClient } from "@kanvil/client";
import { type Operation, type Workspace } from "@kanvil/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export const auth = createAuthClient({ plugins: [adminClient(), oauthProviderClient()] });
export const api = createClient({ baseUrl: window.location.origin });
export const Identity = createContext<{
  id: string;
  name: string;
  email: string;
  admin: boolean;
  image: string | null;
  clearPrivateData: () => void;
}>({ id: "", name: "", email: "", admin: false, image: null, clearPrivateData: () => {} });
export const useIdentity = () => useContext(Identity);
export function useOperation<K extends Operation>(name: K) {
  const cache = useQueryClient();
  return useMutation({
    ...api.action(name),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["kanvil"] }),
  });
}
export const WorkspaceSelection = createContext<{
  active: Workspace | undefined;
  workspaces: Workspace[];
  pending: boolean;
  error: unknown;
  select: (id: string) => void;
}>({ active: undefined, workspaces: [], pending: true, error: undefined, select: () => {} });
export const useWorkspace = () => useContext(WorkspaceSelection);
export const useWorkspaces = () => useQuery(api.query("list_workspaces", {}));
export const useAllProjects = () => useQuery(api.query("list_projects", {}));
export function useProjects() {
  const { active } = useWorkspace();
  return useQuery({
    ...api.query("list_projects", {}),
    select: (projects) =>
      active ? projects.filter((project) => project.workspaceId === active.id) : [],
  });
}
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

export function useProjectAccess(projectId: string, enabled = true) {
  const identity = useIdentity(),
    members = useQuery({
      ...api.query("list_members", { projectId }),
      enabled: enabled && !identity.admin,
    });
  const role = identity.admin
    ? "admin"
    : members.data?.find((member) => member.userId === identity.id)?.role;
  return { role, canWrite: role === "writer" || role === "admin", canAdmin: role === "admin" };
}
export function ActorName({
  projectId,
  actorId,
  avatar = false,
}: {
  projectId: string;
  actorId: string;
  avatar?: boolean;
}) {
  const identity = useIdentity(),
    members = useQuery(api.query("list_members", { projectId })),
    member = members.data?.find((person) => person.userId === actorId),
    name = actorId === identity.id ? identity.name : (member?.name ?? "Former member"),
    image = actorId === identity.id ? identity.image : member?.image;
  return (
    <span className={avatar ? "inline-flex items-center gap-2" : ""} title={actorId}>
      {avatar && <UserAvatar name={name} image={image} className="size-7 text-[10px]" />}
      {actorId === identity.id ? "You" : name}
    </span>
  );
}
