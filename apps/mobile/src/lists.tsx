import { createHeaderAction } from "./navigation-actions.tsx";
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { capabilitiesOf } from "@kanvil/contracts";
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

export function Projects({ header }: { header?: ReactNode }) {
  const navigation = useNavigation();
  const [includeArchived, setIncludeArchived] = useState(false);
  const projects = useProjects(includeArchived),
    workspace = useWorkspace();
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
              ],
            },
          },
        ],
      }),
    );
  }, [navigation, canCreate, includeArchived, workspace.active?.id]);
  return (
    <Screen scroll={false}>
      <ErrorNotice error={projects.error} />
      {projects.isPending ? (
        <Loading />
      ) : (
        <List
          data={projects.data ?? []}
          ListHeaderComponent={
            header ? (
              <>
                {header}
                <View style={{ padding: 20 }}>
                  <Body muted small>
                    {t("shell.page.projects")}
                  </Body>
                </View>
              </>
            ) : undefined
          }
          keyExtractor={(project) => project.id}
          onRefresh={() => {
            void projects.refetch();
          }}
          refreshing={projects.isRefetching}
          ListEmptyComponent={
            <View style={{ padding: 20 }}>
              <Body muted>{t("native.projects.empty")}</Body>
            </View>
          }
          renderItem={({ item }) => (
            <Row
              title={item.name}
              leading={<ProjectIcon project={item} />}
              overline={item.archivedAt ? `${item.key} · ${t("shell.app.archived")}` : item.key}
              caption={item.description}
              onPress={() =>
                navigation.navigate("Tickets", { projectId: item.id, name: item.name })
              }
            />
          )}
        />
      )}
      {creating && <ProjectAction workspaceId={creating} onClose={() => setCreating(undefined)} />}
    </Screen>
  );
}
export { Tickets } from "./ticket-list.tsx";

function ProjectAction({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [name, setName] = useState(""),
    [key, setKey] = useState(""),
    [description, setDescription] = useState(""),
    [visibility, setVisibility] = useState<"private" | "workspace">("private");
  const create = useOperation("create_project"),
    navigation = useNavigation();
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
                navigation.navigate("Tickets", { projectId: project.id, name: project.name });
              })
              .catch(() => {});
          }}
        />
      </Sheet>
    </>
  );
}
