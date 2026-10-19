import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import { permissions } from "@kanvil/contracts";
import { adminWorkspacesSchema, type AdminWorkspace } from "@kanvil/contracts/users";
import { api, useOperation } from "../data.tsx";
import {
  Button,
  EmptyState,
  ErrorNotice,
  Loading,
  Pager,
  RelativeTime,
  SearchField,
  SectionHeading,
} from "../ui.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { AccessRow } from "./account-details.tsx";
import { MemberDirectory } from "./member-directory.tsx";
import { InvitationList } from "./invitations.tsx";
import { t, formatList } from "@kanvil/contracts/i18n";
const size = 25;
export function WorkspacesSettings() {
  const [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<AdminWorkspace | null>(null);
  const spaces = useQuery({
    queryKey: ["kanvil", "admin-workspaces", query, offset],
    queryFn: () =>
      api.request(
        `/api/v1/admin/workspaces?${new URLSearchParams({ q: query, offset: String(offset), limit: String(size) })}`,
        adminWorkspacesSchema,
      ),
    placeholderData: keepPreviousData,
  });
  return (
    <section>
      <SectionHeading
        title={t("settings.workspaces.title")}
        action={
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <SearchField
              label={t("settings.workspaces.search")}
              placeholder={t("settings.workspaces.searchPlaceholder")}
              value={query}
              onChange={(value) => {
                setQuery(value);
                setOffset(0);
              }}
            />
          </div>
        }
      />
      <ErrorNotice error={spaces.error} />
      {spaces.isPending ? (
        <Loading />
      ) : !spaces.data?.workspaces.length ? (
        <EmptyState
          title={query ? t("settings.workspaces.noMatches") : t("settings.workspaces.empty")}
          className="py-12"
        />
      ) : (
        <div aria-busy={spaces.isFetching}>
          <Table mobileLayout="rows" aria-label={t("settings.workspaces.title")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("settings.workspaces.workspace")}</TableHead>
                <TableHead>{t("settings.workspaces.administrators")}</TableHead>
                <TableHead>{t("settings.workspaces.members")}</TableHead>
                <TableHead>{t("settings.workspaces.projects")}</TableHead>
                <TableHead>{t("settings.workspaces.created")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("settings.workspaces.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {spaces.data.workspaces.map((space) => (
                <TableRow key={space.id}>
                  <TableCell className="whitespace-normal">
                    <Button
                      variant="ghost"
                      className="h-auto max-w-full flex-col items-start gap-0.5 p-0 text-left hover:bg-transparent"
                      onClick={() => setSelected(space)}
                    >
                      <span dir="auto" className="font-medium wrap-anywhere whitespace-normal">
                        {space.name}
                      </span>
                      <span className="font-mono text-xs font-normal text-muted-foreground">
                        {space.slug}
                      </span>
                    </Button>
                  </TableCell>
                  <TableCell
                    data-label={t("settings.workspaces.administrators")}
                    className="text-xs wrap-anywhere whitespace-normal"
                  >
                    {space.administrators.length ? (
                      formatList(space.administrators.map((admin) => admin.name))
                    ) : (
                      <Badge variant="destructive">
                        {t("settings.workspaces.noAdministrator")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell data-label={t("settings.workspaces.members")} className="tabular-nums">
                    {space.memberCount}
                  </TableCell>
                  <TableCell
                    data-label={t("settings.workspaces.projects")}
                    className="tabular-nums"
                  >
                    {space.projectCount}
                  </TableCell>
                  <TableCell
                    data-label={t("settings.workspaces.created")}
                    className="text-xs text-muted-foreground"
                  >
                    <RelativeTime value={space.createdAt} />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("settings.workspaces.manage", { name: space.name })}
                      onClick={() => setSelected(space)}
                    >
                      <MoreHorizontal />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pager
        noun={t("settings.workspaces.pagerNoun")}
        offset={offset}
        total={spaces.data?.total ?? 0}
        size={size}
        onChange={setOffset}
      />
      <WorkspaceDetails
        key={selected?.id ?? "closed"}
        workspace={selected}
        onClose={() => setSelected(null)}
      />
    </section>
  );
}
// Instance administrators manage any workspace's members through the same operations and member
// directory as workspace settings; the server grants them access without a membership row.
function WorkspaceDetails({
  workspace,
  onClose,
}: {
  workspace: AdminWorkspace | null;
  onClose: () => void;
}) {
  const workspaceId = workspace?.id ?? "";
  const people = useQuery({
      ...api.query("list_workspace_members", { workspaceId }),
      enabled: !!workspace,
    }),
    projects = useQuery({
      ...api.query("list_projects", { workspaceId, archived: "include" }),
      enabled: !!workspace,
    }),
    roles = useQuery({
      ...api.query("list_workspace_roles", { workspaceId }),
      enabled: !!workspace,
    }),
    member = useOperation("set_workspace_member");
  return (
    <Sheet
      open={!!workspace}
      onOpenChange={(open) => {
        if (!open && !member.isPending) onClose();
      }}
    >
      <SheetContent className="w-full! sm:max-w-lg!">
        <SheetHeader className="shrink-0 border-b pr-14">
          <SheetTitle className="mb-0">
            {workspace?.name ?? t("settings.workspaces.workspace")}
          </SheetTitle>
          <SheetDescription className="font-mono">{workspace?.slug}</SheetDescription>
        </SheetHeader>
        <div className="@container min-h-0 overflow-y-auto px-6 pb-8">
          <MemberDirectory
            people={people.data ?? []}
            pending={member.isPending}
            loading={people.isPending}
            error={people.error}
            canAdmin
            ownerId={workspace?.ownerId}
            scope="workspace"
            roles={roles.data}
            authority={{ admin: true, capabilities: permissions }}
            onChange={(email, role) => member.mutateAsync({ workspaceId, email, role })}
          />
          {workspace && <InvitationList workspaceId={workspace.id} />}
          <section className="pt-7">
            <h3>{t("settings.workspaces.projects")}</h3>
            <ErrorNotice error={projects.error} />
            {projects.isPending ? (
              <Loading />
            ) : projects.data?.length ? (
              projects.data.map((project) => (
                <AccessRow
                  key={project.id}
                  badge={
                    project.visibility === "private"
                      ? t("settings.workspaces.private")
                      : t("settings.members.workspaceAccess")
                  }
                >
                  <Link
                    to="/projects/$projectId/settings"
                    params={{ projectId: project.id }}
                    search={{ section: "members" }}
                    onClick={onClose}
                    className="text-primary"
                  >
                    {project.name}
                  </Link>
                </AccessRow>
              ))
            ) : (
              <EmptyState title={t("settings.workspaces.noProjects")} className="py-5" />
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
