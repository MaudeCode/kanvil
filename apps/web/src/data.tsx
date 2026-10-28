import { UserAvatar } from "./components/user-avatar.tsx";
import { affectedBy, createRefreshQueue } from "./lib/refresh-queue.ts";
import { createContext, useContext, useEffect, useState } from "react";
import { createAuthClient } from "better-auth/react";
import { adminClient, emailOTPClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createClient } from "@kanvil/client";
import {
  capabilitiesOf,
  infoSchema,
  memberName,
  permissions,
  type Operation,
  type Input,
  type OutputOf,
  type Permission,
  type Workspace,
} from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { useIsRestoring, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export const auth = createAuthClient({
  plugins: [adminClient(), emailOTPClient(), oauthProviderClient()],
});
export const api = createClient({ baseUrl: window.location.origin });
export const Identity = createContext<{
  id: string;
  name: string;
  email: string;
  admin: boolean;
  image: string | null;
  clearPrivateData: () => void | Promise<void>;
}>({ id: "", name: "", email: "", admin: false, image: null, clearPrivateData: () => {} });
export const useIdentity = () => useContext(Identity);
// Public instance details and sign-in options, shared by signed-out and signed-in screens.
export const useInfo = () =>
  useQuery({ queryKey: ["info"], queryFn: () => api.request("/api/v1/info", infoSchema) });
// Ends the session, clears this account's cached data, and loads `next` signed out.
export async function signOut(
  identity: { clearPrivateData: () => void | Promise<void> },
  next = "/login",
) {
  const result = await auth.signOut();
  if (result.error) throw new Error(result.error.message);
  await identity.clearPrivateData();
  window.location.assign(next);
}
// `before` runs ahead of the refetch, such as leaving a page whose subject the write removed.
export function useOperation<K extends Operation>(
  name: K,
  before?: (saved: OutputOf<K, Input<K>>) => unknown,
) {
  const cache = useQueryClient();
  return useMutation({
    ...api.action(name),
    onSuccess: async (saved) => {
      await before?.(saved);
      return cache.invalidateQueries({ queryKey: ["kanvil"] });
    },
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
// One cached project list, archived projects included: they still open, read only, by link.
export const projectsQuery = () => api.query("list_projects", { archived: "include" });
export const useAllProjects = () => useQuery(projectsQuery());
// The active workspace's projects for navigation and pickers; archived ones are left out.
export function useProjects() {
  const { active } = useWorkspace();
  return useQuery({
    ...projectsQuery(),
    select: (projects) =>
      active
        ? projects.filter((project) => project.workspaceId === active.id && !project.archivedAt)
        : [],
  });
}
export function useProject(projectId: string) {
  return useQuery({
    ...projectsQuery(),
    select: (projects) => projects.find((project) => project.id === projectId),
  });
}
export function useLive(projectId?: string) {
  const cache = useQueryClient();
  const restoring = useIsRestoring();
  const [state, setState] = useState("connecting");
  useEffect(() => {
    if (restoring) return undefined;
    const controller = new AbortController();
    const refresh = createRefreshQueue(
      (events) =>
        cache.invalidateQueries(
          events
            ? { predicate: (query) => events.some((event) => affectedBy(event)(query)) }
            : { queryKey: ["kanvil"] },
        ),
      controller.signal,
    );
    void api
      .watch({
        ...(projectId ? { projectId } : {}),
        signal: controller.signal,
        invalidate: (event) => (event ? refresh.push(event) : refresh.flush()),
        onState: setState,
      })
      .catch(() => setState(t("shell.connection.signIn")));
    return () => controller.abort();
  }, [cache, projectId, restoring]);
  return state;
}
export function clearPrivateStorage(userId: string) {
  for (const key of Object.keys(localStorage))
    if (key.startsWith(`kanvil:${userId}:`)) localStorage.removeItem(key);
}
export { formatTimestamp as date } from "@kanvil/contracts";

// Reads the actions the server reports for the caller's role from the shared list_projects cache,
// so checking many projects costs one request. An archived project is read only: `canManage`,
// `canManageMembers`, and `canShare` keep its details, lifecycle, access, and sharing controls,
// which the server still accepts.
export function useProjectAccess(projectId: string, enabled = true) {
  const identity = useIdentity(),
    projects = useQuery({
      ...projectsQuery(),
      enabled,
      select: (rows) => rows.find((project) => project.id === projectId),
    });
  const role = identity.admin ? "admin" : projects.data?.role,
    archived = !!projects.data?.archivedAt,
    granted = identity.admin ? permissions : capabilitiesOf({ ...projects.data, role }),
    holds = (permission: Permission) => granted.includes(permission);
  return {
    role,
    archived,
    capabilities: granted,
    canWrite: !archived && holds("ticket.write"),
    canDelete: !archived && holds("ticket.delete"),
    canAdmin: !archived && holds("project.manage"),
    canManage: holds("project.manage"),
    canManageMembers: holds("member.manage"),
    canShare: holds("sharing.manage"),
  };
}
// The name and photo for an account ID in a project: you, a member, a deleted account, or someone
// who left. The deleted-account list loads only for an ID no member has.
export function usePerson(projectId: string, id: string | null) {
  const identity = useIdentity(),
    own = id === identity.id,
    members = useQuery({ ...api.query("list_members", { projectId }), enabled: !!id && !own }),
    member = members.data?.find((person) => person.userId === id),
    deleted = useQuery({
      ...api.query("list_deleted_accounts", {}),
      enabled: !!id && !own && !!members.data && !member,
    });
  if (id === null) return { name: "Kanvil", image: undefined };
  if (own) return { name: identity.name, image: identity.image };
  return { name: memberName(members.data, deleted.data, id), image: member?.image };
}
export function ActorName({
  projectId,
  actorId,
  avatar = false,
}: {
  projectId: string;
  // Null for events the server raises on its own clock, such as due-date reminders.
  actorId: string | null;
  avatar?: boolean;
}) {
  const identity = useIdentity(),
    { name, image } = usePerson(projectId, actorId);
  return (
    <span className={avatar ? "inline-flex items-center gap-2" : ""} title={actorId ?? undefined}>
      {avatar && <UserAvatar name={name} image={image} className="size-7 text-[10px]" />}
      {actorId === identity.id ? t("shell.you") : name}
    </span>
  );
}
