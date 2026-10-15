import { ProjectContextMenu } from "./object-context-menu.tsx";
import { useEffect, useState } from "react";
import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  ChevronsUpDown,
  FolderOpen,
  Layers,
  LogOut,
  Search,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { auth, clearPrivateStorage, useIdentity, useProjects } from "../data.tsx";
import { Brand, ErrorNotice } from "../ui.tsx";
import { CreateProject } from "./create-project.tsx";
import { ThemeMenu } from "./appearance.tsx";
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
import { Separator } from "@/components/ui/separator";
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

export function AppSidebar() {
  const identity = useIdentity();
  const projects = useProjects(),
    pathname = useRouterState({ select: (state) => state.location.pathname }),
    { setOpenMobile } = useSidebar();
  const router = useRouter();
  useEffect(
    () => router.subscribe("onBeforeNavigate", () => setOpenMobile(false)),
    [router, setOpenMobile],
  );
  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader className="pb-4 pt-3">
        <Link
          to="/"
          aria-label="Kanvil"
          activeProps={{ className: "" }}
          className="brand flex h-9 items-center gap-2 px-1.5"
        >
          <Brand />
        </Link>
        <ProjectSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Workspace">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={pathname === "/"}
                    tooltip="All projects"
                    render={<Link to="/" activeOptions={{ exact: true }} />}
                  >
                    <Layers />
                    <span>All projects</span>
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
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup className="mt-3">
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
                        render={
                          <Link to="/projects/$projectId" params={{ projectId: project.id }} />
                        }
                      >
                        <FolderOpen />
                        <span>{project.name}</span>
                      </SidebarMenuButton>
                    </ProjectContextMenu>
                    <SidebarMenuBadge className="font-mono text-[10px] text-muted-foreground">
                      {project.key}
                    </SidebarMenuBadge>
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
          {identity.admin && (
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname === "/admin"}
                tooltip="Administration"
                render={<Link to="/admin" />}
              >
                <ShieldCheck />
                <span>Administration</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === "/settings"}
              tooltip="Settings"
              render={<Link to="/settings" />}
            >
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
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
    cache = useQueryClient(),
    { isMobile } = useSidebar();
  const [error, setError] = useState<unknown>();
  async function logout() {
    const result = await auth.signOut();
    if (result.error) throw new Error(result.error.message);
    cache.clear();
    clearPrivateStorage(identity.id);
    window.location.assign("/login");
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
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
              Account settings
            </DropdownMenuItem>
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
function ProjectSwitcher() {
  const [open, setOpen] = useState(false),
    projects = useProjects(),
    navigate = useNavigate();
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
  const go = (to: string) => {
    setOpen(false);
    void navigate({ to });
  };
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
            <span className="ml-auto text-[10px] group-data-[collapsible=icon]:hidden">⌘ K</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Go to"
        description="Find a project or page"
      >
        <Command>
          <CommandInput placeholder="Find a project or page…" />
          <CommandList>
            <CommandEmpty>No results</CommandEmpty>
            <CommandGroup heading="Workspace">
              <CommandItem onSelect={() => go("/")}>
                <Layers />
                All projects<CommandShortcut>↵</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={() => go("/inbox")}>
                <Bell />
                Inbox
              </CommandItem>
              <CommandItem onSelect={() => go("/settings")}>
                <Settings />
                Settings
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="Projects">
              {projects.data?.map((project) => (
                <CommandItem
                  key={project.id}
                  value={`${project.name} ${project.key}`}
                  onSelect={() => go(`/projects/${project.id}`)}
                >
                  <FolderOpen />
                  {project.name}
                  <CommandShortcut>{project.key}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
export function WorkspaceHeader() {
  const pathname = useRouterState({ select: (state) => state.location.pathname }),
    projects = useProjects();
  const project = projects.data?.find((item) => pathname.startsWith(`/projects/${item.id}`));
  const page =
    pathname === "/admin"
      ? "Administration"
      : pathname === "/inbox"
        ? "Inbox"
        : pathname === "/settings"
          ? "Settings"
          : pathname.endsWith("/settings")
            ? "Project settings"
            : pathname.includes("/tickets/")
              ? "Ticket"
              : "Tickets";
  return (
    <header className="workspace-header flex h-14 shrink-0 items-center gap-3 border-b px-4 md:px-6">
      <SidebarTrigger />
      <Separator orientation="vertical" className="h-4!" />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            {pathname === "/" ? (
              <BreadcrumbPage>All projects</BreadcrumbPage>
            ) : (
              <BreadcrumbLink render={<Link to="/" />}>Projects</BreadcrumbLink>
            )}
          </BreadcrumbItem>
          {project && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink
                  render={<Link to="/projects/$projectId" params={{ projectId: project.id }} />}
                >
                  {project.name}
                </BreadcrumbLink>
              </BreadcrumbItem>
            </>
          )}
          {pathname !== "/" && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{page}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto">
        <ThemeMenu />
      </div>
    </header>
  );
}
