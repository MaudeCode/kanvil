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
  useParams,
  useRouterState,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import {
  Settings,
  WifiOff,
  FolderOpen,
  Search as SearchIcon,
  MessageSquare,
  Bell,
  Check,
  CheckCheck,
  ChevronRight,
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
  projectSettingsSearchSchema,
  settingsSearchSchema,
  adminSearchSchema,
  searchSchema,
} from "./search.ts";

import { Login, Consent } from "./auth.tsx";
import {
  api,
  auth,
  Identity,
  useLive,
  useProjects,
  useWorkspace,
  useIdentity,
  clearPrivateStorage,
} from "./data.tsx";
import {
  Button,
  EmptyState,
  ErrorNotice,
  IconButton,
  Loading,
  PageHeader,
  RelativeTime,
} from "./ui.tsx";
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
import { ProjectLabelProvider } from "./components/project-label-provider.tsx";

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
  // The session hook reports pending again on every background refetch (for example on window
  // focus); only the first resolution may replace the screen, or the login form loses its input.
  const [settled, setSettled] = useState(false);
  if (!session.isPending && !settled) setSettled(true);
  if (session.isPending && !settled) return <Loading />;
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
  const { projectId } = useParams({ strict: false });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
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
        <a
          className="fixed top-3 left-3 z-50 -translate-y-24 rounded-md bg-popover p-3 text-foreground shadow-md focus:translate-y-0"
          href="#main"
        >
          Skip to content
        </a>
        <AppSidebar />
        <SidebarInset className="min-w-0 has-[.ticket-list-controls]:max-h-svh md:has-[.ticket-list-controls]:max-h-[calc(100svh-1rem)]">
          <WorkspaceHeader />
          {connection !== "connected" && connection !== "connecting" && (
            <Alert className="mx-6 mt-4 w-auto">
              <WifiOff />
              <AlertDescription>
                {connection === "offline" ? "Connection lost. Reconnecting…" : connection}
              </AlertDescription>
            </Alert>
          )}
          <div
            id="main"
            className="content @container w-full min-w-0 px-5 pt-4 pb-12 has-[.ticket-list-controls]:flex has-[.ticket-list-controls]:min-h-0 has-[.ticket-list-controls]:flex-1 has-[.ticket-list-controls]:flex-col has-[.ticket-list-controls]:pt-2 has-[.ticket-list-controls]:pb-0 max-[650px]:px-4 max-[650px]:pt-6 max-[650px]:pb-10 md:px-8"
            tabIndex={-1}
          >
            <ProjectLabelProvider projectId={projectId}>
              <div
                key={pathname}
                className="mx-auto max-w-[1440px] animate-in fade-in-0 duration-200 has-[.ticket-detail]:max-w-none has-[.ticket-list-controls]:flex has-[.ticket-list-controls]:min-h-0 has-[.ticket-list-controls]:w-full has-[.ticket-list-controls]:max-w-none has-[.ticket-list-controls]:flex-1 has-[.ticket-list-controls]:flex-col"
              >
                {/* Lazy route chunks suspend here, so the shell and sidebar never flash or lose focus. */}
                <Suspense fallback={<Loading />}>
                  <Outlet />
                </Suspense>
              </div>
            </ProjectLabelProvider>
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
      <PageHeader title="Projects">
        {workspace.active ? <CreateProject /> : <CreateWorkspace />}
      </PageHeader>
      {!!projects.data?.length && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <InputGroup className="max-w-md">
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
        <ItemGroup className="project-list gap-0 border-t">
          {matches.map((project) => (
            <ProjectContextMenu key={project.id} project={project}>
              <Item
                role="listitem"
                className="group/project flex-nowrap gap-3 rounded-none border-x-0 border-t-0 border-b-border py-3 transition-colors hover:bg-muted/40"
              >
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: project.id }}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ItemMedia>
                    <ProjectIcon
                      project={project}
                      className="size-10 rounded-lg bg-muted/50 p-1 transition-transform group-hover/project:scale-105"
                    />
                  </ItemMedia>
                  <ItemContent className="min-w-0 gap-0.5">
                    <ItemTitle className="line-clamp-none flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="min-w-0 wrap-anywhere text-sm font-medium">
                        {project.name}
                      </span>
                      <Badge variant="secondary" className="font-mono text-[10px] font-normal">
                        {project.key}
                      </Badge>
                    </ItemTitle>
                    <p className="m-0 text-xs text-muted-foreground tabular-nums">
                      {project.openTickets === 0
                        ? "No open tickets"
                        : `${project.openTickets} open`}
                      {project.overdueTickets > 0 && (
                        <span className="text-(--warning)">
                          {" "}
                          · {project.overdueTickets} overdue
                        </span>
                      )}
                    </p>
                    {project.description && (
                      <ItemDescription className="m-0 line-clamp-2 text-xs leading-5">
                        {project.description}
                      </ItemDescription>
                    )}
                  </ItemContent>
                </Link>
                <ItemActions>
                  <IconButton
                    label={`Project settings for ${project.name}`}
                    className="text-muted-foreground opacity-0 transition-opacity group-hover/project:opacity-100 focus-visible:opacity-100 hover:text-foreground max-md:opacity-100"
                    render={
                      <Link to="/projects/$projectId/settings" params={{ projectId: project.id }} />
                    }
                  >
                    <Settings />
                  </IconButton>
                  <ChevronRight className="size-4 text-muted-foreground/60" aria-hidden="true" />
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
      <PageHeader title="Inbox">
        <Button
          disabled={pending || !unread.length}
          onClick={() => {
            void mark(unread.map((item) => item.id));
          }}
        >
          <CheckCheck />
          Mark all read
        </Button>
      </PageHeader>
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
        <ItemGroup className="inbox gap-0 border-t">
          {visible.map((item) => {
            const title =
                typeof item.event.data.title === "string"
                  ? item.event.data.title
                  : formatEvent(item.event),
              key = typeof item.event.data.key === "string" ? item.event.data.key : null,
              project = projects.data?.find((candidate) => candidate.id === item.event.projectId),
              linked = !!item.event.ticketId && item.event.type !== "ticket.deleted";
            const body = (
              <>
                <ItemMedia variant="icon">
                  {item.event.type.startsWith("comment.") ? <MessageSquare /> : <Bell />}
                </ItemMedia>
                <ItemContent className="min-w-0 gap-0.5">
                  <ItemTitle className="line-clamp-none max-w-full text-[13px] leading-5 wrap-anywhere">
                    {title}
                  </ItemTitle>
                  <ItemDescription className="m-0 text-xs">
                    {project?.name}
                    {key && ` · ${key}`} · {formatEvent(item.event)}
                  </ItemDescription>
                </ItemContent>
              </>
            );
            return (
              <Item
                key={item.id}
                data-unread={!item.readAt}
                className="flex-nowrap rounded-none border-x-0 border-t-0 border-b-border px-3 py-3 data-[unread=true]:border-l-2 data-[unread=true]:border-l-primary data-[unread=true]:bg-primary/5"
              >
                {linked ? (
                  <Link
                    to="/projects/$projectId/tickets/$ticketId"
                    params={{
                      projectId: item.event.projectId,
                      ticketId: item.event.ticketId ?? "",
                    }}
                    onClick={() => {
                      if (!item.readAt) void mark([item.id]);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm text-foreground outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">{body}</div>
                )}
                <ItemActions className="gap-2 self-start">
                  {!item.readAt && (
                    <IconButton
                      label="Mark read"
                      size="icon-sm"
                      disabled={pending}
                      onClick={() => void mark([item.id])}
                    >
                      <Check />
                    </IconButton>
                  )}
                  <RelativeTime
                    value={item.event.createdAt}
                    className="text-xs whitespace-nowrap text-muted-foreground"
                  />
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
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
  validateSearch: projectSettingsSearchSchema,
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
        void navigate({ search: projectSettingsSearchSchema.parse({ section }), replace: true });
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
