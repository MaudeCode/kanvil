import { UserAvatar } from "./components/user-avatar.tsx";
import { createContext, useContext, useEffect, useState } from "react";
import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createClient } from "@kanvil/client";
import { type ChangeEvent, type Operation, type Workspace } from "@kanvil/contracts";
import type { Query } from "@tanstack/react-query";
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
// Project-wide reads that only change on these event families; ticket traffic leaves them alone.
const settledBy: Record<string, string[]> = {
  list_members: ["membership.", "project."],
  list_workspace_members: ["membership.", "project."],
  list_project_labels: ["label.", "project."],
  list_label_colors: ["label."],
  list_views: ["label.", "project."],
  get_project: ["project.", "label."],
};
// Decides which cached queries a realtime event can have changed.
export function affectedBy(event: ChangeEvent) {
  return (query: Query) => {
    const [namespace, , name, input] = query.queryKey;
    if (namespace !== "kanvil") return false;
    if (typeof name !== "string" || !input || typeof input !== "object") return true;
    const families = settledBy[name];
    if (families && !families.some((family) => event.type.startsWith(family))) return false;
    const scope = input as { projectId?: unknown; ticketId?: unknown };
    if (typeof scope.projectId !== "string") return true;
    if (scope.projectId !== event.projectId) return false;
    if (!event.ticketId || typeof scope.ticketId !== "string") return true;
    return scope.ticketId === event.ticketId || scope.ticketId === event.data.key;
  };
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
        invalidate: (event) =>
          cache.invalidateQueries(
            event ? { predicate: affectedBy(event) } : { queryKey: ["kanvil"] },
          ),
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
  return { role, ...accessOf(role) };
}
// The one rule turning a project role into UI permissions, shared with list_projects rows.
export const accessOf = (role: string | undefined) => ({
  canWrite: role === "writer" || role === "admin",
  canAdmin: role === "admin",
});
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
