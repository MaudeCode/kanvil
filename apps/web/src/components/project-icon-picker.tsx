import { useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Camera, RotateCcw } from "lucide-react";
import { projectIconColors, type Project } from "@kanvil/contracts";
import { useOperation } from "../data.tsx";
import { Button, ErrorNotice, Input, Loading, Modal } from "../ui.tsx";
import { Input as FileInput } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { prepareSquareImage } from "../lib/browser.ts";
import { ProjectIcon, projectIconTones, useIconLibrary } from "./project-icon.tsx";
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
  return (
    <>
      <Button
        disabled={disabled}
        onClick={() => {
          update.reset();
          setError(undefined);
          setColor(project.iconColor);
          setQuery("");
          setLimit(96);
          setOpen(true);
        }}
      >
        <ProjectIcon project={project} className="size-4" />
        Change icon
      </Button>
      <Modal title="Project icon" open={open} onOpenChange={setOpen} busy={busy}>
        <Tabs defaultValue="library">
          <TabsList variant="line">
            <TabsTrigger value="library">Icon library</TabsTrigger>
            <TabsTrigger value="upload">Upload image</TabsTrigger>
          </TabsList>
          <TabsContent value="library">
            <Input
              label="Search icons"
              type="search"
              placeholder="Search icons…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(96);
              }}
            />
            <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Icon color">
              {projectIconColors.map((tone) => (
                <Button
                  key={tone}
                  disabled={busy}
                  variant={color === tone ? "secondary" : "ghost"}
                  size="icon"
                  aria-label={`${tone} icon color`}
                  aria-pressed={color === tone}
                  className={projectIconTones[tone]}
                  onClick={() => setColor(tone)}
                >
                  <span className="size-3 rounded-full bg-current" />
                </Button>
              ))}
            </div>
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
                          className={`aspect-square h-auto min-h-11 ${projectIconTones[color]}`}
                          disabled={busy}
                          aria-label={`Choose ${name.replaceAll("-", " ")}`}
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
                  <p className="py-8 text-center text-muted-foreground">No matching icons</p>
                )}
                {names.length > limit && (
                  <Button className="mt-3 w-full" onClick={() => setLimit((value) => value + 96)}>
                    Show more icons
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
                {busy ? "Uploading…" : "Choose image"}
              </Button>
              <p className="mb-0 text-xs text-muted-foreground">PNG, JPEG, or WebP · up to 10 MB</p>
            </div>
          </TabsContent>
        </Tabs>
        <FileInput
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          aria-label="Project icon file"
          onChange={(event) => {
            const selected = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!selected) return;
            setPreparing(true);
            setError(undefined);
            void prepareSquareImage(selected, { fit: "contain", format: "image/png" })
              .then((image) => save({ kind: "image", ...image }))
              .catch(setError)
              .finally(() => setPreparing(false));
          }}
        />
        <ErrorNotice error={error ?? library.error} />
        <div className="dialog-actions">
          <Button
            disabled={busy}
            onClick={() => {
              void save(null);
            }}
          >
            <RotateCcw />
            Reset icon
          </Button>
          <Button disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </Modal>
    </>
  );
}
