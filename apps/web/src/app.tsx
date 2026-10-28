import { ProjectIcon } from "./components/project-icon.tsx";
import { Toaster } from "@/components/ui/sonner";
import { ProjectContextMenu } from "./components/object-context-menu.tsx";
import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps } from "react";
import { toast } from "sonner";
import {
  QueryClient,
  QueryClientProvider,
  IsRestoringProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  persistQueryClientRestore,
  persistQueryClientSave,
  type PersistQueryClientOptions,
} from "@tanstack/react-query-persist-client";
import { createPrivatePersister, subscribePrivateCache } from "./lib/private-cache.ts";
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
import { Settings, FolderOpen, ChevronRight } from "lucide-react";
import { hasAdminRole, formatEvent, type Output } from "@kanvil/contracts";
import { formatNumber, t } from "@kanvil/contracts/i18n";
import { Trans } from "react-i18next";
import {
  groupSettingsSearchSchema,
  projectSettingsSearchSchema,
  settingsSearchSchema,
  authSearchSchema,
  adminSearchSchema,
  searchSchema,
  workSearchSchema,
  resultsSearchSchema,
  inboxSearchSchema,
  previewSearchSchema,
} from "./search.ts";
import { SearchResults } from "./search-results.tsx";
import { Inbox } from "./inbox.tsx";

