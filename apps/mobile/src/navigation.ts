import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from "@react-navigation/native-stack";
import type { NavigatorScreenParams } from "@react-navigation/native";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";
import type { TicketLayout } from "@kanvil/contracts/navigation";
import type { SearchBarCommands, SearchBarProps } from "react-native-screens";
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
  collapsedSections: Partial<Record<"all" | "planning", string[]>>;
};
// Account-owned, like the private query cache. Never persists ticket records or bulk selection.
export function createProjectContexts() {
  const entries = new Map<string, Partial<ProjectContext>>();
  const searches = new Map<string, string>();
  let cleared = false;
  return {
    get: (projectId: string) => entries.get(projectId),
    recent: () =>
      [...entries.keys()].reduceRight<string[]>((result, id) => {
        result.push(id);
        return result;
      }, []),
    touch(projectId: string) {
      if (!cleared) {
        const entry = entries.get(projectId) ?? {};
        entries.delete(projectId);
        entries.set(projectId, entry);
      }
    },
    save(projectId: string, patch: Partial<ProjectContext>) {
      if (!cleared) entries.set(projectId, { ...entries.get(projectId), ...patch });
    },
    search: (workspaceId: string, page: string) => searches.get(`${workspaceId}:${page}`) ?? "",
    saveSearch(workspaceId: string, page: string, query: string) {
      if (!cleared) searches.set(`${workspaceId}:${page}`, query);
    },
    clear() {
      cleared = true;
      entries.clear();
      searches.clear();
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

// Search has temporary disclosure choices; clearing it restores the ordinary work list.
export function useSectionDisclosure(
  query: string,
  setQuery: (value: string) => void,
  initial: Partial<Record<string, string[]>> = {},
  scope = "default",
) {
  const [normal, setNormal] = useState(() =>
    Object.fromEntries(Object.entries(initial).map(([key, ids]) => [key, new Set(ids)])),
  );
  const normalCollapsed = useMemo(() => normal[scope] ?? new Set<string>(), [normal, scope]);
  const [search, setSearch] = useState<{ query: string; scope: string; ids: Set<string> }>({
    query: "",
    scope,
    ids: new Set(),
  });
  const collapsed = query.trim()
    ? search.query === query && search.scope === scope
      ? search.ids
      : new Set<string>()
    : normalCollapsed;
  const onQuery = useCallback(
    (value: string) => {
      setQuery(value);
      setSearch({ query: value, scope, ids: new Set() });
    },
    [setQuery, scope],
  );
  const changeCollapsed = useCallback(
    (ids: Set<string>) => {
      if (query.trim()) setSearch({ query, scope, ids });
      else setNormal((previous) => ({ ...previous, [scope]: ids }));
    },
    [query, scope],
  );
  return { normalCollapsed, collapsed, onQuery, changeCollapsed };
}

// Local searches share the system's collapsed search button, including Duo rail placement.
export function useHeaderSearch(
  query: string,
  onChange: (value: string) => void,
  placeholder: string,
) {
  const [handle] = useState(() => createSearchBarHandle(query));
  const [searching, setSearching] = useState(false);
  useLayoutEffect(() => handle.updateText(query), [handle, query]);
  const options = useMemo<SearchBarProps>(
    () => ({
      ref: handle.ref,
      placement: "integratedButton",
      hideWhenScrolling: true,
      hideNavigationBar: false,
      autoCapitalize: "none",
      placeholder,
      onChangeText: (event) => onChange(event.nativeEvent.text),
      onFocus: () => setSearching(true),
      onBlur: () => setSearching(false),
      onCancelButtonPress: () => {
        handle.ref.current?.setText("");
        onChange("");
        setSearching(false);
      },
    }),
    [handle, onChange, placeholder],
  );
  const setText = useCallback(
    (value: string) => {
      handle.ref.current?.setText(value);
      onChange(value);
    },
    [handle, onChange],
  );
  return { options, setText, searching };
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
