import { createHeaderAction } from "./navigation-actions.tsx";
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { capabilitiesOf } from "@kanvil/contracts";
import { useProjectNavigation } from "./navigation.ts";
import { ProjectIcon } from "./project-icon.tsx";
import { t } from "@kanvil/contracts/i18n";
import { useProjects, useWorkspace, useOperation } from "./data.tsx";
import {
  nativeHeaderOptions,
  Body,
  Button,
  Choice,
  Sheet,
  ErrorNotice,
  Field,
  Loading,
  List,
  Row,
  Screen,
} from "./ui.tsx";

export function Projects({ footer, picker = false }: { footer?: ReactNode; picker?: boolean }) {
  const projectNavigation = useProjectNavigation();
  const navigation = useNavigation();
  const [includeArchived, setIncludeArchived] = useState(false);
  const projects = useProjects(includeArchived),
    workspace = useWorkspace();
  const [search, setSearch] = useState<{ workspaceId: string | undefined; query: string }>({
    workspaceId: workspace.active?.id,
    query: "",
  });
  const query = search.workspaceId === workspace.active?.id ? search.query : "";
  const [creating, setCreating] = useState<string>();
  const canCreate = !!workspace.active && capabilitiesOf(workspace.active).includes("ticket.write");
  useLayoutEffect(() => {
    navigation.setOptions(
      nativeHeaderOptions({
        unstable_headerRightItems: (): NativeStackHeaderItem[] => [
          createHeaderAction(
            t("native.projects.new"),
            () => setCreating(workspace.active?.id),
            { type: "sfSymbol", name: "plus" },
            !canCreate,
          ),
          {
            type: "menu",
            label: t("shell.page.projects"),
            icon: { type: "sfSymbol", name: "ellipsis" },
            menu: {
              items: [
                {
                  type: "action",
                  label: t("shell.app.archivedProjects"),
                  state: includeArchived ? "on" : "off",
                  onPress: () => setIncludeArchived((previous) => !previous),
                },
                ...(picker
                  ? [
                      ...(projectNavigation.currentProjectId
                        ? [
                            {
                              type: "action" as const,
                              label: t("shell.settingsNav.projectSettings"),
                              onPress: () =>
                                projectNavigation.selectProject(
                                  projectNavigation.currentProjectId ?? "",
                                  true,
                                ),
                            },
                          ]
                        : []),
                      ...(workspace.active
                        ? [
                            {
                              type: "action" as const,
                              label: t("shell.workspace.settings"),
                              onPress: () => {
                                if (workspace.active)
                                  projectNavigation.workspaceSettings(workspace.active.id);
                              },
                            },
                          ]
                        : []),
                      {
                        type: "action" as const,
                        label: t("shell.workspace.new"),
                        onPress: projectNavigation.createWorkspace,
                      },
                    ]
                  : []),
              ],
            },
          },
        ],
      }),
    );
  }, [navigation, canCreate, includeArchived, workspace.active, picker, projectNavigation]);
  return (
    <Screen scroll={false}>
      <View style={{ padding: 20, gap: 12 }}>
        {picker && (
          <Choice
            label={t("shell.workspace.workspaces")}
            value={workspace.active?.id ?? ""}
            options={workspace.workspaces.map((space) => ({ value: space.id, label: space.name }))}
            onChange={(id) => {
              projectNavigation.selectWorkspace(id);
              projectNavigation.showPicker();
            }}
          />
        )}
        <Field
          label={t("shell.app.searchProjects")}
          value={query}
          onChangeText={(value) => setSearch({ workspaceId: workspace.active?.id, query: value })}
          autoCorrect={false}
        />
      </View>
      <ErrorNotice error={projects.error} />
      {projects.isPending ? (
        <Loading />
      ) : (
        <List
          data={(projects.data ?? []).filter((project) =>
            `${project.name} ${project.key}`
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase()),
          )}
          ListFooterComponent={footer && !query.trim() ? <>{footer}</> : undefined}
          keyExtractor={(project) => project.id}
          onRefresh={() => {
            void projects.refetch();
          }}
          refreshing={projects.isRefetching}
          ListEmptyComponent={
            <View style={{ padding: 20 }}>
              <Body muted>
                {t(query.trim() ? "shell.app.noMatchingProjects" : "native.projects.empty")}
              </Body>
            </View>
          }
          renderItem={({ item }) => (
            <Row
              title={item.name}
              selected={item.id === projectNavigation.currentProjectId}
              leading={<ProjectIcon project={item} />}
              overline={item.archivedAt ? `${item.key} · ${t("shell.app.archived")}` : item.key}
              caption={item.description}
              onPress={() => projectNavigation.selectProject(item.id)}
            />
          )}
        />
      )}
      {creating && (
        <ProjectAction
          workspaceId={creating}
          onClose={() => setCreating(undefined)}
          onCreated={projectNavigation.selectProject}
        />
      )}
    </Screen>
  );
}
export { Tickets } from "./ticket-list.tsx";

function ProjectAction({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  onClose: () => void;
  onCreated: (projectId: string) => void;
}) {
  const [name, setName] = useState(""),
    [key, setKey] = useState(""),
    [description, setDescription] = useState(""),
    [visibility, setVisibility] = useState<"private" | "workspace">("private");
  const create = useOperation("create_project");
  return (
    <>
      <Sheet title={t("native.projects.new")} open onClose={onClose}>
        <Field
          label={t("native.projects.name")}
          value={name}
          onChangeText={setName}
          maxLength={120}
        />
        <Field
          label={t("native.projects.prefix")}
          value={key}
          onChangeText={(value) => setKey(value.toUpperCase())}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={10}
        />
        <Field
          label={t("native.projects.description")}
          value={description}
          onChangeText={setDescription}
          multiline
          maxLength={5000}
        />
        <ErrorNotice error={create.error} />
        <Choice
          label={t("settings.project.access")}
          value={visibility}
          options={(["private", "workspace"] as const).map((value) => ({
            value,
            label: t(`settings.project.visibility.${value}`),
          }))}
          onChange={(value) => setVisibility(value === "workspace" ? "workspace" : "private")}
        />
        <Button
          title={t("native.projects.create")}
          disabled={create.isPending || !name.trim() || key.length < 2}
          primary
          onPress={() => {
            void create
              .mutateAsync({ workspaceId, name, key, description, visibility })
              .then((project) => {
                onClose();
                setName("");
                setKey("");
                setDescription("");
                onCreated(project.id);
              })
              .catch(() => {});
          }}
        />
      </Sheet>
    </>
  );
}
