import { ProjectIcon } from "./project-icon.tsx";
import { WorkspaceSwitcher } from "./workspace-switcher.tsx";
import { ProjectContextMenu } from "./object-context-menu.tsx";
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
import { notificationsSchema } from "@kanvil/contracts";
import { api, auth, useIdentity, useProjects, useProjectAccess, useWorkspace } from "../data.tsx";
import { Brand, ErrorNotice, IconButton, Loading, Modal } from "../ui.tsx";
import { CreateProject } from "./create-project.tsx";
import { SearchResultContent, searchResultLink } from "./search-result.tsx";
import { useTheme } from "./theme-provider.tsx";
import { useShortcut } from "../hooks/use-shortcut.ts";
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
const TicketEditor = lazy(() =>
  import("../ticket-editor.tsx").then((module) => ({ default: module.TicketEditor })),
);

export function useUnreadNotifications() {
  const projects = useProjects();
  const items = useQuery({
    queryKey: ["kanvil", "notifications"],
    queryFn: () => api.request("/api/v1/notifications", notificationsSchema),
  });
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
        <nav aria-label="Workspace">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={pathname === "/"}
                    tooltip="Home"
                    render={<Link to="/" activeOptions={{ exact: true }} />}
                  >
                    <House />
                    <span>Home</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={pathname === "/my-work"}
                    tooltip="My work"
                    render={<Link to="/my-work" />}
                  >
                    <UserCheck />
                    <span>My work</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={pathname === "/inbox"}
                    tooltip="Inbox"
                    render={<Link to="/inbox" />}
                  >
                    <Bell />
                    <span>Inbox</span>
                  </SidebarMenuButton>
                  {unread > 0 && (
                    <SidebarMenuBadge
                      className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground tabular-nums animate-in zoom-in-75 duration-200"
                      aria-label={`${unread} unread`}
                    >
                      {unread > 99 ? "99+" : unread}
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup className="mt-1">
            <SidebarGroupLabel>Projects</SidebarGroupLabel>
            <CreateProject sidebarAction />
            <SidebarGroupContent>
              <SidebarMenu>
                {projects.data?.map((project) => (
                  <SidebarMenuItem key={project.id}>
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
                        <span className="min-w-0 truncate">{project.name}</span>
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
  async function logout() {
    const result = await auth.signOut();
    if (result.error) throw new Error(result.error.message);
    identity.clearPrivateData();
    window.location.assign("/login");
  }
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
              User settings
            </DropdownMenuItem>
            {identity.admin && (
              <DropdownMenuItem render={<Link to="/admin" />}>
                <ShieldCheck />
                Administration
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              void logout().catch(setError);
            }}
          >
            <LogOut />
            Sign out
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
    identity = useIdentity(),
    { setMode } = useTheme(),
    pathname = useRouterState({ select: (state) => state.location.pathname });
  const resolved = document.documentElement.classList.contains("dark") ? "dark" : "light";
  const projectId = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const project = projects.data?.find((item) => item.id === projectId);
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
            tooltip="Go to…"
            onClick={() => setOpen(true)}
            className="text-muted-foreground"
          >
            <Search />
            <span>Go to…</span>
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
        title="Go to"
        description="Find a project, ticket, page, or action"
        className="sm:max-w-xl"
      >
        <Command>
          <CommandInput
            placeholder="Search tickets, projects, pages, actions…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>{results.isFetching ? "Searching…" : "No results"}</CommandEmpty>
            {keyProject && keyMatch && (
              <CommandGroup heading="Jump to">
                <CommandItem
                  value={`${trimmed} jump open`}
                  onSelect={() => go(`/projects/${keyProject.id}/tickets/${trimmed.toUpperCase()}`)}
                >
                  <ProjectIcon project={keyProject} className="size-4" />
                  Open {trimmed.toUpperCase()} in {keyProject.name}
                </CommandItem>
              </CommandGroup>
            )}
            {trimmed.length > 1 && (
              <CommandGroup
                heading={workspace.active ? `Results in ${workspace.active.name}` : "Results"}
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
                      onSelect={() => run(() => void navigate(searchResultLink(result)))}
                    >
                      <SearchResultContent result={result} compact />
                    </CommandItem>
                  ))}
                {results.data && results.data.total > 0 && (
                  <CommandItem
                    value={`all results ${trimmed}`}
                    keywords={[trimmed]}
                    onSelect={() =>
                      run(() => void navigate({ to: "/search", search: { q: trimmed } }))
                    }
                  >
                    <Search />
                    See all {results.data.total} results
                  </CommandItem>
                )}
              </CommandGroup>
            )}
            <CommandGroup heading="Actions">
              {project && access.canWrite && (
                <CommandItem
                  value="new ticket create"
                  onSelect={() => run(() => setCreating(true))}
                >
                  <Plus />
                  {actions.newTicket.label} in {project.name}
                  <CommandShortcut>{actions.newTicket.keys}</CommandShortcut>
                </CommandItem>
              )}
              {project && (
                <CommandItem
                  value="my tickets assigned to me"
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
                  My tickets in {project.name}
                </CommandItem>
              )}
              {
                <CommandItem
                  value={`switch to ${resolved === "dark" ? "light" : "dark"} mode theme appearance`}
                  onSelect={() => run(() => setMode(resolved === "dark" ? "light" : "dark"))}
                >
                  {resolved === "dark" ? <Sun /> : <Moon />}
                  Switch to {resolved === "dark" ? "light" : "dark"} mode
                </CommandItem>
              }
              {
                <CommandItem
                  value="keyboard shortcuts help"
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
            <CommandGroup heading="Pages">
              {
                <CommandItem value="home overview all projects" onSelect={() => go("/")}>
                  <House />
                  Home
                </CommandItem>
              }
              {
                <CommandItem value="my work assigned tickets" onSelect={() => go("/my-work")}>
                  <UserCheck />
                  My work
                </CommandItem>
              }
              {
                <CommandItem
                  value="search comments activity projects tickets"
                  onSelect={() => go("/search")}
                >
                  <Search />
                  Search
                </CommandItem>
              }
              {
                <CommandItem value="inbox notifications" onSelect={() => go("/inbox")}>
                  <Bell />
                  Inbox
                </CommandItem>
              }
            </CommandGroup>
            <CommandGroup heading="Settings">
              {settings.map((entry) => (
                <CommandItem
                  key={`${entry.to}:${entry.section}`}
                  value={`settings ${entry.scope} ${entry.label}`}
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
            <CommandGroup heading="Projects">
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
      <Modal title="Keyboard shortcuts" open={help} onOpenChange={setHelp}>
        {shortcutGroups.map((group) => (
          <section key={group.category} aria-labelledby={`shortcuts-${group.category}`}>
            <h3
              id={`shortcuts-${group.category}`}
              className="mt-4 mb-2 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase first:mt-0"
            >
              {group.category}
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
        <Modal size="composer" title="New ticket" open={creating} onOpenChange={setCreating}>
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
  const pathname = useRouterState({ select: (state) => state.location.pathname }),
    projects = useProjects();
  const project = projects.data?.find((item) => pathname.startsWith(`/projects/${item.id}`));
  const ticketId = pathname.match(/\/tickets\/([^/]+)/)?.[1];
  const ticket = useQuery({
    ...api.query("get_ticket", { projectId: project?.id ?? "", ticketId: ticketId ?? "" }),
    enabled: !!project && !!ticketId,
  });
  const projectList = project && pathname === `/projects/${project.id}`;
  const { section } = useSearch({ strict: false }),
    place = settingsLocation(useSettingsGroups(), pathname, section);
  const page = place
    ? place.group.title
    : pathname === "/inbox"
      ? "Inbox"
      : pathname === "/my-work"
        ? "My work"
        : pathname === "/search"
          ? "Search"
          : pathname === "/admin" || pathname.endsWith("/settings")
            ? "Settings"
            : ticketId
              ? (ticket.data?.ticket.key ?? "Ticket")
              : "Tickets";
  return (
    <header className="workspace-header sticky top-0 z-20 flex h-11 shrink-0 items-center gap-3 rounded-t-lg border-b bg-background/95 px-4 backdrop-blur-sm max-[650px]:[&_[data-slot=breadcrumb-item]]:min-w-0 max-[650px]:[&_[data-slot=breadcrumb-link]]:max-w-28 max-[650px]:[&_[data-slot=breadcrumb-link]]:truncate max-[650px]:[&_[data-slot=breadcrumb-list]]:gap-1.5 max-[650px]:[&_[data-slot=breadcrumb-list]]:text-xs md:px-6">
      <SidebarTrigger />
      <Breadcrumb className={projectList || place ? "min-w-0 flex-1" : undefined}>
        <BreadcrumbList
          className={projectList || place ? "min-w-0 flex-nowrap overflow-hidden" : undefined}
        >
          <BreadcrumbItem>
            {pathname === "/" ? (
              <BreadcrumbPage>Home</BreadcrumbPage>
            ) : (
              <BreadcrumbLink render={<Link to="/" />}>Home</BreadcrumbLink>
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
                ) : pathname === "/my-work" ? (
                  // My work's list controls have no title of their own, like a project list.
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
          label="Project settings"
          className="ml-auto"
          render={<Link to="/projects/$projectId/settings" params={{ projectId: project.id }} />}
        >
          <Settings />
        </IconButton>
      )}
    </header>
  );
}
