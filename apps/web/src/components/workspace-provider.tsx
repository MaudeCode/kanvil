import { useEffect, useState, type ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { WorkspaceSelection, useAllProjects, useIdentity, useWorkspaces } from "../data.tsx";
const workspaceKey = (userId: string) => `kanvil:${userId}:workspace`;
// Makes a workspace the one the project list opens with, such as one the user just joined.
export function rememberWorkspace(userId: string, workspaceId: string) {
  try {
    localStorage.setItem(workspaceKey(userId), workspaceId);
  } catch {
    /* Selection remains usable without browser storage. */
  }
}
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const identity = useIdentity(),
    spaces = useWorkspaces(),
    projects = useAllProjects();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const key = workspaceKey(identity.id);
  const [selection, setSelection] = useState<{ id: string | null; route: string | undefined }>(
    () => {
      try {
        return { id: localStorage.getItem(key), route: undefined };
      } catch {
        return { id: null, route: undefined };
      }
    },
  );
  const projectId = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const routeWorkspace =
    pathname.match(/^\/workspaces\/([^/]+)/)?.[1] ??
    projects.data?.find((project) => project.id === projectId)?.workspaceId;
  // Remember a deep link’s workspace when returning to the project list.
  if (selection.route !== routeWorkspace)
    setSelection({ id: routeWorkspace ?? selection.id, route: routeWorkspace });
  const active =
    spaces.data?.find((workspace) => workspace.id === (routeWorkspace ?? selection.id)) ??
    spaces.data?.[0];
  const activeId = active?.id;
  useEffect(() => {
    if (activeId) rememberWorkspace(identity.id, activeId);
  }, [activeId, identity.id]);
  return (
    <WorkspaceSelection
      value={{
        active,
        workspaces: spaces.data ?? [],
        pending: spaces.isPending,
        error: spaces.error,
        select: (id) => setSelection({ id, route: routeWorkspace }),
      }}
    >
      {children}
    </WorkspaceSelection>
  );
}
