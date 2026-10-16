import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Settings2, Users } from "lucide-react";
import { toast } from "sonner";
import { api, useAllProjects, useOperation, useWorkspaces } from "../data.tsx";
import { Button, CopyButton, EmptyState, ErrorNotice, Loading } from "../ui.tsx";
import { Badge } from "@/components/ui/badge";
import { TabsContent } from "@/components/ui/tabs";
import { EditableHeading, SettingsLayout, SettingRow } from "./settings-layout.tsx";
import { MemberDirectory } from "./member-directory.tsx";
const sections = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "members", label: "Members", icon: Users },
];
export function WorkspaceSettings({
  workspaceId,
  section,
  onSectionChange,
}: {
  workspaceId: string;
  section: "general" | "members";
  onSectionChange: (value: string) => void;
}) {
  const spaces = useWorkspaces(),
    projects = useAllProjects(),
    workspace = spaces.data?.find((space) => space.id === workspaceId);
  const people = useQuery({
    ...api.query("list_workspace_members", { workspaceId }),
    enabled: !!workspace?.role,
  });
  const update = useOperation("update_workspace"),
    member = useOperation("set_workspace_member");
  if (spaces.isPending) return <Loading />;
  if (!workspace?.role)
    return (
      <EmptyState title="Workspace unavailable">
        <ErrorNotice error={spaces.error} />
        <Button render={<Link to="/" />}>Back to projects</Button>
      </EmptyState>
    );
  const canAdmin = workspace.role === "admin",
    count = projects.data?.filter((project) => project.workspaceId === workspace.id).length ?? 0;
  return (
    <>
      <SettingsLayout
        title="Workspace settings"
        value={section}
        onChange={onSectionChange}
        sections={sections}
      >
        <TabsContent value="general">
          <section>
            <EditableHeading
              name={workspace.name}
              description={workspace.description}
              nameLabel="Workspace name"
              canEdit={canAdmin}
              version={workspace.version}
              pending={update.isPending}
              error={update.error}
              editLabel="Edit workspace"
              badges={
                <>
                  <Badge variant="secondary" className="ml-0.5 font-mono text-[10px] font-normal">
                    {workspace.slug}
                  </Badge>
                  <CopyButton label="Copy workspace key" value={workspace.slug} size="icon-xs" />
                </>
              }
              onSave={(draft) =>
                update
                  .mutateAsync({
                    workspaceId,
                    expectedVersion: workspace.version,
                    name: draft.name,
                    description: draft.description,
                  })
                  .then(() => toast.success("Workspace saved"))
              }
            />
          </section>
          <section>
            <SettingRow
              title="Projects"
              description={`${count} ${count === 1 ? "project" : "projects"} you can access in this workspace.`}
            >
              <Button render={<Link to="/" />}>View projects</Button>
            </SettingRow>
            <SettingRow
              title="Members"
              description="Workspace roles apply to projects that use workspace access."
            >
              <Button onClick={() => onSectionChange("members")}>Manage members</Button>
            </SettingRow>
          </section>
        </TabsContent>
        <TabsContent value="members">
          <MemberDirectory
            people={people.data ?? []}
            pending={member.isPending}
            loading={people.isPending}
            error={people.error}
            canAdmin={canAdmin}
            scope="workspace"
            onChange={(email, role) => member.mutateAsync({ workspaceId, email, role })}
          />
        </TabsContent>
      </SettingsLayout>
    </>
  );
}
