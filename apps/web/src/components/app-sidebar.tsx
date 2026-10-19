import { capabilitiesOf } from "@kanvil/contracts";
import { i18n, t } from "@kanvil/contracts/i18n";
import { ProjectIcon } from "./project-icon.tsx";
import { WorkspaceSwitcher } from "./workspace-switcher.tsx";
import { ProjectContextMenu, useProjectMove } from "./object-context-menu.tsx";
import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouter, useRouterState, useSearch } from "@tanstack/react-router";
import {
  Bell,
  ChevronsUpDown,
  House,
  LogOut,
  Moon,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Keyboard,
  UserCheck,
} from "lucide-react";
import {
  api,
  signOut,
  useIdentity,
  useProject,
  useProjects,
  useProjectAccess,
  useWorkspace,
} from "../data.tsx";
import { Brand, ErrorNotice, IconButton, Loading, Modal } from "../ui.tsx";
import { CreateProject } from "./create-project.tsx";
import { SearchResultContent, searchResultAnchor, searchResultLink } from "./search-result.tsx";
import { useTicketPreview } from "./ticket-preview.tsx";
import { useTheme } from "./theme-provider.tsx";
import { useShortcut } from "../hooks/use-shortcut.ts";
import { useReorderDrag } from "../hooks/use-reorder-drag.ts";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuBadge,
  SidebarFooter,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { UserAvatar } from "./user-avatar.tsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { actions, shortcutGroups, ticketCopyActions } from "../lib/actions.ts";
import { settingsLocation } from "../lib/settings-nav.ts";
import { useSettingsGroups } from "./settings-layout.tsx";
import { copyTicket } from "./object-context-menu.tsx";
// Palette entries match the words of the interface language and the English ones, so people find
// them either way.
const english = i18n.getFixedT("en-US");
const paletteWords = (words: (translate: typeof t) => string) => `${words(t)} ${words(english)}`;
const TicketEditor = lazy(() =>
  import("../ticket-editor.tsx").then((module) => ({ default: module.TicketEditor })),
);

