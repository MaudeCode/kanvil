import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pencil, Settings2, Users } from "lucide-react";
import { toast } from "sonner";
import { api, useAllProjects, useOperation, useWorkspaces } from "../data.tsx";
import {
  Button,
  CopyValue,
  EmptyState,
  ErrorNotice,
  Input,
  Loading,
  Modal,
  SectionHeading,
  Textarea,
} from "../ui.tsx";
import { TabsContent } from "@/components/ui/tabs";
import { SettingsLayout, SettingRow } from "./settings-layout.tsx";
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
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState({ name: "", description: "", version: 1 });
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
            <SectionHeading
              title={workspace.name}
              action={
                canAdmin && (
                  <Button
                    onClick={() => {
                      setDraft({
                        name: workspace.name,
                        description: workspace.description,
                        version: workspace.version,
                      });
                      update.reset();
                      setEditing(true);
                    }}
                  >
                    <Pencil />
                    Edit workspace
                  </Button>
                )
              }
            />
            {workspace.description && (
              <p className="max-w-xl whitespace-pre-wrap text-muted-foreground">
                {workspace.description}
              </p>
            )}
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
            <div className="pt-6">
              <CopyValue label="Workspace key" value={workspace.slug} />
            </div>
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
      <Modal
        title="Edit workspace"
        open={editing}
        onOpenChange={setEditing}
        busy={update.isPending}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void update
              .mutateAsync({
                workspaceId,
                expectedVersion: draft.version,
                name: draft.name,
                description: draft.description,
              })
              .then(() => {
                setEditing(false);
                toast.success("Workspace saved");
              })
              .catch(() => {});
          }}
        >
          <Input
            label="Workspace name"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            required
            maxLength={120}
            autoFocus
          />
          <Textarea
            label="Description"
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            maxLength={5000}
          />
          <ErrorNotice error={update.error} />
          <div className="dialog-actions">
            <Button disabled={update.isPending} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={update.isPending || workspace.version !== draft.version}
            >
              Save workspace
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