import { Login, Consent, AcceptInvitation } from "./auth.tsx";
import {
  ActorName,
  api,
  auth,
  Identity,
  useLive,
  useAllProjects,
  useProject,
  useProjects,
  useWorkspace,
  useIdentity,
  useInfo,
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
  SearchField,
  SectionHeading,
  DueDate,
} from "./ui.tsx";
import { TicketLink } from "./components/ticket-link.tsx";
import { WorkspaceProvider } from "./components/workspace-provider.tsx";
import { TicketPreviewController } from "./components/ticket-preview.tsx";
import { AppSidebar, WorkspaceHeader } from "./components/app-sidebar.tsx";
import { CreateWorkspace } from "./components/workspace-switcher.tsx";
import { CreateProject } from "./components/create-project.tsx";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { ThemeProvider } from "./components/theme-provider.tsx";
import { TooltipProvider } from "@/components/ui/tooltip";
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
import { PropertyValue, statusValue } from "./components/ticket-property.tsx";
import { preferences, usePreference } from "./hooks/use-preference.ts";

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
const PublicProject = lazy(() =>
  import("./public-project.tsx").then((module) => ({ default: module.PublicProject })),
);
const PublicTicket = lazy(() =>
  import("./public-project.tsx").then((module) => ({ default: module.PublicTicket })),
);
const ProjectSettings = lazy(() =>
  import("./components/project-settings.tsx").then((module) => ({
    default: module.ProjectSettings,
  })),
);
function Root() {
  const session = auth.useSession();
  const shared = useRouterState({
    select: (state) => state.location.pathname.startsWith("/public/"),
  });
  // The session hook reports pending again on every background refetch (for example on window
  // focus); only the first resolution may replace the screen, or the login form loses its input.
  const [settled, setSettled] = useState(false);
  if (!session.isPending && !settled) setSettled(true);
  // Shared projects read without an account, from the app's unpersisted cache.
  if (shared) return <Outlet />;
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
  const [restoring, setRestoring] = useState(true);
  useEffect(() => {
    persistence.resume();
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    const options: PersistQueryClientOptions = {
      queryClient: cache,
      persister: persistence.persister,
      maxAge: 7 * 86400000,
      buster: `kanvil-v2:${user.role ?? "user"}`,
      dehydrateOptions: {
        shouldDehydrateMutation: () => false,
        shouldDehydrateQuery: (query) =>
          query.state.status === "success" && query.queryKey[0] === "kanvil",
      },
    };
    void persistQueryClientRestore(options)
      .catch(() => {})
      .then(() => {
        if (closed) return;
        unsubscribe = subscribePrivateCache(cache, () => persistQueryClientSave(options));
        setRestoring(false);
      });
    return () => {
      closed = true;
      persistence.pause();
      unsubscribe?.();
      cache.clear();
    };
  }, [cache, persistence, user.role]);
  return (
    <Identity
      value={{
        ...user,
        image: user.image ?? null,
        admin: hasAdminRole(user.role),
        clearPrivateData: async () => {
          persistence.pause();
          cache.clear();
          clearPrivateStorage(user.id);
          await persistence.clear();
        },
      }}
    >
      <QueryClientProvider client={cache}>
        <IsRestoringProvider value={restoring}>
          <Outlet />
        </IsRestoringProvider>
      </QueryClientProvider>
    </Identity>
  );
}
// A lost connection becomes a toast only after it stays lost; the stream retries every second or
// two, so brief blips never surface. Reconnecting after a shown toast confirms with a success toast.
function useConnectionToast(connection: string) {
  const state = useRef({ hadConnected: false, shown: false, timer: 0 });
  useEffect(() => {
    const current = state.current;
    if (connection === "connected") {
      current.hadConnected = true;
      window.clearTimeout(current.timer);
      current.timer = 0;
      if (current.shown) {
        current.shown = false;
        toast.success(t("shell.connection.restored"), {
          id: "connection",
          description: undefined,
          duration: 2500,
        });
      }
      return;
    }
    if (connection === "closed") return;
    const signIn = connection !== "connecting" && connection !== "offline";
    if (!current.hadConnected && !signIn) return;
    if (current.timer || current.shown) return;
    current.timer = window.setTimeout(
      () => {
        current.timer = 0;
        current.shown = true;
        if (signIn)
          toast.error(connection, {
            id: "connection",
            duration: Infinity,
            action: {
              label: t("shell.connection.reload"),
              onClick: () => window.location.reload(),
            },
          });
        else
          toast.warning(t("shell.connection.lost"), {
            id: "connection",
            description: t("shell.connection.reconnecting"),
            duration: Infinity,
          });
      },
      signIn ? 0 : 8000,
    );
  }, [connection]);
  useEffect(() => {
    const current = state.current;
    return () => {
      window.clearTimeout(current.timer);
      toast.dismiss("connection");
    };
  }, []);
}
function Shell() {
  const { projectId } = useParams({ strict: false });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const connection = useLive(),
    [sidebar] = usePreference(preferences.sidebar);
  useConnectionToast(connection);
  const info = useInfo();
  useEffect(() => {
    document.title =
      info.data?.name && info.data.name !== "Kanvil"
        ? t("shell.documentTitle", { name: info.data.name })
        : "Kanvil";
  }, [info.data?.name]);

  return (
    <WorkspaceProvider>
      <TicketPreviewController content={MemberPreview}>
        <SidebarProvider
          defaultOpen={
            sidebar === "last"
              ? !document.cookie.split("; ").includes("sidebar_state=false")
              : sidebar === "expanded"
          }
        >
          <a
            className="fixed top-3 left-3 z-50 -translate-y-24 rounded-md bg-popover p-3 text-foreground shadow-md focus:translate-y-0"
            href="#main"
          >
            {t("shell.app.skipToContent")}
          </a>
          <AppSidebar />
          <SidebarInset className="min-w-0 has-[.ticket-list-controls]:max-h-svh md:has-[.ticket-list-controls]:max-h-[calc(100svh-1rem)]">
            <WorkspaceHeader />
            <div
              id="main"
              className="content @container w-full min-w-0 has-[.project-background]:relative has-[.project-background]:isolate px-5 pt-4 pb-12 has-[.ticket-list-controls]:flex has-[.ticket-list-controls]:min-h-0 has-[.ticket-list-controls]:flex-1 has-[.ticket-list-controls]:flex-col has-[.ticket-list-controls]:pt-2 has-[.ticket-list-controls]:pb-0 max-[650px]:px-4 max-[650px]:pt-6 max-[650px]:pb-10 md:px-8"
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
      </TicketPreviewController>
    </WorkspaceProvider>
  );
}
// The previewed ticket reads its own project's labels, not those of the page below.
function MemberPreview(props: ComponentProps<typeof TicketDetail>) {
  return (
    <ProjectLabelProvider projectId={props.projectId}>
      <TicketDetail {...props} />
    </ProjectLabelProvider>
  );
}
// Bounded previews; My work and the project directory below hold the complete lists.
const homeTickets = 8,
  homeActivity = 10;
