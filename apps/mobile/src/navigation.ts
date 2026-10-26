import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from "@react-navigation/native-stack";
import type { NavigatorScreenParams } from "@react-navigation/native";
import { createContext, useContext } from "react";
import type { TicketLayout } from "@kanvil/contracts/navigation";
import type { SearchBarCommands } from "react-native-screens";
import type { Input } from "@kanvil/contracts";
export type Routes = {
  Home: undefined;
  Tickets: {
    projectId: string;
    name?: string;
    layout?: TicketLayout;
    collection?: "all" | "planning";
    viewId?: string;
  };
  Ticket: { projectId: string; ticketId: string };
  Edit: { projectId: string; ticketId?: string };
  WorkspaceSettings: { workspaceId: string; section?: string };
  ProjectSettings: { projectId: string; section?: string };
  AccountSettings: { section: string };
  Administration: { section?: string };
  CreateWorkspace: undefined;
  Import: { workspaceId: string };
};
export type TabRoutes = {
  Projects: NavigatorScreenParams<Routes>;
  Work: NavigatorScreenParams<Routes>;
  Inbox: NavigatorScreenParams<Routes>;
  Search: NavigatorScreenParams<Routes>;
  Settings: NavigatorScreenParams<Routes>;
};
export type ScreenProps<K extends keyof Routes> = NativeStackScreenProps<Routes, K>;
// Independent sheets target the browsing stack that opened them.
export const MainNavigation = createContext<Pick<
  NativeStackNavigationProp<Routes>,
  "navigate" | "goBack" | "dispatch"
> | null>(null);
export function useAppNavigation() {
  const navigation = useContext(MainNavigation);
  if (!navigation) throw new Error("The main navigation is unavailable");
  return navigation;
}
export type ProjectContext = {
  location: Routes["Tickets"];
  filters: Omit<Input<"list_tickets">, "projectId" | "limit" | "offset">;
  query: string;
  anchor: Date;
  selectedTicketId: string | undefined;
  secondaryVisible: boolean;
  scrollOffset: number;
};
// Account-owned, like the private query cache. Never persists ticket records or bulk selection.
export function createProjectContexts() {
  const entries = new Map<string, Partial<ProjectContext>>();
  let cleared = false;
  return {
    get: (projectId: string) => entries.get(projectId),
    save(projectId: string, patch: Partial<ProjectContext>) {
      if (!cleared) entries.set(projectId, { ...entries.get(projectId), ...patch });
    },
    clear() {
      cleared = true;
      entries.clear();
    },
  };
}
export const ProjectNavigation = createContext<{
  currentProjectId: string | undefined;
  showPicker: () => void;
  selectProject: (projectId: string, settings?: boolean) => void;
  selectWorkspace: (workspaceId: string) => void;
  workspaceSettings: (workspaceId: string) => void;
  createWorkspace: () => void;
  openTicket: (params: Routes["Ticket"]) => void;
  contexts: ReturnType<typeof createProjectContexts>;
} | null>(null);
export function useProjectNavigation() {
  const value = useContext(ProjectNavigation);
  if (!value) throw new Error("Project navigation is unavailable");
  return value;
}

declare global {
  namespace ReactNavigation {
    interface RootParamList extends Routes {}
  }
}

// Native headers mount after setOptions. Restore text when their imperative handle connects,
// rather than depending on a screen effect that may run before the control exists.
export function createSearchBarHandle(initialText: string) {
  let text = initialText,
    commands: SearchBarCommands | null = null,
    initialized = false;
  return {
    ref: {
      get current() {
        return commands;
      },
      set current(next: SearchBarCommands | null) {
        commands = next;
        // Screens refreshes its imperative handle on render. Restore only on a new control,
        // otherwise a query update can overwrite characters still being typed natively.
        if (next && !initialized) {
          initialized = true;
          next.setText(text);
        }
        if (!next)
          queueMicrotask(() => {
            if (!commands) initialized = false;
          });
      },
    },
    updateText(value: string) {
      text = value;
    },
  };
}
