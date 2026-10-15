import { hasAdminRole } from "@kanvil/contracts";
import { createHeaderAction } from "./navigation-actions.tsx";
import { useEffect, useState } from "react";
import { AppState, View, useColorScheme } from "react-native";
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
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import {
  NavigationContainer,
  DarkTheme,
  DefaultTheme,
  useNavigationContainerRef,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import Ionicons from "@expo/vector-icons/Ionicons";
import { infoSchema, okSchema } from "@kanvil/contracts";
import {
  connect,
  type Connection,
  ConnectionContext,
  Identity,
  useConnection,
  useLive,
} from "./data.tsx";
import {
  Body,
  Brand,
  Button,
  ErrorNotice,
  Field,
  Heading,
  Loading,
  Screen,
  usePalette,
} from "./ui.tsx";
import { Projects, Tickets } from "./lists.tsx";
import { TicketDetail } from "./ticket-detail.tsx";
import { EditTicket } from "./editor.tsx";
import { Inbox, Settings } from "./settings.tsx";
import type { Routes } from "./navigation.ts";
import { usePushNavigation } from "./push.tsx";

const Stack = createNativeStackNavigator<Routes>();
const Tabs = createBottomTabNavigator<{
  Projects: undefined;
  Inbox: undefined;
  Settings: undefined;
}>();
const publicCache = new QueryClient();
export default function App() {
  const [connection, setConnection] = useState<Connection>(),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState<unknown>();
  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem("kanvil:server")
      .then(async (url) => {
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
    <SafeAreaProvider>
      {/* oxlint-disable-next-line react/style-prop-object -- Expo StatusBar takes a color mode string, not a View style. */}
      <StatusBar style="auto" />
      {!loaded ? (
        <Loading />
      ) : connection ? (
        <ConnectionContext key={connection.baseUrl} value={connection}>
          <Session onDisconnect={() => setServer()} />
        </ConnectionContext>
      ) : (
        <ServerSetup onConnect={setServer} error={error} />
      )}
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
          label="Server URL"
          value={url}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://kanvil.example.com"
          onChangeText={setUrl}
        />
        <ErrorNotice error={failure ?? error} />
        <Button
          title="Connect"
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
    [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false);
  async function login(oidc = false) {
    setError(undefined);
    setPending(true);
    try {
      if (info.data?.setupRequired)
        await api.request("/api/v1/setup", okSchema, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, token, email, password }),
        });
      const result = oidc
        ? await auth.signIn.social({ provider: "oidc", callbackURL: "kanvil://auth/callback" })
        : await auth.signIn.email({ email, password });
      if (result.error) throw new Error(result.error.message);
      await auth.getSession();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  if (info.isPending)
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <Loading />
      </SafeAreaView>
    );
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <Screen>
        <Brand />
        <Heading>{info.data?.setupRequired ? "Create your owner account" : "Sign in"}</Heading>
        <Body muted>{baseUrl}</Body>
        <ErrorNotice error={error ?? info.error} />
        {info.data?.setupRequired && (
          <>
            <Field label="Name" value={name} onChangeText={setName} autoComplete="name" />
            <Field
              label="Setup token"
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
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="username"
        />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="password"
          textContentType="password"
        />
        <Button
          title={pending ? "Signing in…" : info.data?.setupRequired ? "Create account" : "Sign in"}
          primary
          disabled={pending || !email || password.length < 12}
          onPress={() => {
            void login();
          }}
        />
        {info.data?.oidc && !info.data.setupRequired && (
          <Button
            title={`Sign in with ${info.data.oidc.name}`}
            disabled={pending}
            onPress={() => {
              void login(true);
            }}
          />
        )}
        <Button
          title="Change server"
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
  user: { id: string; name: string; email: string; role?: string | null | undefined };
  onDisconnect: () => Promise<void>;
}) {
  const { prefix } = useConnection();
  const [cache] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15000, gcTime: 7 * 86400000, retry: 1 },
          mutations: { networkMode: "always", retry: false },
        },
      }),
  );
  const [persister] = useState(() =>
    createAsyncStoragePersister({ storage: AsyncStorage, key: `${prefix}:${user.id}:cache` }),
  );
  return (
    <Identity value={{ ...user, admin: hasAdminRole(user.role) }}>
      <PersistQueryClientProvider
        client={cache}
        persistOptions={{
          persister,
          maxAge: 7 * 86400000,
          buster: `kanvil-v2:${user.role ?? "user"}`,
          dehydrateOptions: {
            shouldDehydrateMutation: () => false,
            shouldDehydrateQuery: (query) =>
              query.state.status === "success" && query.queryKey[0] === "kanvil",
          },
        }}
      >
        <Navigation onDisconnect={onDisconnect} />
      </PersistQueryClientProvider>
    </Identity>
  );
}
function Navigation({ onDisconnect }: { onDisconnect: () => Promise<void> }) {
  const navigationRef = useNavigationContainerRef<Routes>();
  const onReady = usePushNavigation(navigationRef);
  const connection = useLive(),
    color = usePalette(),
    dark = useColorScheme() === "dark",
    { baseUrl } = useConnection();
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
    <NavigationContainer
      ref={navigationRef}
      onReady={onReady}
      theme={theme}
      linking={{
        prefixes: ["kanvil://", baseUrl],
        filter: (url) => !url.startsWith("kanvil://auth/"),
        config: {
          initialRouteName: "Home",
          screens: {
            Home: "",
            Tickets: "projects/:projectId",
            Ticket: "projects/:projectId/tickets/:ticketId",
          },
        },
      }}
    >
      <SafeAreaView edges={["bottom"]} style={{ flex: 1, backgroundColor: color.surface }}>
        <Stack.Navigator
          screenOptions={{
            headerShadowVisible: false,
            headerTitleStyle: { fontSize: 17, fontWeight: "600" },
            headerBackButtonDisplayMode: "minimal",
          }}
        >
          <Stack.Screen name="Home" options={{ headerShown: false, title: "Projects" }}>
            {() => <Home onDisconnect={onDisconnect} />}
          </Stack.Screen>
          <Stack.Screen name="Tickets" component={Tickets} />
          <Stack.Screen name="Ticket" component={TicketDetail} options={{ title: "Ticket" }} />
          <Stack.Screen
            name="Edit"
            component={EditTicket}
            options={({ route, navigation }) => ({
              headerLeft: createHeaderAction("Cancel", () => navigation.goBack()),
              title: route.params.ticketId ? "Edit ticket" : "New ticket",
              presentation: "modal",
            })}
          />
        </Stack.Navigator>
        <View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={{
            paddingHorizontal: 22,
            paddingVertical: 5,
            borderTopWidth: 0.5,
            borderTopColor: color.line,
            backgroundColor: color.surface,
          }}
        >
          <Body muted small>
            {connection === "connected"
              ? "● Live"
              : connection === "offline"
                ? "Offline · cached data"
                : connection}
          </Body>
        </View>
      </SafeAreaView>
    </NavigationContainer>
  );
}
function tabIcon({ route }: { route: { name: string } }) {
  return {
    tabBarIcon: ({ color, size }: { color: string; size: number }) => (
      <Ionicons
        name={
          route.name === "Projects"
            ? "folder-outline"
            : route.name === "Inbox"
              ? "notifications-outline"
              : "settings-outline"
        }
        size={size}
        color={color}
      />
    ),
    headerShadowVisible: false,
    headerTitleAlign: "left" as const,
    headerTitleStyle: { fontSize: 28, fontWeight: "700" as const, letterSpacing: -0.8 },
    headerStyle: { height: 112 },
    tabBarLabelStyle: { fontSize: 11, fontWeight: "500" as const },
  };
}
function Home({ onDisconnect }: { onDisconnect: () => Promise<void> }) {
  return (
    <Tabs.Navigator screenOptions={tabIcon} safeAreaInsets={{ bottom: 0 }}>
      <Tabs.Screen name="Projects" component={Projects} />
      <Tabs.Screen name="Inbox" component={Inbox} />
      <Tabs.Screen name="Settings">{() => <Settings onDisconnect={onDisconnect} />}</Tabs.Screen>
    </Tabs.Navigator>
  );
}
