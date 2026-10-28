import { createHeaderAction, createHeaderMenu } from "./navigation-actions.tsx";
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { useCallback, useLayoutEffect, useState } from "react";
import { View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { capabilitiesOf, type Output } from "@kanvil/contracts";
import { useHeaderSearch, useProjectNavigation } from "./navigation.ts";
import { ProjectIcon } from "./project-icon.tsx";
import { t } from "@kanvil/contracts/i18n";
import { useProjects, useAllProjects, useWorkspace, useOperation, useIdentity } from "./data.tsx";
import {
  nativeHeaderOptions,
  Body,
  TicketGlyph,
  usePalette,
  Button,
  Choice,
  Sheet,
  ErrorNotice,
  EmptyState,
  Field,
  Loading,
  List,
  Row,
  Screen,
  RemovableSummary,
  WorkspaceScope,
  Heading,
} from "./ui.tsx";

export function Projects({ picker = false }: { picker?: boolean }) {
  const projectNavigation = useProjectNavigation();
  const navigation = useNavigation();
  const [includeArchived, setIncludeArchived] = useState(false);
  const projects = useProjects(includeArchived),
    workspace = useWorkspace(),
    allProjects = useAllProjects();
  const [search, setSearch] = useState<{ workspaceId: string | undefined; query: string }>({
    workspaceId: workspace.active?.id,
    query: "",
  });
  const query = search.workspaceId === workspace.active?.id ? search.query : "";
  const onQuery = useCallback(
    (value: string) => setSearch({ workspaceId: workspace.active?.id, query: value }),
    [workspace.active?.id],
  );
  const {
    options: searchOptions,
    setText: changeQuery,
    searching,
    open: openSearch,
  } = useHeaderSearch(query, onQuery, t("shell.app.searchProjects"));
  const [creating, setCreating] = useState<string>();
  const identity = useIdentity();
  const canCreate =
    !!workspace.active &&
    (identity.admin || capabilitiesOf(workspace.active).includes("ticket.write"));
  useLayoutEffect(() => {
    navigation.setOptions(
      nativeHeaderOptions({
        headerSearchBarOptions: searchOptions,
        unstable_headerRightItems: (): NativeStackHeaderItem[] => [
          ...(canCreate
            ? [
                createHeaderAction(
                  t("native.projects.new"),
                  () => setCreating(workspace.active?.id),
                  { type: "sfSymbol", name: "plus" },
                  false,
                  { visibilityPriority: "high", identifier: "project-create" },
                ),
              ]
            : []),
          createHeaderMenu(
            t("shell.page.projects"),
            { type: "sfSymbol", name: "gearshape" },
            [
              {
                type: "action",
                label: query.trim()
                  ? t("ticket.filter.searchChip", { query })
                  : t("shell.app.searchProjects"),
                icon: { type: "sfSymbol", name: "magnifyingglass" },
                onPress: openSearch,
              },
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
            {
              identifier: "project-options",
              visibilityPriority: "low",
              ...(query.trim() ? { badge: { value: 1 } } : {}),
            },
          ),
        ],
      }),
    );
  }, [
    navigation,
    canCreate,
    includeArchived,
    workspace.active,
    picker,
    projectNavigation,
    searchOptions,
    openSearch,
    query,
  ]);
  const candidates =
    picker && query.trim()
      ? allProjects.data?.filter((project) => includeArchived || !project.archivedAt)
      : projects.data;
  const filtered = (candidates ?? []).filter((project) =>
    `${project.name} ${project.key} ${picker ? (workspace.workspaces.find((space) => space.id === project.workspaceId)?.name ?? "") : ""}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const recent =
    picker && !query.trim()
      ? projectNavigation.contexts
          .recent()
          .flatMap((id) => {
            const project = filtered.find((item) => item.id === id);
            return project ? [project] : [];
          })
          .slice(0, 4)
      : [];
  const remaining = filtered.filter((project) => !recent.some((item) => item.id === project.id));
  return (
    <Screen
      scroll={false}
      scrollInsets
      header={
        <>
          {picker ? (
            <View style={{ paddingHorizontal: 20, paddingVertical: 8 }}>
              <Choice
                compact
                label={t("shell.workspace.workspaces")}
                value={workspace.active?.id ?? ""}
                options={workspace.workspaces.map((space) => ({
                  value: space.id,
                  label: space.name,
                }))}
                onChange={(id) => {
                  changeQuery("");
                  projectNavigation.selectWorkspace(id);
                }}
              />
            </View>
          ) : (
            <WorkspaceScope />
          )}
          {!searching && (
            <RemovableSummary
              label={t("shell.app.clearSearch")}
              value={query}
              onClear={() => changeQuery("")}
            />
          )}
          <ErrorNotice error={projects.error} background={!!projects.data} />
        </>
      }
    >
      <List
        data={remaining}
        ListHeaderComponent={
          recent.length ? (
            <View style={{ paddingTop: 8 }}>
              <View style={{ paddingHorizontal: 20 }}>
                <Heading compact>{t("native.navigation.recentProjects")}</Heading>
              </View>
              {recent.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  picker={picker}
                  selected={project.id === projectNavigation.currentProjectId}
                  onPress={() => projectNavigation.selectProject(project.id)}
                />
              ))}
              {remaining.length > 0 && (
                <View style={{ paddingHorizontal: 20, paddingTop: 16 }}>
                  <Heading compact>{t("shell.page.projects")}</Heading>
                </View>
              )}
            </View>
          ) : undefined
        }
        keyExtractor={(project) => project.id}
        onRefresh={() => projects.refetch()}
        ListEmptyComponent={
          projects.isPending ? (
            <Loading />
          ) : recent.length ? undefined : (
            <EmptyState
              icon="folder-open"
              title={t(query.trim() ? "shell.app.noMatchingProjects" : "native.projects.empty")}
            />
          )
        }
        renderItem={({ item }) => (
          <ProjectRow
            project={item}
            workspaceName={
              picker && query.trim()
                ? (workspace.workspaces.find((space) => space.id === item.workspaceId)?.name ?? "")
                : ""
            }
            picker={picker}
            selected={item.id === projectNavigation.currentProjectId}
            onPress={() => projectNavigation.selectProject(item.id)}
          />
        )}
      />
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
export function ProjectRow({
  project,
  workspaceName = "",
  picker,
  selected,
  onPress,
}: {
  project: Output<"list_projects">[number];
  workspaceName?: string;
  picker: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  const color = usePalette(),
    scope = useProjectNavigation();
  return (
    <Row
      title={project.name}
      onLongPress={() => scope.selectProject(project.id, true)}
      interaction={picker ? "choice" : "navigate"}
      selected={selected}
      leading={<ProjectIcon project={project} size={24} />}
      dense
      trailing={
        picker ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Body muted small>
              {project.archivedAt ? `${project.key} · ${t("shell.app.archived")}` : project.key}
            </Body>
            {selected ? (
              <TicketGlyph name="check" color={color.accent} />
            ) : (
              <View style={{ width: 16 }} />
            )}
          </View>
        ) : undefined
      }
      metadata={
        picker ? undefined : (
          <>
            <Body muted small>
              {project.archivedAt ? `${project.key} · ${t("shell.app.archived")}` : project.key}
            </Body>
            {workspaceName && (
              <Body muted small>
                {workspaceName}
              </Body>
            )}
            {!picker && (
              <Body muted small>
                {t("ticket.list.count", { count: project.openTickets })}
              </Body>
            )}
          </>
        )
      }
      {...(picker && workspaceName ? { caption: workspaceName } : {})}
      onPress={onPress}
    />
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
