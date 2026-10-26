import { hasAdminRole } from "@kanvil/contracts";
import { createHeaderAction, projectHeaderItems } from "./navigation-actions.tsx";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Alert, AppState, View, useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Network from "expo-network";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
  useQuery,
} from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createPrivatePersister, shouldPersistQuery } from "./private-cache.ts";
import { restoreAppearance } from "./theme.ts";
import { z } from "zod";
import {
  NavigationContainer,
  DarkTheme,
  DefaultTheme,
  useNavigationContainerRef,
  TabActions,
  type NavigationState,
  type PathConfig,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import { createNativeBottomTabNavigator } from "@react-navigation/bottom-tabs/unstable";
import { authResult, infoSchema, okSchema } from "@kanvil/contracts";
import {
  connect,
  type Connection,
  ConnectionContext,
  Identity,
  useConnection,
  useIdentity,
  useLive,
  WorkspaceProvider,
  ClockProvider,
  LiveStatus,
  useWorkspace,
  useAllProjects,
} from "./data.tsx";
import {
  nativeHeaderOptions,
  Body,
  Brand,
  Button,
  ErrorNotice,
  Field,
  Heading,
  Loading,
  Screen,
  Sheet,
  usePalette,
} from "./ui.tsx";
import { Projects, Tickets } from "./lists.tsx";
import { MyWork, Search } from "./work.tsx";
import { TicketDetail } from "./ticket-detail.tsx";
import { EditTicket } from "./editor.tsx";
import { Inbox, Settings } from "./settings.tsx";
import {
  MainNavigation,
  ProjectNavigation,
  createProjectContexts,
  useProjectNavigation,
  type Routes,
  type TabRoutes,
} from "./navigation.ts";
import { usePushNavigation } from "./push.tsx";
import { LocaleRoot, startLocale } from "./locale.tsx";
import {
  WorkspaceSettings,
  ProjectSettings,
  CreateWorkspace,
  Administration,
  ImportProject,
} from "./management.tsx";
import { formatNumber, t } from "@kanvil/contracts/i18n";

const Stack = createNativeStackNavigator<Routes>();
const Tabs = createNativeBottomTabNavigator<TabRoutes>();
const projectPaths: PathConfig<Routes> = {
  initialRouteName: "Home",
  screens: {
    Home: "",
    Tickets: "projects/:projectId",
    Ticket: "projects/:projectId/tickets/:ticketId",
  },
};
const tabPaths = {
  initialRouteName: "Projects",
  screens: { Projects: projectPaths },
} satisfies PathConfig<TabRoutes>;
const publicCache = new QueryClient();
// The language root remounts the app; the account's last navigation state brings it back to the
// same screen instead of the first tab.
const navigationStates = new Map<string, NavigationState>();
export default function App() {
  const color = usePalette();
  const [connection, setConnection] = useState<Connection>(),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState<unknown>();
  useEffect(() => {
    let mounted = true;
    // The first screen already reads the chosen language.
    void Promise.all([startLocale(), restoreAppearance(), AsyncStorage.getItem("kanvil:server")])
      .then(async ([, , url]) => {
        if (url) {
          const next = await connect(url);
          if (mounted) setConnection(next);
        }
      })
      .catch(setError)
      .finally(() => {
        if (mounted) setLoaded(true);
      });
    const focus = AppState.addEventListener("change", (state) =>
      focusManager.setFocused(state === "active"),
    );
    const online = Network.addNetworkStateListener((state) =>
      onlineManager.setOnline(state.isConnected ?? true),
    );
    return () => {
      mounted = false;
      focus.remove();
      online.remove();
    };
  }, []);
  async function setServer(url?: string) {
    if (!url) {
      await AsyncStorage.removeItem("kanvil:server");
      setConnection(undefined);
      return;
    }
    const next = await connect(url);
    await AsyncStorage.setItem("kanvil:server", next.baseUrl);
    setConnection(next);
    setError(undefined);
  }
  return (
    <SafeAreaProvider style={{ backgroundColor: color.surface }}>
      {/* oxlint-disable-next-line react/style-prop-object -- Expo StatusBar takes a color mode string, not a View style. */}
      <StatusBar style="auto" />
      <LocaleRoot>
        {!loaded ? (
          <Loading />
        ) : connection ? (
          <ConnectionContext key={connection.baseUrl} value={connection}>
            <Session onDisconnect={() => setServer()} />
          </ConnectionContext>
        ) : (
          <ServerSetup onConnect={setServer} error={error} />
        )}
      </LocaleRoot>
    </SafeAreaProvider>
  );
}
function ServerSetup({
  onConnect,
  error,
}: {
  onConnect: (url: string) => Promise<void>;
  error: unknown;
}) {
  const [url, setUrl] = useState(""),
    [failure, setFailure] = useState<unknown>(),
    [pending, setPending] = useState(false);
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Brand />
        <Field
          label={t("native.server.url")}
          value={url}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://kanvil.example.com"
          onChangeText={setUrl}
        />
        <ErrorNotice error={failure ?? error} />
        <Button
          title={t("native.server.connect")}
          primary
          disabled={pending || !url.trim()}
          onPress={() => {
            setPending(true);
            void onConnect(url)
              .catch(setFailure)
              .finally(() => setPending(false));
          }}
        />
      </Screen>
    </SafeAreaView>
  );
}
function Session({ onDisconnect }: { onDisconnect: () => Promise<void> }) {
  const { auth } = useConnection();
  // oxlint-disable-next-line react/hooks -- The provider is keyed by immutable server origin, so this auth client and its hook stay fixed for this component lifetime.
  const session = auth.useSession();
  if (session.isPending && !session.data) return <Loading />;
  return session.data ? (
    <PrivateWorkspace
      key={`${session.data.user.id}:${session.data.user.role ?? "user"}`}
      user={session.data.user}
      onDisconnect={onDisconnect}
    />
  ) : (
    <QueryClientProvider client={publicCache}>
      <Login onDisconnect={onDisconnect} />
    </QueryClientProvider>
  );
}
function Login({ onDisconnect }: { onDisconnect: () => Promise<void> }) {
  const { api, auth, baseUrl } = useConnection();
  const info = useQuery({
    queryKey: ["info", baseUrl],
    queryFn: () => api.request("/api/v1/info", infoSchema),
  });
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState(""),
    [token, setToken] = useState(""),
    [code, setCode] = useState(""),
    [flow, setFlow] = useState<"code" | "reset" | null>(null),
    [sent, setSent] = useState(false),
    [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false);
  async function attempt(action: () => Promise<void>) {
    setError(undefined);
    setPending(true);
    try {
      await action();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  const login = (provider?: string) =>
    attempt(async () => {
      if (info.data?.setupRequired)
        await api.request("/api/v1/setup", okSchema, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, token, email, password }),
        });
      authResult(
        provider
          ? await auth.signIn.social({ provider, callbackURL: "kanvil://auth/callback" })
          : await auth.signIn.email({ email, password }),
      );
      await auth.getSession();
    });
  async function sendCode() {
    authResult(
      flow === "reset"
        ? await auth.emailOtp.requestPasswordReset({ email })
        : await auth.emailOtp.sendVerificationOtp({ email, type: "sign-in" }),
    );
    setSent(true);
  }
  const submitCode = () =>
    attempt(async () => {
      if (!sent) return sendCode();
      if (flow === "code") {
        authResult(await auth.signIn.emailOtp({ email, otp: code }));
        await auth.getSession();
        return;
      }
      authResult(await auth.emailOtp.resetPassword({ email, otp: code, password }));
      setFlow(null);
      setSent(false);
      setCode("");
      setPassword("");
      Alert.alert(t("common.signIn.resetDoneTitle"), t("common.signIn.resetDoneBody"));
    });
  if (info.isPending)
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Loading />
      </SafeAreaView>
    );
  const setup = info.data?.setupRequired,
    emailField = (
      <Field
        label={t("native.login.email")}
        value={email}
        onChangeText={setEmail}
        editable={!sent}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="username"
      />
    );
  if (flow)
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Screen>
          <Brand />
          <Heading>
            {flow === "reset" ? t("common.signIn.resetTitle") : t("common.signIn.codeTitle")}
          </Heading>
          {sent && <Body muted>{t("common.signIn.codeSent", { email })}</Body>}
          <ErrorNotice error={error} />
          {emailField}
          {sent && (
            <Field
              label={t("common.signIn.code")}
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              maxLength={6}
            />
          )}
          {sent && flow === "reset" && (
            <Field
              label={t("common.signIn.newPassword")}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="new-password"
              textContentType="newPassword"
            />
          )}
          <Button
            title={
              !sent
                ? t("common.signIn.sendCode")
                : flow === "reset"
                  ? t("common.signIn.resetTitle")
                  : t("native.login.signIn")
            }
            primary
            disabled={
              pending ||
              !email ||
              (sent && code.length !== 6) ||
              (sent && flow === "reset" && password.length < 12)
            }
            onPress={() => {
              void submitCode();
            }}
          />
          {sent && (
            <Button
              title={t("common.signIn.resend")}
              disabled={pending}
              onPress={() => {
                void attempt(sendCode);
              }}
            />
          )}
          <Button
            title={t("common.signIn.back")}
            disabled={pending}
            onPress={() => {
              setError(undefined);
              setFlow(null);
              setSent(false);
              setCode("");
            }}
          />
        </Screen>
      </SafeAreaView>
    );
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Brand />
        <Heading>{setup ? t("native.login.setupTitle") : t("native.login.signIn")}</Heading>
        <Body muted>{baseUrl}</Body>
        <ErrorNotice error={error ?? info.error} />
        {setup && (
          <>
            <Field
              label={t("native.login.name")}
              value={name}
              onChangeText={setName}
              autoComplete="name"
            />
            <Field
              label={t("native.login.setupToken")}
              autoComplete="off"
              textContentType="none"
              value={token}
              onChangeText={setToken}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
          </>
        )}
        {(setup || info.data?.authentication.emailPasswordEnabled) && (
          <>
            {emailField}
            <Field
              label={t("native.login.password")}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="password"
              textContentType="password"
            />
            <Button
              title={
                pending
                  ? t("native.login.signingIn")
                  : setup
                    ? t("native.login.createAccount")
                    : t("native.login.signIn")
              }
              primary
              disabled={pending || !email || password.length < 12}
              onPress={() => {
                void login();
              }}
            />
          </>
        )}
        {!setup &&
          info.data?.providers.map((provider) => (
            <Button
              key={provider.id}
              title={t("native.login.signInWith", { provider: provider.name })}
              disabled={pending}
              onPress={() => {
                void login(provider.id);
              }}
            />
          ))}
        {!setup && info.data?.emailCodes && (
          <>
            <Button
              title={t("common.signIn.emailCode")}
              disabled={pending}
              onPress={() => {
                setError(undefined);
                setFlow("code");
              }}
            />
            <Button
              title={t("common.signIn.forgot")}
              disabled={pending}
              onPress={() => {
                setError(undefined);
                setPassword("");
                setFlow("reset");
              }}
            />
          </>
        )}
        <Button
          title={t("native.server.change")}
          onPress={() => {
            void onDisconnect().catch(setError);
          }}
        />
      </Screen>
    </SafeAreaView>
  );
}
function PrivateWorkspace({
  user,
  onDisconnect,
}: {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null | undefined;
    role?: string | null | undefined;
  };
  onDisconnect: () => Promise<void>;
}) {
  const { prefix, baseUrl } = useConnection();
  const [cache] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15000, gcTime: 7 * 86400000, retry: 1 },
          mutations: { networkMode: "always", retry: false },
        },
      }),
  );
  const [contexts] = useState(createProjectContexts);
  const [persistence] = useState(() =>
    createPrivatePersister(AsyncStorage, `${prefix}:${user.id}:cache`),
  );
  useEffect(
    () => () => {
      persistence.pause();
      contexts.clear();
      cache.clear();
    },
    [cache, persistence, contexts],
  );
  return (
    <Identity
      value={{
        ...user,
        image: user.image ?? null,
        admin: hasAdminRole(user.role),
        clearPrivateData: async () => {
          persistence.pause();
          contexts.clear();
          cache.clear();
          navigationStates.delete(`${baseUrl}:${user.id}`);
          await persistence.clear();
          const keys = await AsyncStorage.getAllKeys();
          await AsyncStorage.multiRemove(
            keys.filter((key) => key.startsWith(`${prefix}:${user.id}:`)),
          );
        },
      }}
    >
      <PersistQueryClientProvider
        client={cache}
        persistOptions={{
          persister: persistence.persister,
          maxAge: 7 * 86400000,
          buster: `kanvil-v2:${user.role ?? "user"}`,
          dehydrateOptions: {
            shouldDehydrateMutation: () => false,
            shouldDehydrateQuery: shouldPersistQuery,
          },
        }}
      >
        <ClockProvider>
          <WorkspaceProvider>
            <Navigation onDisconnect={onDisconnect} contexts={contexts} />
          </WorkspaceProvider>
        </ClockProvider>
      </PersistQueryClientProvider>
    </Identity>
  );
}
function Navigation({
  onDisconnect,
  contexts,
}: {
  onDisconnect: () => Promise<void>;
  contexts: ReturnType<typeof createProjectContexts>;
}) {
  const navigationRef = useNavigationContainerRef<TabRoutes>();
  const [workspaceCreation, setWorkspaceCreation] = useState<"waiting" | "ready">();
  const [picker, setPicker] = useState(false),
    [currentProjectId, setCurrentProjectId] = useState<string>();
  const openTicket = useCallback(
    (params: Routes["Ticket"]) => {
      navigationRef.navigate("Projects", { screen: "Ticket", params, initial: false });
    },
    [navigationRef],
  );
  // Present a new modal only after the picker's native controller has returned and unmounted.
  useEffect(() => {
    if (workspaceCreation === "ready") {
      navigationRef.navigate("Projects", { screen: "CreateWorkspace", initial: false });
    }
  }, [workspaceCreation, navigationRef]);
  const onReady = usePushNavigation(navigationRef, openTicket);
  const connection = useLive(),
    color = usePalette(),
    dark = useColorScheme() === "dark",
    { baseUrl } = useConnection(),
    owner = `${baseUrl}:${useIdentity().id}`;
  const [initialState] = useState(() => navigationStates.get(owner));
  const { active: activeWorkspace, select: selectWorkspace } = useWorkspace(),
    projects = useAllProjects();
  const followRoute = useCallback(() => {
    if (!navigationRef.isReady()) return;
    const projectId = z
      .object({ projectId: z.string() })
      .safeParse(navigationRef.getCurrentRoute()?.params).data?.projectId;
    const project = projects.data?.find(
      (item) => item.id === projectId || item.key === projectId?.toUpperCase(),
    );
    if (project) {
      contexts.touch(project.id);
      setCurrentProjectId(project.id);
      if (project.workspaceId !== activeWorkspace?.id) selectWorkspace(project.workspaceId);
    }
  }, [projects.data, activeWorkspace?.id, selectWorkspace, navigationRef, contexts]);
  useEffect(followRoute, [followRoute]);
  const switchDestination = useCallback(
    (projectId?: string, settings = false) => {
      if (!navigationRef.isReady()) return;
      const currentId = z
        .object({ projectId: z.string() })
        .safeParse(navigationRef.getCurrentRoute()?.params).data?.projectId;
      const current = projects.data?.find(
        (item) => item.id === currentId || item.key === currentId?.toUpperCase(),
      );
      if (projectId) contexts.touch(projectId);
      if (projectId && !settings && current?.id === projectId) {
        setPicker(false);
        return;
      }
      const tabs = navigationRef.getRootState();
      const stack = tabs?.routes.find((item) => item.name === "Projects")?.state;
      const project = projects.data?.find((item) => item.id === projectId);
      const params = projectId
        ? {
            ...contexts.get(projectId)?.location,
            projectId,
            ...(project ? { name: project.name } : {}),
          }
        : undefined;
      const homeKey = stack?.routes.find((item) => item.name === "Home")?.key;
      const destination = {
        index: projectId ? (settings ? 2 : 1) : 0,
        routes: [
          { name: "Home", ...(homeKey ? { key: homeKey } : {}) },
          ...(params ? [{ name: "Tickets", params }] : []),
          ...(params && settings ? [{ name: "ProjectSettings", params: { projectId } }] : []),
        ],
      };
      if (stack?.key) {
        navigationRef.dispatch({
          type: "RESET",
          payload: destination,
          target: stack.key,
        });
        navigationRef.dispatch({
          ...TabActions.jumpTo("Projects"),
          ...(tabs?.key ? { target: tabs.key } : {}),
        });
      } else {
        navigationRef.navigate("Projects", { state: destination });
      }
      setCurrentProjectId(projectId);
      if (projectId) setPicker(false);
      if (project) selectWorkspace(project.workspaceId);
    },
    [navigationRef, projects.data, contexts, selectWorkspace],
  );
  const switchWorkspace = useCallback(
    (workspaceId: string) => {
      switchDestination();
      const tabs = navigationRef.getRootState();
      for (const tab of tabs?.routes ?? []) {
        if (tab.name !== "Projects" && tab.state?.key)
          navigationRef.dispatch({
            type: "RESET",
            target: tab.state.key,
            payload: { index: 0, routes: [{ name: "Home" }] },
          });
      }
      selectWorkspace(workspaceId);
    },
    [switchDestination, selectWorkspace, navigationRef],
  );
  const theme = {
    ...(dark ? DarkTheme : DefaultTheme),
    colors: {
      ...(dark ? DarkTheme.colors : DefaultTheme.colors),
      primary: color.accent,
      background: color.background,
      card: color.surface,
      text: color.foreground,
      border: color.line,
    },
  };
  return (
    <ProjectNavigation
      value={{
        currentProjectId,
        showPicker: () => setPicker(true),
        selectProject: switchDestination,
        selectWorkspace: switchWorkspace,
        openTicket,
        contexts,
        workspaceSettings: (workspaceId) => {
          setPicker(false);
          navigationRef.navigate("Projects", {
            screen: "WorkspaceSettings",
            params: { workspaceId },
            initial: false,
          });
        },
        createWorkspace: () => {
          setWorkspaceCreation("waiting");
          setPicker(false);
        },
      }}
    >
      <NavigationContainer
        ref={navigationRef}
        onReady={onReady}
        {...(initialState ? { initialState } : {})}
        onStateChange={(state) => {
          followRoute();
          navigationStates.clear();
          if (state) navigationStates.set(owner, state);
        }}
        theme={theme}
        linking={{
          prefixes: ["kanvil://", baseUrl],
          filter: (url) => !url.startsWith("kanvil://auth/"),
          config: tabPaths,
        }}
      >
        <View style={{ flex: 1, backgroundColor: color.surface }}>
          <LiveStatus value={connection}>
            <Home onDisconnect={onDisconnect} />
            <Sheet
              title={t("shell.page.projects")}
              open={picker}
              onClose={() => setPicker(false)}
              onDismissed={() =>
                setWorkspaceCreation((pending) => (pending === "waiting" ? "ready" : pending))
              }
              scroll={false}
            >
              <Projects picker />
            </Sheet>
          </LiveStatus>
        </View>
      </NavigationContainer>
    </ProjectNavigation>
  );
}
function HomeProjects() {
  const workspace = useWorkspace();
  return <Projects key={workspace.active?.id} />;
}
function BrowsingLayout({
  children,
  navigation,
}: {
  children: ReactNode;
  navigation: Pick<NativeStackNavigationProp<Routes>, "navigate" | "goBack" | "dispatch">;
}) {
  return <MainNavigation value={navigation}>{children}</MainNavigation>;
}
function BrowsingStack({
  tab,
  onDisconnect,
}: {
  tab: keyof TabRoutes;
  onDisconnect: () => Promise<void>;
}) {
  const color = usePalette(),
    projectNavigation = useProjectNavigation(),
    workspace = useWorkspace();
  const titles = {
    Projects: t("shell.page.projects"),
    Work: t("shell.page.myWork"),
    Inbox: t("native.screen.inbox"),
    Search: t("shell.page.search"),
    Settings: t("native.screen.settings"),
  };
  return (
    <Stack.Navigator
      screenLayout={BrowsingLayout}
      screenOptions={nativeHeaderOptions({
        headerShadowVisible: false,
        headerTintColor: color.accent,
        headerTitleStyle: { fontSize: 17, fontWeight: "600" },
        headerBackButtonDisplayMode: "minimal",
        headerBackVisible: true,
        contentStyle: { backgroundColor: color.surface },
        unstable_headerLeftItems: () =>
          projectHeaderItems(projectNavigation.showPicker, t("native.navigation.switchProject")),
      })}
    >
      <Stack.Screen name="Home" options={{ title: titles[tab] }}>
        {() =>
          tab === "Projects" ? (
            <HomeProjects />
          ) : tab === "Work" ? (
            <MyWork key={workspace.active?.id} />
          ) : tab === "Inbox" ? (
            <Inbox />
          ) : tab === "Search" ? (
            <Search key={workspace.active?.id} />
          ) : (
            <Settings onDisconnect={onDisconnect} />
          )
        }
      </Stack.Screen>
      <Stack.Group
        screenOptions={({ navigation }) =>
          nativeHeaderOptions({
            presentation: "modal",
            headerBackVisible: false,
            unstable_headerLeftItems: () => [
              createHeaderAction(t("common.action.cancel"), () => navigation.goBack(), {
                type: "sfSymbol",
                name: "xmark",
              }),
            ],
          })
        }
      >
        <Stack.Screen
          name="Edit"
          component={EditTicket}
          options={({ route }) => ({
            title: route.params.ticketId
              ? t("native.screen.editTicket")
              : t("native.screen.newTicket"),
          })}
        />
        <Stack.Screen
          name="CreateWorkspace"
          component={CreateWorkspace}
          options={{ title: t("shell.workspace.new") }}
        />
      </Stack.Group>
      <Stack.Screen name="Tickets" getId={({ params }) => params.projectId}>
        {(props) => (
          <Tickets
            key={`${props.route.params.projectId}:${props.route.params.collection ?? "all"}`}
            {...props}
          />
        )}
      </Stack.Screen>
      <Stack.Screen
        name="Ticket"
        component={TicketDetail}
        options={{ title: t("native.screen.ticket") }}
      />
      <Stack.Screen
        name="WorkspaceSettings"
        component={WorkspaceSettings}
        options={{ title: t("shell.workspace.settings") }}
      />
      <Stack.Screen
        name="ProjectSettings"
        component={ProjectSettings}
        options={{ title: t("shell.settingsNav.projectSettings") }}
      />
      <Stack.Screen name="AccountSettings" options={{ title: t("shell.page.settings") }}>
        {({ route }) => <Settings section={route.params.section} onDisconnect={onDisconnect} />}
      </Stack.Screen>
      <Stack.Screen
        name="Administration"
        component={Administration}
        options={{ title: t("shell.settingsNav.administration") }}
      />
      <Stack.Screen
        name="Import"
        component={ImportProject}
        options={{ title: t("admin.import.title") }}
      />
    </Stack.Navigator>
  );
}
function Home({ onDisconnect }: { onDisconnect: () => Promise<void> }) {
  const workspace = useWorkspace(),
    color = usePalette();
  const { api } = useConnection(),
    projects = useAllProjects();
  const notifications = useQuery(api.notifications());
  const allowed = new Set(
    projects.data
      ?.filter((project) => project.workspaceId === workspace.active?.id)
      .map((project) => project.id),
  );
  const unread =
    notifications.data?.filter((entry) => !entry.readAt && allowed.has(entry.event.projectId))
      .length ?? 0;
  if (workspace.pending) return <Loading />;
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: color.accent,
        tabBarMinimizeBehavior: "none",
        tabBarControllerMode: "tabBar",
      }}
    >
      <Tabs.Screen
        name="Projects"
        options={{
          title: t("shell.page.projects"),
          tabBarIcon: { type: "sfSymbol", name: "folder" },
        }}
      >
        {() => <BrowsingStack tab="Projects" onDisconnect={onDisconnect} />}
      </Tabs.Screen>
      <Tabs.Screen
        name="Work"
        options={{
          title: t("shell.page.myWork"),
          tabBarIcon: { type: "sfSymbol", name: "checklist" },
        }}
      >
        {() => <BrowsingStack tab="Work" onDisconnect={onDisconnect} />}
      </Tabs.Screen>
      <Tabs.Screen
        name="Inbox"
        options={{
          title: t("native.screen.inbox"),
          ...(unread ? { tabBarBadge: formatNumber(unread) } : {}),
          tabBarIcon: { type: "sfSymbol", name: "tray" },
        }}
      >
        {() => <BrowsingStack tab="Inbox" onDisconnect={onDisconnect} />}
      </Tabs.Screen>
      <Tabs.Screen
        name="Search"
        options={{
          title: t("shell.page.search"),
          tabBarIcon: { type: "sfSymbol", name: "magnifyingglass" },
        }}
      >
        {() => <BrowsingStack tab="Search" onDisconnect={onDisconnect} />}
      </Tabs.Screen>
      <Tabs.Screen
        name="Settings"
        options={{
          title: t("native.screen.settings"),
          tabBarIcon: { type: "sfSymbol", name: "gearshape" },
        }}
      >
        {() => <BrowsingStack tab="Settings" onDisconnect={onDisconnect} />}
      </Tabs.Screen>
    </Tabs.Navigator>
  );
}