export function useUnreadNotifications() {
  const projects = useProjects();
  const items = useQuery(api.notifications());
  return (
    items.data?.filter(
      (item) =>
        !item.readAt && projects.data?.some((project) => project.id === item.event.projectId),
    ).length ?? 0
  );
}
export function AppSidebar() {
  const projects = useProjects(),
    pathname = useRouterState({ select: (state) => state.location.pathname }),
    { setOpenMobile } = useSidebar(),
    unread = useUnreadNotifications();
  // Project administrators drag their projects into the workspace's shared order.
  const reorder = useProjectMove(),
    drag = useReorderDrag((id, anchor, below) => {
      const project = projects.data?.find((item) => item.id === id);
      if (project) reorder.place(project, anchor, below);
    });
  const router = useRouter();
  useEffect(
    () => router.subscribe("onBeforeNavigate", () => setOpenMobile(false)),
    [router, setOpenMobile],
  );
  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader className="pt-2 pb-2">
        <Link
          to="/"
          aria-label="Kanvil"
          activeProps={{ className: "" }}
          className="brand flex h-9 items-center gap-2 bg-transparent px-1.5 text-foreground"
        >
          <Brand />
        </Link>
        <WorkspaceSwitcher />
        <CommandPalette />
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label={t("shell.sidebar.workspace")}>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={pathname === "/"}
                    tooltip={t("shell.page.home")}
                    render={<Link to="/" activeOptions={{ exact: true }} />}
                  >
                    <House />
                    <span>{t("shell.page.home")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={pathname === "/my-work"}
                    tooltip={t("shell.page.myWork")}
                    render={<Link to="/my-work" />}
                  >
                    <UserCheck />
                    <span>{t("shell.page.myWork")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={pathname === "/inbox"}
                    tooltip={t("shell.page.inbox")}
                    render={<Link to="/inbox" />}
                  >
                    <Bell />
                    <span>{t("shell.page.inbox")}</span>
                  </SidebarMenuButton>
                  {unread > 0 && (
                    <SidebarMenuBadge
                      className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground tabular-nums animate-in zoom-in-75 duration-200"
                      aria-label={t("shell.sidebar.unread", { count: unread })}
                    >
                      {unread > 99 ? "99+" : unread}
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup className="mt-1">
            <SidebarGroupLabel>{t("shell.page.projects")}</SidebarGroupLabel>
            <CreateProject sidebarAction />
            <SidebarGroupContent>
              <SidebarMenu>
                {projects.data?.map((project) => (
                  <SidebarMenuItem
                    key={project.id}
                    className="data-[dragging=true]:opacity-50 data-[drop=after]:shadow-[inset_0_-2px_0_var(--primary)] data-[drop=before]:shadow-[inset_0_2px_0_var(--primary)]"
                    {...drag.item(project.id, {
                      draggable: capabilitiesOf(project).includes("project.manage"),
                    })}
                  >
                    <ProjectContextMenu project={project}>
                      <SidebarMenuButton
                        isActive={pathname.startsWith(`/projects/${project.id}`)}
                        tooltip={project.name}
                        title={project.name}
                        className="grid grid-cols-[1rem_minmax(0,1fr)_auto] group-data-[collapsible=icon]:flex"
                        render={
                          <Link to="/projects/$projectId" params={{ projectId: project.id }} />
                        }
                      >
                        <ProjectIcon project={project} className="size-4" />
                        <span dir="auto" className="min-w-0 truncate">
                          {project.name}
                        </span>
                        <SidebarMenuBadge
                          aria-hidden="true"
                          className="static h-auto min-w-0 p-0 font-mono text-[10px] text-muted-foreground group-data-[collapsible=icon]:hidden"
                        >
                          {project.key}
                        </SidebarMenuBadge>
                      </SidebarMenuButton>
                    </ProjectContextMenu>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
              <ErrorNotice error={projects.error} />
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <AccountMenu />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
function AccountMenu() {
  const identity = useIdentity(),
    { isMobile } = useSidebar();
  const [error, setError] = useState<unknown>();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-account-menu
          render={<SidebarMenuButton size="lg" className="mt-2" tooltip={identity.name} />}
        >
          <UserAvatar name={identity.name} image={identity.image} />
          <span className="grid flex-1 text-left text-xs leading-tight">
            <span className="truncate font-medium">{identity.name}</span>
            <span className="truncate text-muted-foreground">{identity.email}</span>
          </span>
          <ChevronsUpDown className="ml-auto" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side={isMobile ? "top" : "right"} align="end" className="min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{identity.email}</DropdownMenuLabel>
            <DropdownMenuItem render={<Link to="/settings" />}>
              <Settings />
              {t("shell.sidebar.userSettings")}
            </DropdownMenuItem>
            {identity.admin && (
              <DropdownMenuItem render={<Link to="/admin" />}>
                <ShieldCheck />
                {t("shell.sidebar.administration")}
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              void signOut(identity).catch(setError);
            }}
          >
            <LogOut />
            {t("shell.sidebar.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ErrorNotice error={error} />
    </>
  );
}
function CommandPalette() {
  const [open, setOpen] = useState(false),
    [help, setHelp] = useState(false),
    [query, setQuery] = useState(""),
    [creating, setCreating] = useState(false),
    projects = useProjects(),
    navigate = useNavigate(),
    preview = useTicketPreview(),
    identity = useIdentity(),
    { setMode } = useTheme(),
    pathname = useRouterState({ select: (state) => state.location.pathname });
  const resolved = document.documentElement.classList.contains("dark") ? "dark" : "light";
  const projectId = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const project = useProject(projectId ?? "").data;
  const access = useProjectAccess(projectId ?? "", !!projectId);
  const ticketId = pathname.match(/^\/projects\/[^/]+\/tickets\/([^/]+)/)?.[1];
  const current = useQuery({
    ...api.query("get_ticket", { projectId: projectId ?? "", ticketId: ticketId ?? "" }),
    enabled: open && !!projectId && !!ticketId,
  }).data?.ticket;
  const trimmed = query.trim();
  // Other projects' settings join once a search is typed, so the empty list stays short.
  const settings = useSettingsGroups().flatMap((group) =>
    group.entries.flatMap((entry) =>
      !entry.project
        ? [{ ...entry, scope: group.label }]
        : entry.project.id === projectId || trimmed
          ? (entry.children ?? []).map((child) => ({ ...child, scope: entry.label }))
          : [],
    ),
  );
  const workspace = useWorkspace();
  const results = useQuery({
    ...api.query("search_workspace", {
      q: trimmed,
      ...(workspace.active ? { workspaceId: workspace.active.id } : {}),
      limit: 8,
    }),
    enabled: open && trimmed.length > 1,
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  useShortcut("?", () => setHelp(true), { enabled: !help && !open });
  const go = (to: string) => {
    setOpen(false);
    void navigate({ to });
  };
  const run = (action: () => void) => {
    setOpen(false);
    action();
  };
  // A typed key such as TAL-1061 jumps straight to that ticket in any accessible project.
  const keyMatch = /^([a-z][a-z0-9]{1,9})-(\d+)$/i.exec(trimmed),
    keyProject = keyMatch
      ? projects.data?.find((item) => item.key === keyMatch[1]?.toUpperCase())
      : undefined;
  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip={t("shell.palette.open")}
            onClick={() => setOpen(true)}
            className="text-muted-foreground"
          >
            <Search />
            <span>{t("shell.palette.open")}</span>
            <Kbd className="ml-auto group-data-[collapsible=icon]:hidden">⌘K</Kbd>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <CommandDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
        title={t("shell.palette.title")}
        description={t("shell.palette.description")}
        className="sm:max-w-xl"
      >
        <Command>
          <CommandInput
            placeholder={t("shell.palette.placeholder")}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>
              {results.isFetching ? t("shell.palette.searching") : t("shell.palette.noResults")}
            </CommandEmpty>
            {keyProject && keyMatch && (
              <CommandGroup heading={t("shell.palette.jumpTo")}>
                <CommandItem
                  value={paletteWords((tr) =>
                    tr("shell.palette.keywords.jump", { query: trimmed }),
                  )}
                  onSelect={() => go(`/projects/${keyProject.id}/tickets/${trimmed.toUpperCase()}`)}
                >
                  <ProjectIcon project={keyProject} className="size-4" />
                  {t("shell.palette.openKey", {
                    key: trimmed.toUpperCase(),
                    project: keyProject.name,
                  })}
                </CommandItem>
              </CommandGroup>
            )}
            {trimmed.length > 1 && (
              <CommandGroup
                heading={
                  workspace.active
                    ? t("shell.palette.resultsIn", { workspace: workspace.active.name })
                    : t("shell.palette.results")
                }
              >
                {/* Projects already have their own group below. */}
                {results.data?.items
                  .filter((result) => result.type !== "project")
                  .map((result) => (
                    <CommandItem
                      key={`${result.type}:${result.id}`}
                      value={`${result.type}:${result.id}`}
                      // The server already matched these; keep them through the palette's own filter.
                      keywords={[trimmed]}
                      onSelect={() =>
                        run(() => {
                          // Tickets and comments open in the preview sheet over the page.
                          if (preview && result.ticket)
                            preview.open({
                              projectId: result.project.id,
                              ticketId: result.ticket.id,
                              hash: searchResultAnchor(result),
                            });
                          else void navigate(searchResultLink(result));
                        })
                      }
                    >
                      <SearchResultContent result={result} compact />
                    </CommandItem>
                  ))}
                {results.data && results.data.total > 0 && (
                  <CommandItem
                    value={paletteWords((tr) =>
                      tr("shell.palette.keywords.allResults", { query: trimmed }),
                    )}
                    keywords={[trimmed]}
                    onSelect={() =>
                      run(() => void navigate({ to: "/search", search: { q: trimmed } }))
                    }
                  >
                    <Search />
                    {t("shell.palette.seeAll", { count: results.data.total })}
                  </CommandItem>
                )}
              </CommandGroup>
            )}
            <CommandGroup heading={t("shell.palette.actions")}>
              {project && access.canWrite && (
                <CommandItem
                  value={paletteWords((tr) => tr("shell.palette.keywords.newTicket"))}
                  onSelect={() => run(() => setCreating(true))}
                >
                  <Plus />
                  {t("shell.palette.newTicketIn", { project: project.name })}
                  <CommandShortcut>{actions.newTicket.keys}</CommandShortcut>
                </CommandItem>
              )}
              {project && (
                <CommandItem
                  value={paletteWords((tr) => tr("shell.palette.keywords.myTickets"))}
                  onSelect={() =>
                    run(() => {
                      void navigate({
                        to: "/projects/$projectId",
                        params: { projectId: project.id },
                        search: { assigneeId: identity.id },
                      });
                    })
                  }
                >
                  <UserCheck />
                  {t("shell.palette.myTicketsIn", { project: project.name })}
                </CommandItem>
              )}
              {
                <CommandItem
                  value={
                    resolved === "dark"
                      ? paletteWords((tr) => tr("shell.palette.keywords.lightMode"))
                      : paletteWords((tr) => tr("shell.palette.keywords.darkMode"))
                  }
                  onSelect={() => run(() => setMode(resolved === "dark" ? "light" : "dark"))}
                >
                  {resolved === "dark" ? <Sun /> : <Moon />}
                  {resolved === "dark" ? t("shell.palette.lightMode") : t("shell.palette.darkMode")}
                </CommandItem>
              }
              {
                <CommandItem
                  value={paletteWords((tr) => tr("shell.palette.keywords.help"))}
                  onSelect={() => run(() => setHelp(true))}
                >
                  <Keyboard />
                  {actions.help.label}
                  <CommandShortcut>{actions.help.keys}</CommandShortcut>
                </CommandItem>
              }
            </CommandGroup>
            {current && (
              <CommandGroup heading={current.key}>
                {ticketCopyActions.map((action) => (
                  <CommandItem
                    key={action.label}
                    value={`${current.key} ${action.label}`}
                    onSelect={() => run(() => void copyTicket(action, current))}
                  >
                    <action.icon />
                    {action.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading={t("shell.palette.pages")}>
              {
                <CommandItem
                  value={paletteWords((tr) => tr("shell.palette.keywords.home"))}
                  onSelect={() => go("/")}
                >
                  <House />
                  {t("shell.page.home")}
                </CommandItem>
              }
              {
                <CommandItem
                  value={paletteWords((tr) => tr("shell.palette.keywords.myWork"))}
                  onSelect={() => go("/my-work")}
                >
                  <UserCheck />
                  {t("shell.page.myWork")}
                </CommandItem>
              }
              {
                <CommandItem
                  value={paletteWords((tr) => tr("shell.palette.keywords.search"))}
                  onSelect={() => go("/search")}
                >
                  <Search />
                  {t("shell.page.search")}
                </CommandItem>
              }
              {
                <CommandItem
                  value={paletteWords((tr) => tr("shell.palette.keywords.inbox"))}
                  onSelect={() => go("/inbox")}
                >
                  <Bell />
                  {t("shell.page.inbox")}
                </CommandItem>
              }
            </CommandGroup>
            <CommandGroup heading={t("shell.page.settings")}>
              {settings.map((entry) => (
                <CommandItem
                  key={`${entry.to}:${entry.section}`}
                  value={paletteWords((tr) =>
                    tr("shell.palette.keywords.settings", {
                      scope: entry.scope,
                      label: entry.label,
                    }),
                  )}
                  onSelect={() =>
                    run(() => {
                      void navigate({ to: entry.to, search: { section: entry.section } });
                    })
                  }
                >
                  {entry.icon ? <entry.icon /> : <Settings />}
                  {entry.label}
                  <CommandShortcut>{entry.scope}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading={t("shell.page.projects")}>
              {projects.data?.map((item) => (
                <CommandItem
                  key={item.id}
                  value={`${item.name} ${item.key}`}
                  onSelect={() => go(`/projects/${item.id}`)}
                >
                  <ProjectIcon project={item} className="size-4" />
                  {item.name}
                  <CommandShortcut>{item.key}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
      <Modal title={actions.help.label} open={help} onOpenChange={setHelp}>
        {shortcutGroups.map((group) => (
          <section key={group.category} aria-labelledby={`shortcuts-${group.category}`}>
            <h3
              id={`shortcuts-${group.category}`}
              className="mt-4 mb-2 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase first:mt-0"
            >
              {t(`shell.actionCategory.${group.category}`)}
            </h3>
            <dl className="grid grid-cols-[5.5rem_1fr] items-center gap-x-6 gap-y-2.5 text-sm">
              {group.actions.map((action) => (
                <div key={action.label} className="contents">
                  <dt>
                    <KbdGroup>
                      {action.keys.split(" ").map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </KbdGroup>
                  </dt>
                  <dd className="m-0">{action.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </Modal>
      {project && (
        <Modal
          size="composer"
          title={actions.newTicket.label}
          open={creating}
          onOpenChange={setCreating}
        >
          {creating && (
            <Suspense fallback={<Loading />}>
              <TicketEditor projectId={project.id} onSaved={() => setCreating(false)} />
            </Suspense>
          )}
        </Modal>
      )}
    </>
  );
}
export function WorkspaceHeader() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // Archived projects still open by link, so the header resolves them too.
  const project = useProject(pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? "").data;
  const ticketId = pathname.match(/\/tickets\/([^/]+)/)?.[1];
  const ticket = useQuery({
    ...api.query("get_ticket", { projectId: project?.id ?? "", ticketId: ticketId ?? "" }),
    enabled: !!project && !!ticketId,
  });
  const projectList = project && pathname === `/projects/${project.id}`,
    planning = !!project && pathname === `/projects/${project.id}/planning`;
  const { section } = useSearch({ strict: false }),
    place = settingsLocation(useSettingsGroups(), pathname, section);
  const page = place
    ? place.group.title
    : pathname === "/inbox"
      ? t("shell.page.inbox")
      : pathname === "/my-work"
        ? t("shell.page.myWork")
        : pathname === "/search"
          ? t("shell.page.search")
          : planning
            ? t("shell.page.planning")
            : pathname === "/admin" || pathname.endsWith("/settings")
              ? t("shell.page.settings")
              : ticketId
                ? (ticket.data?.ticket.key ?? t("shell.page.ticket"))
                : t("shell.page.tickets");
  return (
    <header className="workspace-header sticky top-0 z-20 flex h-11 shrink-0 items-center gap-3 rounded-t-lg border-b bg-background/95 px-4 backdrop-blur-sm max-[650px]:[&_[data-slot=breadcrumb-item]]:min-w-0 max-[650px]:[&_[data-slot=breadcrumb-link]]:max-w-28 max-[650px]:[&_[data-slot=breadcrumb-link]]:truncate max-[650px]:[&_[data-slot=breadcrumb-list]]:gap-1.5 max-[650px]:[&_[data-slot=breadcrumb-list]]:text-xs md:px-6">
      <SidebarTrigger />
      <Breadcrumb className={projectList || place ? "min-w-0 flex-1" : undefined}>
        <BreadcrumbList
          className={projectList || place ? "min-w-0 flex-nowrap overflow-hidden" : undefined}
        >
          <BreadcrumbItem>
            {pathname === "/" ? (
              <BreadcrumbPage>{t("shell.page.home")}</BreadcrumbPage>
            ) : (
              <BreadcrumbLink render={<Link to="/" />}>{t("shell.page.home")}</BreadcrumbLink>
            )}
          </BreadcrumbItem>
          {project && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                {projectList ? (
                  <h1
                    className="m-0 truncate text-[13px] font-medium tracking-normal"
                    title={project.name}
                  >
                    <BreadcrumbPage>{project.name}</BreadcrumbPage>
                  </h1>
                ) : (
                  <BreadcrumbLink
                    render={<Link to="/projects/$projectId" params={{ projectId: project.id }} />}
                  >
                    {project.name}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </>
          )}
          {pathname !== "/" && !projectList && (
            <>
              {/* On a phone the page heading already names the settings scope. */}
              <BreadcrumbSeparator className={place ? "max-[650px]:hidden" : undefined} />
              <BreadcrumbItem className={place ? "max-[650px]:hidden" : undefined}>
                {place ? (
                  <BreadcrumbLink render={<Link to={place.entry.to} />}>{page}</BreadcrumbLink>
                ) : pathname === "/my-work" || planning ? (
                  // These lists' controls have no title of their own, like a project list.
                  <h1 className="m-0 text-[13px] font-medium tracking-normal">
                    <BreadcrumbPage>{page}</BreadcrumbPage>
                  </h1>
                ) : (
                  <BreadcrumbPage className={ticketId ? "font-mono text-xs" : undefined}>
                    {page}
                  </BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </>
          )}
          {place && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate">{place.entry.label}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>
      {projectList && (
        <IconButton
          label={t("shell.sidebar.projectSettings")}
          className="ml-auto"
          render={<Link to="/projects/$projectId/settings" params={{ projectId: project.id }} />}
        >
          <Settings />
        </IconButton>
      )}
    </header>
  );
}
