import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from "@react-navigation/native-stack";
import type { NavigatorScreenParams } from "@react-navigation/native";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { projectSections, type TicketLayout } from "@kanvil/contracts/navigation";
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
export function projectSettingsSections(access: { canManage: boolean; canShare: boolean }) {
  return projectSections.filter(
    (section) =>
      (section !== "integrations" && section !== "calendar") ||
      (section === "integrations" && access.canManage) ||
      (section === "calendar" && access.canShare),
  );
}
export type ScreenProps<K extends keyof Routes> = NativeStackScreenProps<Routes, K>;
// Each settings page owns its native scroll view, momentum and unsaved form state.
export function settingsRouteId({
  params,
}: {
  params:
    | Routes["AccountSettings"]
    | Routes["WorkspaceSettings"]
    | Routes["ProjectSettings"]
    | Routes["Administration"];
}) {
  return JSON.stringify([
    "projectId" in params ? params.projectId : "workspaceId" in params ? params.workspaceId : null,
    params.section ?? "general",
  ]);
}
export const SettingsSidebarVisible = createContext(false);
export const WideNavigation = createContext(false);
// Independent sheets target the browsing stack that opened them.
export const MainNavigation = createContext<Pick<
  NativeStackNavigationProp<Routes>,
  "navigate" | "goBack" | "dispatch"
> | null>(null);
// A native sheet must finish dismissing before UIKit can present a root editor modal.
export const AfterSheet = createContext<((action: () => void) => void) | null>(null);
export function useAppNavigation() {
  const navigation = useContext(MainNavigation),
    afterSheet = useContext(AfterSheet);
  if (!navigation) throw new Error("The main navigation is unavailable");
  return useMemo<typeof navigation>(() => {
    if (!afterSheet) return navigation;
    return {
      ...navigation,
      navigate: (...args) => {
        const route = args[0],
          name = typeof route === "string" ? route : route?.name;
        const action = () => {
          Reflect.apply(navigation.navigate, navigation, args);
        };
        if (name === "Edit") afterSheet(action);
        else action();
      },
    };
  }, [navigation, afterSheet]);
}
export type ProjectContext = {
  location: Routes["Tickets"];
  filters: Omit<Input<"list_tickets">, "projectId" | "limit" | "offset">;
  query: string;
  anchor: Date;
  selectedTicketId: string | undefined;
  secondaryVisible: boolean;
  sidebarHidden: boolean;
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

// Local search is requested from native actions and collapses with its owning scroller.
export function useHeaderSearch(
  query: string,
  onChange: (value: string) => void,
  placeholder: string,
  persistent = false,
) {
  const wide = useContext(WideNavigation);
  const [handle] = useState(() => createSearchBarHandle(query));
  const [searching, setSearching] = useState(false),
    [visible, setVisible] = useState(false),
    focused = useRef(false);
  useLayoutEffect(() => handle.updateText(query), [handle, query]);
  useLayoutEffect(() => {
    if (!visible) return undefined;
    // UIKit attaches the search controller after the navigation options commit.
    // A ref can exist before its search field is able to become first responder.
    const frame = requestAnimationFrame(() => handle.focus());
    return () => cancelAnimationFrame(frame);
  }, [visible, handle]);
  const options = useMemo<SearchBarProps>(
    () => ({
      ref: handle.ref,
      placement: wide ? "integrated" : "stacked",
      hideWhenScrolling: !persistent && !wide,
      hideNavigationBar: !wide,
      autoCapitalize: "none",
      autoFocus: true,
      placeholder,
      onChangeText: (event) => onChange(event.nativeEvent.text),
      onFocus: () => {
        focused.current = true;
        setSearching(true);
      },
      onBlur: () => {
        setSearching(false);
        if (focused.current) {
          focused.current = false;
          setVisible(false);
        }
      },
      onCancelButtonPress: () => {
        handle.ref.current?.setText("");
        onChange("");
        setSearching(false);
        setVisible(false);
      },
    }),
    [handle, onChange, placeholder, persistent, wide],
  );
  const setText = useCallback(
    (value: string) => {
      handle.ref.current?.setText(value);
      onChange(value);
    },
    [handle, onChange],
  );
  const open = useCallback(() => {
    handle.focus();
    setVisible(true);
  }, [handle]);
  return { options: visible || persistent ? options : undefined, setText, searching, open };
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
    initialized = false,
    focusRequested = false;
  return {
    focus() {
      if (commands) commands.focus();
      else focusRequested = true;
    },
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
        if (next && focusRequested) {
          focusRequested = false;
          next.focus();
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
