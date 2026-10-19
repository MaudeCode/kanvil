import { UserAvatar } from "./components/user-avatar.tsx";
import { createContext, useContext, useEffect, useState } from "react";
import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createClient } from "@kanvil/client";
import {
  capabilitiesOf,
  infoSchema,
  memberName,
  permissions,
  type ChangeEvent,
  type Operation,
  type Permission,
  type Workspace,
} from "@kanvil/contracts";
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
// Public instance details and sign-in options, shared by signed-out and signed-in screens.
export const useInfo = () =>
  useQuery({ queryKey: ["info"], queryFn: () => api.request("/api/v1/info", infoSchema) });
// Ends the session, clears this account's cached data, and loads `next` signed out.
export async function signOut(identity: { clearPrivateData: () => void }, next = "/login") {
  const result = await auth.signOut();
  if (result.error) throw new Error(result.error.message);
  identity.clearPrivateData();
  window.location.assign(next);
}
// `before` runs ahead of the refetch, such as leaving a page whose subject the write removed.
export function useOperation<K extends Operation>(name: K, before?: () => Promise<unknown>) {
  const cache = useQueryClient();
  return useMutation({
    ...api.action(name),
    onSuccess: async () => {
      await before?.();
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
// Project-wide reads that only change on these event families; ticket traffic leaves them alone.
const settledBy: Record<string, string[]> = {
  // A role edit rewrites the stand-in role of everyone holding it.
  list_members: ["membership.", "role.", "project."],
  list_workspace_members: ["membership.", "role.", "project."],
  list_workspace_roles: ["role.", "membership.", "project."],
  list_project_roles: ["role.", "membership.", "project."],
  // An acceptance announces the new membership rather than an invitation change.
  list_invitations: ["invitation.", "membership."],
  list_project_labels: ["label.", "project."],
  // Its ticket counts move with ticket traffic.
  list_workflow_states: ["workflow.", "project.", "ticket."],
  list_workspace_labels: ["label.", "project."],
  // Its usage counts move with ticket traffic.
  list_custom_fields: ["custom_field.", "project.", "ticket."],
  list_calendar_feeds: ["calendar_feed.", "label.", "membership.", "project."],
  list_label_colors: ["label."],
  list_views: ["label.", "custom_field.", "project."],
  get_project: ["project.", "label."],
  list_project_destinations: ["destination.", "project."],
  // Personal; writes invalidate it and pending sends poll it.
  list_notification_channels: [],
  // Personal; running imports poll them instead of refreshing on each record they write.
  list_imports: [],
  get_import: [],
  // An account deletion announces itself as a membership change in every project it reached.
  list_deleted_accounts: ["membership."],
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
      {actorId === identity.id ? "You" : name}
    </span>
  );
}
