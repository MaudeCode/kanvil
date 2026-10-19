import { accentColorClasses } from "../lib/accent-colors.ts";
import { AccentColorPicker } from "./accent-color-picker.tsx";
import { useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Camera, RotateCcw } from "lucide-react";
import { type Project } from "@kanvil/contracts";
import { useOperation } from "../data.tsx";
import { Button, ErrorNotice, Loading, Modal, ModalActions, SearchField } from "../ui.tsx";
import { Input as FileInput } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { prepareImage } from "../lib/browser.ts";
import { ProjectIcon, useIconLibrary } from "./project-icon.tsx";
import { ImageEditTrigger } from "./image-edit-trigger.tsx";
import { t } from "@kanvil/contracts/i18n";
export function ProjectIconPicker({
  project,
  disabled = false,
}: {
  project: Project;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [limit, setLimit] = useState(96),
    [color, setColor] = useState(project.iconColor),
    [error, setError] = useState<unknown>(),
    [preparing, setPreparing] = useState(false);
  const update = useOperation("set_project_icon"),
    library = useIconLibrary(open),
    file = useRef<HTMLInputElement>(null),
    busy = preparing || update.isPending;
  const names = Object.keys(library.data?.icons ?? {}).filter((name) =>
    name.includes(query.trim().toLowerCase().replaceAll(" ", "-")),
  );
  async function save(icon: Parameters<typeof update.mutateAsync>[0]["icon"]) {
    setError(undefined);
    try {
      await update.mutateAsync({ projectId: project.id, expectedVersion: project.version, icon });
      setOpen(false);
    } catch (cause) {
      setError(cause);
    }
  }
  const start = () => {
    update.reset();
    setError(undefined);
    setColor(project.iconColor);
    setQuery("");
    setLimit(96);
    setOpen(true);
  };
  return (
    <>
      <ImageEditTrigger label={t("settings.icon.change")} disabled={disabled} onClick={start}>
        <ProjectIcon project={project} className="size-16 rounded-xl bg-muted/50 p-1.5" />
      </ImageEditTrigger>
      <Modal title={t("settings.icon.title")} open={open} onOpenChange={setOpen} busy={busy}>
        <Tabs defaultValue="library">
          <TabsList variant="line">
            <TabsTrigger value="library">{t("settings.icon.library")}</TabsTrigger>
            <TabsTrigger value="upload">{t("settings.icon.upload")}</TabsTrigger>
          </TabsList>
          <TabsContent value="library">
            <SearchField
              label={t("settings.icon.search")}
              placeholder={t("settings.icon.searchPlaceholder")}
              defaultOpen
              value={query}
              onChange={(value) => {
                setQuery(value);
                setLimit(96);
              }}
              className="my-3"
            />
            <AccentColorPicker
              label={t("settings.icon.color")}
              value={color}
              onChange={setColor}
              disabled={busy}
            />
            {library.isPending ? (
              <Loading />
            ) : (
              <div className="max-h-80 overflow-y-auto overscroll-contain">
                <div className="grid grid-cols-5 gap-1 sm:grid-cols-8">
                  {names.slice(0, limit).map((name) => {
                    const icon = library.data?.icons[name];
                    return (
                      icon && (
                        <Button
                          key={name}
                          variant={name === project.iconName ? "secondary" : "ghost"}
                          className={`aspect-square h-auto min-h-11 ${accentColorClasses[color]}`}
                          disabled={busy}
                          aria-label={t("settings.icon.choose", {
                            name: name.replaceAll("-", " "),
                          })}
                          title={name.replaceAll("-", " ")}
                          onClick={() => {
                            void save({ kind: "library", name, color });
                          }}
                        >
                          <Icon icon={{ ...icon, width: 24, height: 24 }} className="size-6" />
                        </Button>
                      )
                    );
                  })}
                </div>
                {names.length === 0 && (
                  <p className="py-8 text-center text-muted-foreground">
                    {t("settings.icon.noMatches")}
                  </p>
                )}
                {names.length > limit && (
                  <Button className="mt-3 w-full" onClick={() => setLimit((value) => value + 96)}>
                    {t("settings.icon.showMore")}
                  </Button>
                )}
              </div>
            )}
          </TabsContent>
          <TabsContent value="upload">
            <div className="flex flex-col items-center gap-5 py-10">
              <ProjectIcon project={project} className="size-20" />
              <Button disabled={busy} onClick={() => file.current?.click()}>
                <Camera />
                {busy ? t("settings.icon.uploading") : t("settings.icon.chooseImage")}
              </Button>
              <p className="mb-0 text-xs text-muted-foreground">{t("settings.icon.formats")}</p>
            </div>
          </TabsContent>
        </Tabs>
        <FileInput
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          aria-label={t("settings.icon.file")}
          onChange={(event) => {
            const selected = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!selected) return;
            setPreparing(true);
            setError(undefined);
            void prepareImage(selected, { fit: "contain", format: "image/png" })
              .then((image) => save({ kind: "image", ...image }))
              .catch(setError)
              .finally(() => setPreparing(false));
          }}
        />
        <ErrorNotice error={error ?? library.error} />
        <ModalActions>
          <Button
            disabled={busy}
            onClick={() => {
              void save(null);
            }}
          >
            <RotateCcw />
            {t("settings.icon.reset")}
          </Button>
          <Button disabled={busy} onClick={() => setOpen(false)}>
            {t("common.action.cancel")}
          </Button>
        </ModalActions>
      </Modal>
    </>
  );
}
