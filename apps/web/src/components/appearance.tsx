import { useRef, useState, type ReactNode } from "react";
import { Download, Pencil, Plus, Trash2, Search, Copy, Sun, Moon } from "lucide-react";
import { z } from "zod";
import { useTheme, modeNames, type ThemeAppearance } from "./theme-provider.tsx";
import { ThemePreview } from "./theme-preview.tsx";
import {
  decodeThemeFile,
  encodeThemeFile,
  validateTheme,
  paletteSchema,
  type ThemeDefinition,
  type ThemePalette,
} from "../lib/themes.ts";
import { Button, Confirm, ErrorNotice, IconButton, Input, Modal } from "../ui.tsx";
import { Input as FileInput } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
const modes = ["system", "light", "dark"] as const;
function download(theme: ThemeDefinition) {
  const url = URL.createObjectURL(
      new Blob([encodeThemeFile([theme])], { type: "application/json" }),
    ),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${theme.id}.kanvil-theme.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function ThemeChoice({
  theme,
  active,
  activeModes,
  onPickMode,
  actions,
}: {
  theme: ThemeDefinition;
  active: boolean;
  activeModes: ThemeAppearance[];
  onPickMode: (mode: ThemeAppearance) => void;
  actions: ReactNode;
}) {
  return (
    <div
      className="theme-library-choice relative overflow-hidden rounded-xl border border-border/70 bg-background transition-colors hover:bg-accent/10"
      data-selected={active}
    >
      <RadioGroupItem
        value={theme.id}
        id={`theme-${theme.id}`}
        className="peer absolute inset-0 size-full aspect-auto rounded-xl opacity-0"
      />
      <div className="pointer-events-none relative flex min-h-16 items-center justify-center gap-2.5 px-3 pt-3">
        {(["light", "dark"] as const).map((mode) => {
          const selected = activeModes.includes(mode),
            Icon = mode === "light" ? Sun : Moon;
          return (
            <Tooltip key={mode}>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    aria-label={`Use ${theme.name} ${mode} mode`}
                    aria-pressed={selected}
                    className="pointer-events-auto relative size-[68px] shrink-0 rounded-full p-1 transition-transform hover:scale-105 hover:bg-transparent aria-pressed:hover:scale-100"
                    onClick={() => onPickMode(mode)}
                  />
                }
              >
                <ThemePreview theme={theme} mode={mode} variant="orb" />
                {selected && (
                  <>
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-inset ring-ring"
                    />
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute bottom-0.5 right-0.5 flex size-5 items-center justify-center rounded-full border border-border/70 bg-background text-foreground shadow-sm"
                    >
                      <Icon className="size-3" />
                    </span>
                  </>
                )}
              </TooltipTrigger>
              <TooltipContent>Use for {mode} mode only</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="pointer-events-none relative flex items-center gap-2 px-3 pb-3 pt-2">
        <Label
          htmlFor={`theme-${theme.id}`}
          title={theme.name}
          className="min-w-0 flex-1 truncate text-sm font-medium"
        >
          {theme.name}
        </Label>
        <div className="pointer-events-auto relative flex shrink-0 items-center gap-1">
          {actions}
        </div>
      </div>
    </div>
  );
}
const normalizeThemeSearch = (text: string) =>
  text
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
export function AppearanceSettings() {
  const theme = useTheme(),
    file = useRef<HTMLInputElement>(null),
    [editor, setEditor] = useState<ThemeDefinition | null>(null),
    [query, setQuery] = useState(""),
    [error, setError] = useState<unknown>();
  const preview = { ...theme.selected, light: theme.lightTheme.light, dark: theme.darkTheme.dark };
  function duplicate(item: ThemeDefinition) {
    setEditor({
      ...item,
      id: `custom-${crypto.getRandomValues(new Uint32Array(2)).join("-")}`,
      name: `${item.name} copy`,
    });
  }
  const matches = theme.themes.filter((item) =>
    normalizeThemeSearch(item.name).includes(normalizeThemeSearch(query)),
  );
  return (
    <section className="space-y-5">
      <div>
        <h2 className="mb-3 text-sm font-normal text-muted-foreground">Color scheme</h2>
        <RadioGroup
          value={theme.mode}
          onValueChange={(value) => theme.setMode(z.enum(modes).parse(value))}
          aria-label="Theme"
          className="grid grid-cols-3 gap-3"
        >
          {modes.map((mode) => (
            <div className="relative" key={mode}>
              <RadioGroupItem
                id={`mode-${mode}`}
                value={mode}
                className="peer absolute inset-0 z-10 size-full aspect-auto rounded-xl opacity-0"
              />
              <Label
                htmlFor={`mode-${mode}`}
                className="theme-choice"
                data-selected={theme.mode === mode}
              >
                <ThemePreview theme={preview} mode={mode} className="h-[8.75rem]" />
                <span className="pb-1">{modeNames[mode]}</span>
              </Label>
            </div>
          ))}
        </RadioGroup>
      </div>
      <div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="mb-0 text-sm font-normal text-muted-foreground">Themes</h2>
          <div className="actions">
            <Button size="sm" onClick={() => duplicate(preview)}>
              <Pencil />
              Create theme
            </Button>
            <Button size="sm" onClick={() => file.current?.click()}>
              <Plus />
              Add theme
            </Button>
          </div>
        </div>
        <FileInput
          ref={file}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-label="Import theme file"
          onChange={(event) => {
            const chosen = event.currentTarget.files?.[0];
            if (!chosen) return;
            setError(undefined);
            void chosen
              .text()
              .then((text) => theme.importThemes(decodeThemeFile(text)))
              .catch(setError);
            event.currentTarget.value = "";
          }}
        />
        <ErrorNotice error={error} />
        <InputGroup className="mb-4 max-w-sm">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search themes"
            type="search"
            placeholder="Search themes…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
        <RadioGroup
          aria-label="Color theme"
          value={theme.color}
          onValueChange={(value) => theme.setColor(String(value))}
          className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-2"
        >
          {matches.map((item) => (
            <ThemeChoice
              key={item.id}
              theme={item}
              active={item.id === theme.color}
              activeModes={(["light", "dark"] as const).filter(
                (mode) => (mode === "light" ? theme.lightTheme.id : theme.darkTheme.id) === item.id,
              )}
              onPickMode={(mode) => theme.setColorForMode(mode, item.id)}
              actions={
                <>
                  <IconButton
                    label={`Duplicate ${item.name}`}
                    className="size-6"
                    onClick={() => duplicate(item)}
                  >
                    <Copy />
                  </IconButton>
                  {item.id.startsWith("custom-") && (
                    <>
                      <IconButton
                        label={`Edit ${item.name}`}
                        className="size-6"
                        onClick={() => setEditor(item)}
                      >
                        <Pencil />
                      </IconButton>
                      <IconButton
                        label={`Export ${item.name}`}
                        className="size-6"
                        onClick={() => download(item)}
                      >
                        <Download />
                      </IconButton>
                      <Confirm
                        label={`Delete ${item.name}`}
                        description={`Remove ${item.name} from this browser? Light or dark appearances using it will fall back to your base theme.`}
                        danger
                        icon={<Trash2 />}
                        onConfirm={async () => theme.remove(item.id)}
                      />
                    </>
                  )}
                </>
              }
            />
          ))}
        </RadioGroup>
        {matches.length === 0 && (
          <p role="status" className="mt-4">
            No matching themes
          </p>
        )}
      </div>
      <Modal
        title="Custom theme"
        open={!!editor}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        {editor && (
          <ThemeEditor
            initial={editor}
            onSaved={(value) => {
              theme.save(value);
              setQuery("");
              setEditor(null);
            }}
          />
        )}
      </Modal>
    </section>
  );
}
const colorLabels: Record<keyof ThemePalette, string> = {
  background: "Background",
  foreground: "Text",
  sidebar: "Sidebar",
  primary: "Accent",
  primaryForeground: "Accent text",
};
function ThemeEditor({
  initial,
  onSaved,
}: {
  initial: ThemeDefinition;
  onSaved: (theme: ThemeDefinition) => void;
}) {
  const [draft, setDraft] = useState(initial),
    [error, setError] = useState<unknown>();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setError(undefined);
        try {
          onSaved(validateTheme(draft));
        } catch (cause) {
          setError(cause);
        }
      }}
    >
      <Input
        label="Theme name"
        value={draft.name}
        required
        maxLength={60}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
      />
      <div className="grid grid-cols-2 gap-5">
        {(["light", "dark"] as const).map((mode) => (
          <section key={mode}>
            <h3>{modeNames[mode]}</h3>
            <ThemePreview theme={draft} mode={mode} />
            <div className="mt-4 space-y-3">
              {paletteSchema.keyof().options.map((key) => (
                <Input
                  key={key}
                  label={`${modeNames[mode]} ${colorLabels[key].toLowerCase()}`}
                  type="color"
                  value={draft[mode][key]}
                  onChange={(event) =>
                    setDraft({ ...draft, [mode]: { ...draft[mode], [key]: event.target.value } })
                  }
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      <ErrorNotice error={error} />
      <Button type="submit" variant="default" className="mt-4">
        Save theme
      </Button>
    </form>
  );
}
