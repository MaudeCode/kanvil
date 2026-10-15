import { ProjectIcon } from "./components/project-icon.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { ProjectContextMenu } from "./components/object-context-menu.tsx";
import { lazy, Suspense, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createPrivatePersister } from "./lib/private-cache.ts";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useNavigate,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import {
  ChevronRight,
  WifiOff,
  FolderOpen,
  Search as SearchIcon,
  MessageSquare,
  Bell,
  CheckCheck,
} from "lucide-react";
import {
  hasAdminRole,
  formatEvent,
  notificationsSchema,
  okSchema,
  infoSchema,
} from "@kanvil/contracts";
import {
  groupSettingsSearchSchema,
  settingsSearchSchema,
  adminSearchSchema,
  searchSchema,
} from "./search.ts";

import { Login, Consent } from "./auth.tsx";
import {
  api,
  auth,
  date,
  Identity,
  useLive,
  useProjects,
  useWorkspace,
  useIdentity,
  clearPrivateStorage,
} from "./data.tsx";
import { Button, EmptyState, ErrorNotice, Loading } from "./ui.tsx";
import { WorkspaceProvider } from "./components/workspace-provider.tsx";
import { AppSidebar, WorkspaceHeader } from "./components/app-sidebar.tsx";
import { CreateWorkspace } from "./components/workspace-switcher.tsx";
import { CreateProject } from "./components/create-project.tsx";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { ThemeProvider } from "./components/theme-provider.tsx";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Item,
  ItemGroup,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "@/components/ui/item";
import { Badge } from "@/components/ui/badge";

