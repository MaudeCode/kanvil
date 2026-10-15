import { formText } from "./forms.ts";
import { lazy, Suspense, useContext, useEffect, useState } from "react";
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
} from "@tanstack/react-router";
import { Bell, FolderOpen, Settings, Plus, LogOut } from "lucide-react";
import { notificationsSchema, okSchema } from "@kanvil/contracts";
import { searchSchema } from "./search.ts";

import { Login, Consent } from "./auth.tsx";
import {
  api,
  auth,
  clearPrivateStorage,
  date,
  Identity,
  useIdentity,
  useLive,
  useOperation,
  useProjects,
  useTheme,
  ThemeContext,
} from "./data.tsx";
import { Button, ErrorNotice, Input, Loading, Modal, Select, Textarea } from "./ui.tsx";

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
  const projects = useProjects(),
    identity = useIdentity(),
    cache = useQueryClient(),
    connection = useLive(),
    theme = useContext(ThemeContext);
  const [error, setError] = useState<unknown>();
  async function logout() {
    const result = await auth.signOut();
    if (result.error) throw new Error(result.error.message);
    cache.clear();
    clearPrivateStorage(identity.id);
    window.location.assign("/login");
  }
  return (
    <div className="workspace">
      <aside className="sidebar">
        <Link to="/" className="brand">
          Kanvil<span aria-hidden="true">↗</span>
        </Link>
        <nav aria-label="Workspace">
          <Link to="/inbox">
            <Bell size={18} />
            Inbox
          </Link>
          <div className="nav-heading">
            Projects
            <CreateProject icon />
          </div>
          {projects.data?.map((project) => (
            <Link key={project.id} to="/projects/$projectId" params={{ projectId: project.id }}>
              <FolderOpen size={17} />
              <span>{project.name}</span>
              <small>{project.key}</small>
            </Link>
          ))}
          <ErrorNotice error={projects.error} />
        </nav>
        <div className="account-nav">
          <p className="connection" role="status">
            <span data-connected={connection === "connected"}>●</span>{" "}
            {connection === "connected" ? "Live" : connection}
          </p>
          <Link to="/settings">
            <Settings size={18} />
            Settings
          </Link>
          <Select
            label="Theme"
            value={theme.mode}
            onChange={(event) =>
              theme.setMode(
                event.target.value === "dark"
                  ? "dark"
                  : event.target.value === "light"
                    ? "light"
                    : "system",
              )
            }
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </Select>
          <div className="account">
            <span>{identity.name}</span>
            <Button
              className="icon"
              aria-label="Sign out"
              onClick={() => {
                void logout().catch(setError);
              }}
            >
              <LogOut size={18} />
            </Button>
          </div>
          <ErrorNotice error={error} />
        </div>
      </aside>
      <main id="main" className="content">
        <Outlet />
      </main>
    </div>
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
        <div className="project-list">
          {projects.data?.map((project) => (
            <Link key={project.id} to="/projects/$projectId" params={{ projectId: project.id }}>
              <span className="key">{project.key}</span>
              <strong>{project.name}</strong>
              <span className="muted">{project.description}</span>
              <span aria-hidden="true">→</span>
            </Link>
          ))}
          {projects.data?.length === 0 && <p className="empty">No projects yet</p>}
        </div>
      )}
    </>
  );
}
function CreateProject({ icon = false }: { icon?: boolean }) {
  const [open, setOpen] = useState(false),
    create = useOperation("create_project"),
    navigate = useNavigate();
  return (
    <>
      <Button
        className={icon ? "icon" : "primary"}
        aria-label="New project"
        onClick={() => setOpen(true)}
      >
        {icon ? <Plus size={18} /> : "New project"}
      </Button>
      <Modal title="New project" open={open} onOpenChange={setOpen}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void create
              .mutateAsync({
                key: formText(values, "key"),
                name: formText(values, "name"),
                description: formText(values, "description"),
              })
              .then(async (project) => {
                setOpen(false);
                await navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
              })
              .catch(() => {});
          }}
        >
          <Input label="Project name" name="name" required maxLength={120} />
          <Input
            label="Permanent ticket prefix"
            name="key"
            required
            minLength={2}
            maxLength={10}
            pattern="[A-Z][A-Z0-9]{1,9}"
            placeholder="KAN"
          />
          <Textarea label="Description" name="description" maxLength={5000} />
          <ErrorNotice error={create.error} />
          <Button type="submit" className="primary" disabled={create.isPending}>
            Create project
          </Button>
        </form>
      </Modal>
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
                {item.event.type.replaceAll("_", " ")} · {item.event.ticketId}
              </Link>
            ) : (
              <span>{item.event.type}</span>
            )}
            <small className="muted">{date(item.event.createdAt)}</small>
          </li>
        ))}
      </ol>
      {items.data?.length === 0 && <p className="empty">No notifications</p>}
    </>
  );
}
const root = createRootRoute({
  component: Root,
  notFoundComponent: () => (
    <main className="empty">
      <h1>Page not found</h1>
      <Link to="/">Open projects</Link>
    </main>
  ),
  errorComponent: ({ error, reset }) => (
    <main>
      <ErrorNotice error={error} />
      <Button onClick={reset}>Try again</Button>
    </main>
  ),
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
  const theme = useTheme();
  return (
    <ThemeContext value={theme}>
      <QueryClientProvider client={publicCache}>
        <Suspense fallback={<Loading />}>
          <RouterProvider router={router} />
        </Suspense>
      </QueryClientProvider>
    </ThemeContext>
  );
}
