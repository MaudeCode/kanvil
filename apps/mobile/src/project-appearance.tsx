import { useDeferredValue, useState } from "react";
import { View, useColorScheme } from "react-native";
import { SvgXml } from "react-native-svg";
import { labelColor, projectIconColors, type Project } from "@kanvil/contracts";
import { nativeAccentColor } from "@kanvil/contracts/colors";
import { t } from "@kanvil/contracts/i18n";
import { useOperation } from "./data.tsx";
import { chooseImage } from "./media.ts";
import { AccountImage } from "./image.tsx";
import { ProjectIcon, useIconLibrary } from "./project-icon.tsx";
import {
  Button,
  Choice,
  ErrorNotice,
  Field,
  List,
  Loading,
  Row,
  Section,
  Sheet,
  usePalette,
} from "./ui.tsx";

// Uses the same Iconify library as ProjectIcon on the web, with native SVG rendering.
export function ProjectAppearance({ project, disabled }: { project: Project; disabled: boolean }) {
  const updateIcon = useOperation("set_project_icon"),
    updateBackground = useOperation("set_project_background");
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>();
  async function upload(background: boolean) {
    setPending(true);
    setError(undefined);
    try {
      const image = await chooseImage();
      if (!image) return;
      if (background)
        await updateBackground.mutateAsync({
          projectId: project.id,
          expectedVersion: project.version,
          background: image,
        });
      else
        await updateIcon.mutateAsync({
          projectId: project.id,
          expectedVersion: project.version,
          icon: { kind: "image", ...image },
        });
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Section title={t("settings.icon.title")}>
        <ProjectIcon project={project} size={64} />
        {!disabled && (
          <>
            <Button title={t("settings.icon.library")} onPress={() => setOpen(true)} />
            <Button
              title={t("settings.icon.upload")}
              disabled={pending}
              onPress={() => {
                void upload(false);
              }}
            />
            <Button
              title={t("settings.icon.reset")}
              disabled={pending || updateIcon.isPending}
              onPress={() =>
                updateIcon.mutate({
                  projectId: project.id,
                  expectedVersion: project.version,
                  icon: null,
                })
              }
            />
          </>
        )}
      </Section>
      <Section title={t("settings.project.background")}>
        {project.background && (
          <AccountImage
            uri={project.background}
            style={{ width: "100%", aspectRatio: 2, resizeMode: "cover" }}
          />
        )}
        {!disabled && (
          <>
            <Button
              title={t("settings.project.upload")}
              disabled={pending}
              onPress={() => {
                void upload(true);
              }}
            />
            {project.background && (
              <Button
                title={t("common.action.remove")}
                disabled={pending || updateBackground.isPending}
                onPress={() =>
                  updateBackground.mutate({
                    projectId: project.id,
                    expectedVersion: project.version,
                    background: null,
                  })
                }
              />
            )}
          </>
        )}
      </Section>
      <ErrorNotice error={error ?? updateIcon.error ?? updateBackground.error} />
      <Sheet
        title={t("settings.icon.choose")}
        open={open}
        onClose={() => setOpen(false)}
        scroll={false}
      >
        {open && <IconGallery project={project} onSaved={() => setOpen(false)} />}
      </Sheet>
    </>
  );
}

function IconGallery({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const library = useIconLibrary(),
    update = useOperation("set_project_icon"),
    palette = usePalette(),
    mode = useColorScheme() === "dark" ? "dark" : "light";
  const [snapshot] = useState(project),
    [query, setQuery] = useState(""),
    [color, setColor] = useState(project.iconColor);
  const q = useDeferredValue(query.toLowerCase().replaceAll(" ", "-"));
  const entries = Object.entries(library.data?.icons ?? {}).filter(([name]) => name.includes(q));
  const tint = nativeAccentColor(color, mode, palette);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 20, gap: 10 }}>
        <Field
          label={t("settings.icon.search")}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
        />
        <Choice
          label={t("settings.icon.color")}
          value={color}
          options={projectIconColors.map((value) => ({
            value,
            label: t(`settings.color.${value}`),
          }))}
          onChange={(value) => {
            const parsed = labelColor.parse(value);
            const preset = projectIconColors.find((item) => item === parsed);
            if (preset) setColor(preset);
          }}
        />
        <ErrorNotice error={library.error ?? update.error} />
      </View>
      {library.isPending ? (
        <Loading />
      ) : (
        <List
          data={entries}
          keyExtractor={(entry) => entry[0]}
          renderItem={({ item: [name, icon] }) => (
            <Row
              title={name}
              leading={
                <SvgXml
                  width={28}
                  height={28}
                  color={tint}
                  xml={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${library.data?.width ?? 24} ${library.data?.height ?? 24}">${icon.body}</svg>`}
                />
              }
              disabled={update.isPending}
              onPress={() => {
                void update
                  .mutateAsync({
                    projectId: snapshot.id,
                    expectedVersion: snapshot.version,
                    icon: { kind: "library", name, color },
                  })
                  .then(onSaved)
                  .catch(() => {});
              }}
            />
          )}
        />
      )}
    </View>
  );
}