function Home() {
  const workspace = useWorkspace();
  return (
    <>
      <PageHeader title={t("shell.page.home")} />
      {workspace.active && <WorkOverview workspaceId={workspace.active.id} />}
      <ProjectDirectory />
    </>
  );
}
function WorkOverview({ workspaceId }: { workspaceId: string }) {
  const projects = useProjects(),
    work = useQuery(
      api.query("list_my_work", {
        workspaceId,
        sort: "due",
        limit: homeTickets,
        activity: homeActivity,
      }),
    );
  const projectName = (id: string) => projects.data?.find((project) => project.id === id)?.name;
  const total = work.data?.total ?? 0;
  return (
    <div className="mb-10 grid gap-x-10 gap-y-8 @min-[900px]:grid-cols-2">
      <section aria-label={t("shell.app.assigned")}>
        <SectionHeading
          compact
          title={t("shell.app.assigned")}
          action={
            work.data && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {t("shell.app.openCount", { count: total })}
              </span>
            )
          }
        />
        <ErrorNotice error={work.error} />
        {work.isPending ? (
          <Loading />
        ) : (
          <>
            <ul className="m-0 list-none border-t p-0">
              {work.data?.items.map((ticket) => (
                <li
                  key={ticket.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2.5 text-[13px] leading-5"
                >
                  <PropertyValue
                    property="status"
                    value={statusValue(ticket)}
                    projectId={ticket.projectId}
                  />
                  <TicketLink
                    projectId={ticket.projectId}
                    ticketId={ticket.id}
                    ticket={ticket}
                    className="min-w-0 flex-1 basis-48 wrap-anywhere"
                  />
                  <span className="text-xs text-muted-foreground">
                    {projectName(ticket.projectId)}
                  </span>
                  <DueDate value={ticket.dueAt} className="text-xs" />
                </li>
              ))}
            </ul>
            {total === 0 ? (
              <p className="my-3 text-xs text-muted-foreground">{t("shell.app.noAssigned")}</p>
            ) : (
              <Link
                to="/my-work"
                className="mt-3 inline-block text-xs text-muted-foreground hover:text-primary"
              >
                {total > homeTickets
                  ? t("shell.app.allInMyWork", { count: total })
                  : t("shell.app.openMyWork")}
              </Link>
            )}
          </>
        )}
      </section>
      <section aria-label={t("shell.app.recentActivity")}>
        <SectionHeading compact title={t("shell.app.recentActivity")} />
        {!work.isPending && (
          <ol className="m-0 list-none border-t p-0">
            {work.data?.activity.map((event) => {
              const key = typeof event.data.key === "string" ? event.data.key : null,
                title = typeof event.data.title === "string" ? event.data.title : null,
                linked = !!event.ticketId && event.type !== "ticket.deleted";
              return (
                <li
                  key={event.id}
                  className="flex items-start justify-between gap-3 border-b py-2.5 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    {linked && event.ticketId ? (
                      <TicketLink
                        projectId={event.projectId}
                        ticketId={event.ticketId}
                        ticket={key && title ? { key, title } : undefined}
                        className="text-[13px] leading-5 wrap-anywhere"
                      />
                    ) : (
                      <span className="text-[13px] leading-5 wrap-anywhere">
                        {title ?? formatEvent(event)}
                      </span>
                    )}
                    <p className="m-0 text-muted-foreground">
                      {(linked || title) && `${formatEvent(event)} · `}
                      <ActorName projectId={event.projectId} actorId={event.actorId} /> ·{" "}
                      {projectName(event.projectId)}
                    </p>
                  </div>
                  <RelativeTime
                    value={event.createdAt}
                    className="whitespace-nowrap text-muted-foreground"
                  />
                </li>
              );
            })}
          </ol>
        )}
        {work.data?.activity.length === 0 && (
          <p className="my-3 text-xs text-muted-foreground">{t("shell.app.noActivity")}</p>
        )}
      </section>
    </div>
  );
}
function ProjectDirectory() {
  const projects = useProjects(),
    all = useAllProjects(),
    workspace = useWorkspace(),
    [query, setQuery] = useState("");
  const matching = (project: Output<"list_projects">[number]) =>
    `${project.name} ${project.key} ${project.description}`
      .toLowerCase()
      .includes(query.toLowerCase());
  const matches = projects.data?.filter(matching) ?? [],
    archived =
      all.data?.filter(
        (project) =>
          project.archivedAt && project.workspaceId === workspace.active?.id && matching(project),
      ) ?? [];
  return (
    <section aria-label={t("shell.page.projects")}>
      <SectionHeading
        compact
        title={t("shell.page.projects")}
        action={
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            {!!projects.data?.length && (
              <SearchField
                label={t("shell.app.searchProjects")}
                value={query}
                onChange={setQuery}
              />
            )}
            {workspace.active ? <CreateProject /> : <CreateWorkspace />}
          </div>
        }
      />
      {query && (
        <p className="mb-3 text-xs text-muted-foreground">
          {t("shell.app.projectCount", { count: matches.length })}
        </p>
      )}
      <ErrorNotice error={projects.error ?? workspace.error} />
      {projects.isPending || workspace.pending ? (
        <Loading />
      ) : (
        <ItemGroup className="project-list gap-0 border-t">
          {matches.map((project) => (
            <ProjectRow key={project.id} project={project} />
          ))}
          {projects.data?.length !== 0 && matches.length === 0 && (
            <EmptyState title={t("shell.app.noMatchingProjects")}>
              <Button onClick={() => setQuery("")}>{t("shell.app.clearSearch")}</Button>
            </EmptyState>
          )}
          {!workspace.active && !workspace.pending && (
            <EmptyState title={t("shell.app.noWorkspaces")} />
          )}
          {workspace.active && projects.data?.length === 0 && (
            <EmptyState
              title={archived.length ? t("shell.app.noActiveProjects") : t("shell.app.noProjects")}
              icon={FolderOpen}
            />
          )}
        </ItemGroup>
      )}
      {archived.length > 0 && (
        <section aria-label={t("shell.app.archivedProjects")} className="mt-8">
          <SectionHeading compact title={t("shell.app.archived")} />
          <ItemGroup className="project-list gap-0 border-t opacity-80">
            {archived.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))}
          </ItemGroup>
        </section>
      )}
    </section>
  );
}
function ProjectRow({ project }: { project: Output<"list_projects">[number] }) {
  return (
    <ProjectContextMenu project={project}>
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
              <span dir="auto" className="min-w-0 wrap-anywhere text-sm font-medium">
                {project.name}
              </span>
              <Badge variant="secondary" className="font-mono text-[10px] font-normal">
                {project.key}
              </Badge>
            </ItemTitle>
            <p className="m-0 text-xs text-muted-foreground tabular-nums">
              {project.openTickets === 0
                ? t("shell.app.noOpenTickets")
                : t("shell.app.openCount", { count: project.openTickets })}
              {project.overdueTickets > 0 && (
                <span className="text-(--warning)">
                  {" · "}
                  {t("shell.app.overdueCount", { count: project.overdueTickets })}
                </span>
              )}
              {project.closedTickets + project.openTickets > 0 &&
                ` · ${t("shell.app.percentDone", {
                  percent: formatNumber(
                    project.closedTickets / (project.closedTickets + project.openTickets),
                    { style: "percent" },
                  ),
                })}`}
              {project.nextDueAt && (
                <>
                  {" · "}
                  <Trans
                    i18nKey="shell.app.nextDue"
                    components={{ time: <RelativeTime value={project.nextDueAt} /> }}
                  />
                </>
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
            label={t("shell.app.projectSettingsFor", { name: project.name })}
            className="text-muted-foreground opacity-0 transition-opacity group-hover/project:opacity-100 focus-visible:opacity-100 hover:text-foreground max-md:opacity-100"
            render={<Link to="/projects/$projectId/settings" params={{ projectId: project.id }} />}
          >
            <Settings />
          </IconButton>
          <ChevronRight className="size-4 text-muted-foreground/60" aria-hidden="true" />
        </ItemActions>
      </Item>
    </ProjectContextMenu>
  );
}
function NotFoundPage() {
  return (
    <main className="mx-auto max-w-lg p-6">
      <EmptyState title={t("shell.app.pageNotFound")}>
        <Button render={<Link to="/" />}>{t("shell.app.openHome")}</Button>
      </EmptyState>
    </main>
  );
}
function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <main className="mx-auto max-w-lg p-6">
      <ErrorNotice error={error} />
      <Button onClick={reset}>{t("shell.app.tryAgain")}</Button>
    </main>
  );
}
const root = createRootRoute({
  validateSearch: previewSearchSchema,
  component: Root,
  notFoundComponent: NotFoundPage,
  errorComponent: RouteError,
});
const shell = createRoute({ getParentRoute: () => root, id: "workspace", component: Shell });
const home = createRoute({ getParentRoute: () => shell, path: "/", component: Home });
const login = createRoute({
  getParentRoute: () => root,
  path: "/login",
  validateSearch: authSearchSchema,
  component: HomeRedirect,
});
function HomeRedirect() {
  const navigate = useNavigate();
  const { error } = login.useSearch();
  useEffect(() => {
    void navigate(
      error
        ? { to: "/settings", search: { section: "account", error }, replace: true }
        : { to: "/" },
    );
  }, [navigate, error]);
  return <Loading />;
}
const consent = createRoute({ getParentRoute: () => root, path: "/authorize", component: Consent });
const invitation = createRoute({
  getParentRoute: () => root,
  path: "/invite/$token",
  component: function InvitationPage() {
    return <AcceptInvitation token={invitation.useParams().token} />;
  },
});
// Shared projects preview their tickets in a sheet of their own, which reads only the public
// projection.
const publicLayout = createRoute({
  getParentRoute: () => root,
  id: "public",
  component: function PublicLayout() {
    return (
      <TicketPreviewController shared content={PublicTicket}>
        <Outlet />
      </TicketPreviewController>
    );
  },
});
const publicProject = createRoute({
  getParentRoute: () => publicLayout,
  path: "/public/projects/$projectId",
  component: function PublicProjectPage() {
    return <PublicProject projectId={publicProject.useParams().projectId} />;
  },
});
const publicTicket = createRoute({
  getParentRoute: () => publicLayout,
  path: "/public/projects/$projectId/tickets/$ticketId",
  component: function PublicTicketPage() {
    const params = publicTicket.useParams();
    return <PublicTicket key={`${params.projectId}:${params.ticketId}`} {...params} />;
  },
});
const inbox = createRoute({
  getParentRoute: () => shell,
  path: "/inbox",
  validateSearch: inboxSearchSchema,
  component: InboxPage,
});
function InboxPage() {
  const search = inbox.useSearch(),
    navigate = inbox.useNavigate();
  return (
    <Inbox
      search={search}
      onSearch={(next) => {
        void navigate({ search: next, replace: true });
      }}
    />
  );
}
const settings = createRoute({
  getParentRoute: () => shell,
  path: "/settings",
  validateSearch: settingsSearchSchema,
  component: SettingsPage,
});
function SettingsPage() {
  return <AccountSettings section={settings.useSearch().section} />;
}
const admin = createRoute({
  getParentRoute: () => shell,
  path: "/admin",
  validateSearch: adminSearchSchema,
  component: AdminSettingsPage,
});
function AdminSettingsPage() {
  const identity = useIdentity(),
    search = admin.useSearch();
  return identity.admin ? (
    <AdminSettings section={search.section} />
  ) : (
    <ErrorNotice error={new Error(t("shell.app.adminRequired"))} />
  );
}

const projectRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId",
  validateSearch: searchSchema,
  component: ProjectPage,
});
const planningRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/planning",
  validateSearch: searchSchema,
  component: () => <ProjectPage planning />,
});
// Active work and planning share one page; planning reads its own route's params and search.
function ProjectPage({ planning = false }: { planning?: boolean }) {
  const route = planning ? planningRoute : projectRoute;
  const { projectId } = route.useParams(),
    search = route.useSearch(),
    navigate = route.useNavigate(),
    projects = useProject(projectId),
    project = projects.data;
  return project ? (
    <TicketList
      key={`${project.id}:${planning}`}
      scope={{ project, planning }}
      search={search}
      onSearch={(next) => {
        void navigate({ search: next, replace: true });
      }}
    />
  ) : projects.isPending ? (
    <Loading />
  ) : (
    <ErrorNotice error={projects.error ?? new Error(t("shell.app.projectNotFound"))} />
  );
}
const myWork = createRoute({
  getParentRoute: () => shell,
  path: "/my-work",
  validateSearch: workSearchSchema,
  component: MyWorkPage,
});
function MyWorkPage() {
  const search = myWork.useSearch(),
    navigate = myWork.useNavigate(),
    workspace = useWorkspace();
  return workspace.active ? (
    <TicketList
      key={workspace.active.id}
      scope={{ workspaceId: workspace.active.id }}
      search={search}
      onSearch={(next) => {
        void navigate({ search: next, replace: true });
      }}
    />
  ) : workspace.pending ? (
    <Loading />
  ) : (
    <ErrorNotice error={workspace.error ?? new Error(t("shell.app.noWorkspaceSelected"))} />
  );
}
const searchRoute = createRoute({
  getParentRoute: () => shell,
  path: "/search",
  validateSearch: resultsSearchSchema,
  component: SearchPage,
});
function SearchPage() {
  const search = searchRoute.useSearch(),
    navigate = searchRoute.useNavigate();
  return (
    <SearchResults
      search={search}
      onSearch={(next) => {
        void navigate({ search: next, replace: true });
      }}
    />
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
    search = workspaceSettings.useSearch();
  return <WorkspaceSettings workspaceId={workspaceId} section={search.section} />;
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
    projects = useProject(projectId),
    project = projects.data;
  return project ? (
    <ProjectSettings project={project} section={search.section} />
  ) : projects.isPending ? (
    <Loading />
  ) : (
    <ErrorNotice error={projects.error ?? new Error(t("shell.app.projectNotFound"))} />
  );
}
const router = createRouter({
  routeTree: root.addChildren([
    shell.addChildren([
      home,
      myWork,
      searchRoute,
      projectRoute,
      planningRoute,
      ticket,
      projectSettings,
      workspaceSettings,
      inbox,
      settings,
      admin,
    ]),
    login,
    consent,
    invitation,
    publicLayout.addChildren([publicProject, publicTicket]),
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
