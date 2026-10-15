import { lazy, Suspense, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
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
import { ChevronRight, WifiOff, FolderOpen } from "lucide-react";
import { formatEvent, notificationsSchema, okSchema } from "@kanvil/contracts";
import { searchSchema } from "./search.ts";

import { Login, Consent } from "./auth.tsx";
import { api, auth, date, Identity, useLive, useProjects } from "./data.tsx";
import { Button, EmptyState, ErrorNotice, Loading } from "./ui.tsx";
import { AppSidebar, WorkspaceHeader } from "./components/app-sidebar.tsx";
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
const ProjectSettings = lazy(() =>
  import("./settings.tsx").then((module) => ({ default: module.ProjectSettings })),
);
function Root() {
  const session = auth.useSession();
  if (session.isPending) return <Loading />;
  if (!session.data) return <Login />;
  return <Workspace key={session.data.user.id} user={session.data.user} />;
}
function Workspace({
  user,
}: {
  user: { id: string; name: string; email: string; role?: string | null | undefined };
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
  const [persister] = useState(() =>
    createSyncStoragePersister({ storage: localStorage, key: `kanvil:${user.id}:cache` }),
  );
  useEffect(() => () => cache.clear(), [cache]);
  return (
    <Identity value={{ ...user, admin: user.role === "admin" }}>
      <PersistQueryClientProvider
        client={cache}
        persistOptions={{
          persister,
          maxAge: 7 * 86400000,
          buster: "kanvil-v1",
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
  return (
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
        <div id="main" className="content" tabIndex={-1}>
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
function Home() {
  const projects = useProjects();
  return (
    <>
      <header className="page-header">
        <h1>Projects</h1>
        <CreateProject />
      </header>
      <ErrorNotice error={projects.error} />
      {projects.isPending ? (
        <Loading />
      ) : (
        <ItemGroup className="project-list gap-0">
          {projects.data?.map((project) => (
            <Item
              key={project.id}
              className="rounded-none border-x-0 border-t-0 border-b-border py-5"
              render={<Link to="/projects/$projectId" params={{ projectId: project.id }} />}
            >
              <ItemMedia>
                <Badge variant="secondary" className="project-key">
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
          ))}
          {projects.data?.length === 0 && (
            <EmptyState title="No projects yet" icon={FolderOpen}>
              <CreateProject />
            </EmptyState>
          )}
        </ItemGroup>
      )}
    </>
  );
}
function Inbox() {
  const cache = useQueryClient(),
    [error, setError] = useState<unknown>();
  const items = useQuery({
    queryKey: ["kanvil", "notifications"],
    queryFn: () => api.request("/api/v1/notifications", notificationsSchema),
  });
  return (
    <>
      <header className="page-header">
        <h1>Inbox</h1>
        <Button
          disabled={!items.data?.some((item) => !item.readAt)}
          onClick={() => {
            void api
              .request("/api/v1/notifications/read", okSchema, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  ids: items.data?.filter((item) => !item.readAt).map((item) => item.id),
                }),
              })
              .then(() => cache.invalidateQueries({ queryKey: ["kanvil", "notifications"] }))
              .catch(setError);
          }}
        >
          Mark all read
        </Button>
      </header>
      <ErrorNotice error={error ?? items.error} />
      {items.isPending && <Loading />}
      <ol className="inbox">
        {items.data?.map((item) => (
          <li key={item.id} data-unread={!item.readAt}>
            {item.event.ticketId ? (
              <Link
                to="/projects/$projectId/tickets/$ticketId"
                params={{ projectId: item.event.projectId, ticketId: item.event.ticketId }}
              >
                {formatEvent(item.event, true)}
              </Link>
            ) : (
              <span>{formatEvent(item.event)}</span>
            )}
            <small className="muted">{date(item.event.createdAt)}</small>
          </li>
        ))}
      </ol>
      {items.data?.length === 0 && <EmptyState title="No notifications" />}
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
  component: AccountSettings,
});
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
const projectSettings = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/settings",
  component: ProjectSettingsPage,
});
function ProjectSettingsPage() {
  const { projectId } = projectSettings.useParams(),
    projects = useProjects(),
    project = projects.data?.find((item) => item.id === projectId);
  return project ? (
    <ProjectSettings project={project} />
  ) : projects.isPending ? (
    <Loading />
  ) : (
    <ErrorNotice error={projects.error ?? new Error("Project not found")} />
  );
}
const router = createRouter({
  routeTree: root.addChildren([
    shell.addChildren([home, projectRoute, ticket, projectSettings, inbox, settings]),
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
      </TooltipProvider>
    </ThemeProvider>
  );
}