const TicketList = lazy(() =>
  import("./ticket-list.tsx").then((module) => ({ default: module.TicketList })),
);
const TicketDetail = lazy(() =>
  import("./ticket-detail.tsx").then((module) => ({ default: module.TicketDetail })),
);
const AccountSettings = lazy(() =>
  import("./settings.tsx").then((module) => ({ default: module.AccountSettings })),
);
const AdminSettings = lazy(() =>
  import("./components/admin-settings.tsx").then((module) => ({ default: module.AdminSettings })),
);
const ProjectSettings = lazy(() =>
  import("./components/project-settings.tsx").then((module) => ({
    default: module.ProjectSettings,
  })),
);
function Root() {
  const session = auth.useSession();
  if (session.isPending) return <Loading />;
  if (!session.data) return <Login />;
  return (
    <SignedInSession
      key={`${session.data.user.id}:${session.data.user.role ?? "user"}`}
      user={session.data.user}
    />
  );
}
function SignedInSession({
  user,
}: {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null | undefined;
    role?: string | null | undefined;
  };
}) {
  const [cache] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15000, gcTime: 7 * 86400000, retry: 1 },
          mutations: { networkMode: "always", retry: false },
        },
      }),
  );
  const [persistence] = useState(() =>
    createPrivatePersister(localStorage, `kanvil:${user.id}:cache`),
  );
  useEffect(() => {
    persistence.resume();
    return () => {
      persistence.pause();
      cache.clear();
    };
  }, [cache, persistence]);
  return (
    <Identity
      value={{
        ...user,
        image: user.image ?? null,
        admin: hasAdminRole(user.role),
        clearPrivateData: () => {
          persistence.pause();
          cache.clear();
          clearPrivateStorage(user.id);
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
            shouldDehydrateQuery: (query) =>
              query.state.status === "success" && query.queryKey[0] === "kanvil",
          },
        }}
      >
        <Outlet />
      </PersistQueryClientProvider>
    </Identity>
  );
}
function Shell() {
  const connection = useLive();
  const info = useQuery({
    queryKey: ["info"],
    queryFn: () => api.request("/api/v1/info", infoSchema),
  });
  useEffect(() => {
    document.title =
      info.data?.name && info.data.name !== "Kanvil" ? `${info.data.name} · Kanvil` : "Kanvil";
  }, [info.data?.name]);

  return (
    <WorkspaceProvider>
      <SidebarProvider defaultOpen={!document.cookie.split("; ").includes("sidebar_state=false")}>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <WorkspaceHeader />
          {connection !== "connected" && connection !== "connecting" && (
            <Alert className="mx-6 mt-4 w-auto">
              <WifiOff />
              <AlertDescription>
                {connection === "offline" ? "Connection lost. Reconnecting…" : connection}
              </AlertDescription>
            </Alert>
          )}
          <div id="main" className="content @container" tabIndex={-1}>
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </WorkspaceProvider>
  );
}
function Home() {
  const projects = useProjects(),
    workspace = useWorkspace(),
    [query, setQuery] = useState("");
  const matches =
    projects.data?.filter((project) =>
      `${project.name} ${project.key} ${project.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) ?? [];
  return (
    <>
      <header className="page-header">
        <h1>Projects</h1>
        {workspace.active ? <CreateProject /> : <CreateWorkspace />}
      </header>
      {!!projects.data?.length && (
        <div className="project-search">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search projects"
              placeholder="Search projects…"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
          <span>
            {matches.length} {matches.length === 1 ? "project" : "projects"}
          </span>
        </div>
      )}
      <ErrorNotice error={projects.error ?? workspace.error} />
      {projects.isPending || workspace.pending ? (
        <Loading />
      ) : (
        <ItemGroup className="project-list gap-0">
          {matches.map((project) => (
            <ProjectContextMenu key={project.id} project={project}>
              <Item
                className="rounded-none border-x-0 border-t-0 border-b-border py-3"
                render={<Link to="/projects/$projectId" params={{ projectId: project.id }} />}
              >
                <ItemMedia>
                  <ProjectIcon project={project} className="size-6" />
                </ItemMedia>
                <ItemMedia>
                  <Badge variant="ghost" className="project-key">
                    {project.key}
                  </Badge>
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="line-clamp-none wrap-anywhere">{project.name}</ItemTitle>
                  {project.description && (
                    <ItemDescription className="line-clamp-none">
                      {project.description}
                    </ItemDescription>
                  )}
                </ItemContent>
                <ItemActions>
                  <ChevronRight size={16} aria-hidden="true" className="text-muted-foreground" />
                </ItemActions>
              </Item>
            </ProjectContextMenu>
          ))}
          {projects.data?.length !== 0 && matches.length === 0 && (
            <EmptyState title="No matching projects">
              <Button onClick={() => setQuery("")}>Clear search</Button>
            </EmptyState>
          )}
          {!workspace.active && !workspace.pending && <EmptyState title="No workspaces yet" />}
          {workspace.active && projects.data?.length === 0 && (
            <EmptyState title="No projects yet" icon={FolderOpen} />
          )}
        </ItemGroup>
      )}
    </>
  );
}
function Inbox() {
  const cache = useQueryClient(),
    projects = useProjects(),
    [error, setError] = useState<unknown>(),
    [view, setView] = useState("unread"),
    [pending, setPending] = useState(false);
  const items = useQuery({
    queryKey: ["kanvil", "notifications"],
    queryFn: () => api.request("/api/v1/notifications", notificationsSchema),
  });
  const workspaceItems =
    items.data?.filter((item) =>
      projects.data?.some((project) => project.id === item.event.projectId),
    ) ?? [];
  const unread = workspaceItems.filter((item) => !item.readAt),
    visible = view === "unread" ? unread : workspaceItems;
  async function mark(ids: string[]) {
    if (!ids.length) return;
    setPending(true);
    setError(undefined);
    try {
      await api.request("/api/v1/notifications/read", okSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      await cache.invalidateQueries({ queryKey: ["kanvil", "notifications"] });
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <header className="page-header">
        <h1>Inbox</h1>
        <Button
          disabled={pending || !unread.length}
          onClick={() => {
            void mark(unread.map((item) => item.id));
          }}
        >
          <CheckCheck />
          Mark all read
        </Button>
      </header>
      <Tabs value={view} onValueChange={(value) => setView(String(value))} className="mb-5">
        <TabsList variant="line">
          <TabsTrigger value="unread">
            Unread
            {unread.length > 0 && (
              <Badge variant="secondary" className="ml-1">
                {unread.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="all">All notifications</TabsTrigger>
        </TabsList>
      </Tabs>
      <ErrorNotice error={error ?? items.error} />
      {items.isPending ? (
        <Loading />
      ) : (
        <ol className="inbox">
          {visible.map((item) => {
            const title =
                typeof item.event.data.title === "string"
                  ? item.event.data.title
                  : formatEvent(item.event),
              key = typeof item.event.data.key === "string" ? item.event.data.key : null,
              project = projects.data?.find((candidate) => candidate.id === item.event.projectId),
              content = (
                <>
                  <span className="notification-icon">
                    {item.event.type.startsWith("comment.") ? <MessageSquare /> : <Bell />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="notification-title">{title}</span>
                    <span className="notification-context">
                      {project?.name}
                      {key && ` · ${key}`} · {formatEvent(item.event)}
                    </span>
                  </span>
                  <time dateTime={item.event.createdAt}>{date(item.event.createdAt)}</time>
                </>
              );
            return (
              <li key={item.id} data-unread={!item.readAt}>
                {item.event.ticketId && item.event.type !== "ticket.deleted" ? (
                  <Link
                    to="/projects/$projectId/tickets/$ticketId"
                    params={{ projectId: item.event.projectId, ticketId: item.event.ticketId }}
                    onClick={() => {
                      if (!item.readAt) void mark([item.id]);
                    }}
                  >
                    {content}
                  </Link>
                ) : (
                  <div className="notification-row">{content}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {!items.isPending && !visible.length && (
        <EmptyState
          title={view === "unread" ? "No unread notifications" : "No notifications"}
          icon={Bell}
        />
      )}
    </>
  );
}
function NotFoundPage() {
  return (
    <main className="mx-auto max-w-lg p-6">
      <EmptyState title="Page not found">
        <Button render={<Link to="/" />}>Open projects</Button>
      </EmptyState>
    </main>
  );
}
function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <main className="mx-auto max-w-lg p-6">
      <ErrorNotice error={error} />
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
const root = createRootRoute({
  component: Root,
  notFoundComponent: NotFoundPage,
  errorComponent: RouteError,
});
const shell = createRoute({ getParentRoute: () => root, id: "workspace", component: Shell });
const home = createRoute({ getParentRoute: () => shell, path: "/", component: Home });
const login = createRoute({ getParentRoute: () => root, path: "/login", component: HomeRedirect });
function HomeRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: "/" });
  }, [navigate]);
  return <Loading />;
}
const consent = createRoute({ getParentRoute: () => root, path: "/authorize", component: Consent });
const inbox = createRoute({ getParentRoute: () => shell, path: "/inbox", component: Inbox });
const settings = createRoute({
  getParentRoute: () => shell,
  path: "/settings",
  validateSearch: settingsSearchSchema,
  component: SettingsPage,
});
function SettingsPage() {
  const search = settings.useSearch(),
    navigate = settings.useNavigate();
  return (
    <AccountSettings
      section={search.section}
      onSectionChange={(section) => {
        void navigate({ search: settingsSearchSchema.parse({ section }), replace: true });
      }}
    />
  );
}
const admin = createRoute({
  getParentRoute: () => shell,
  path: "/admin",
  validateSearch: adminSearchSchema,
  component: AdminSettingsPage,
});
function AdminSettingsPage() {
  const identity = useIdentity(),
    search = admin.useSearch(),
    navigate = admin.useNavigate();
  return identity.admin ? (
    <AdminSettings
      section={search.section}
      onSectionChange={(section) => {
        void navigate({ search: adminSearchSchema.parse({ section }), replace: true });
      }}
    />
  ) : (
    <ErrorNotice error={new Error("Instance administrator access is required")} />
  );
}

const projectRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId",
  validateSearch: searchSchema,
  component: ProjectPage,
});
function ProjectPage() {
  const { projectId } = projectRoute.useParams(),
    search = projectRoute.useSearch(),
    navigate = projectRoute.useNavigate(),
    projects = useProjects(),
    project = projects.data?.find((item) => item.id === projectId);
  return project ? (
    <TicketList
      key={project.id}
      project={project}
      search={search}
      onSearch={(next) => {
        void navigate({ search: next, replace: true });
      }}
    />
  ) : projects.isPending ? (
    <Loading />
  ) : (
    <ErrorNotice error={projects.error ?? new Error("Project not found")} />
  );
}
const ticket = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/tickets/$ticketId",
  component: TicketPage,
});
function TicketPage() {
  const params = ticket.useParams();
  return <TicketDetail key={`${params.projectId}:${params.ticketId}`} {...params} />;
}
const WorkspaceSettings = lazy(() =>
  import("./components/workspace-settings.tsx").then((module) => ({
    default: module.WorkspaceSettings,
  })),
);
const workspaceSettings = createRoute({
  getParentRoute: () => shell,
  path: "/workspaces/$workspaceId/settings",
  validateSearch: groupSettingsSearchSchema,
  component: WorkspaceSettingsPage,
});
function WorkspaceSettingsPage() {
  const { workspaceId } = workspaceSettings.useParams(),
    search = workspaceSettings.useSearch(),
    navigate = workspaceSettings.useNavigate();
  return (
    <WorkspaceSettings
      workspaceId={workspaceId}
      section={search.section}
      onSectionChange={(section) => {
        void navigate({ search: groupSettingsSearchSchema.parse({ section }), replace: true });
      }}
    />
  );
}
const projectSettings = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/settings",
  validateSearch: groupSettingsSearchSchema,
  component: ProjectSettingsPage,
});
function ProjectSettingsPage() {
  const { projectId } = projectSettings.useParams(),
    search = projectSettings.useSearch(),
    navigate = projectSettings.useNavigate(),
    projects = useProjects(),
    project = projects.data?.find((item) => item.id === projectId);
  return project ? (
    <ProjectSettings
      project={project}
      section={search.section}
      onSectionChange={(section) => {
        void navigate({ search: groupSettingsSearchSchema.parse({ section }), replace: true });
      }}
    />
  ) : projects.isPending ? (
    <Loading />
  ) : (
    <ErrorNotice error={projects.error ?? new Error("Project not found")} />
  );
}
const router = createRouter({
  routeTree: root.addChildren([
    shell.addChildren([
      home,
      projectRoute,
      ticket,
      projectSettings,
      workspaceSettings,
      inbox,
      settings,
      admin,
    ]),
    login,
    consent,
  ]),
  defaultPreload: "intent",
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
const publicCache = new QueryClient();
export function App() {
  return (
    <ThemeProvider>
      <TooltipProvider delay={300}>
        <QueryClientProvider client={publicCache}>
          <Suspense fallback={<Loading />}>
            <RouterProvider router={router} />
          </Suspense>
        </QueryClientProvider>
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}
