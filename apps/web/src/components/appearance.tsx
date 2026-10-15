import { useRef, useState } from "react";
import {
  Check,
  Download,
  Monitor,
  Moon,
  Palette,
  Pencil,
  Plus,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import { z } from "zod";
import { useTheme, modeNames } from "./theme-provider.tsx";
import { ThemePreview } from "./theme-preview.tsx";
import {
  decodeThemeFile,
  encodeThemeFile,
  validateTheme,
  paletteSchema,
  type ThemeDefinition,
  type ThemePalette,
} from "../lib/themes.ts";
import { Button, Confirm, ErrorNotice, Input, Modal } from "../ui.tsx";
import { Input as FileInput } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
const modes = ["light", "dark", "system"] as const,
  modeIcons = { light: Sun, dark: Moon, system: Monitor };
export function ThemeMenu() {
  const theme = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Appearance" />}>
        <Palette />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[80dvh] w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Appearance</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={theme.mode}
            onValueChange={(value) => theme.setMode(z.enum(modes).parse(value))}
          >
            {modes.map((mode) => {
              const Icon = modeIcons[mode];
              return (
                <DropdownMenuRadioItem key={mode} value={mode}>
                  <Icon />
                  {modeNames[mode]}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Color theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={theme.color}
            onValueChange={(value) => theme.setColor(String(value))}
          >
            {theme.themes.map((item) => (
              <DropdownMenuRadioItem key={item.id} value={item.id}>
                <span className="size-3 rounded-full" style={{ background: item.dark.primary }} />
                {item.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
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
function ThemeChoice({ theme, active }: { theme: ThemeDefinition; active: boolean }) {
  return (
    <div className="relative">
      <RadioGroupItem
        value={theme.id}
        id={`theme-${theme.id}`}
        className="peer absolute inset-0 z-10 size-full aspect-auto rounded-xl opacity-0"
      />
      <Label htmlFor={`theme-${theme.id}`} className="theme-choice" data-selected={active}>
        <ThemePreview theme={theme} />
        <span className="flex w-full items-center justify-between gap-2 px-1 pb-1">
          <span>{theme.name}</span>
          {active && <Check className="size-4 text-primary" />}
        </span>
      </Label>
    </div>
  );
}
export function AppearanceSettings() {
  const theme = useTheme(),
    file = useRef<HTMLInputElement>(null),
    [editor, setEditor] = useState<ThemeDefinition | null>(null),
    [error, setError] = useState<unknown>();
  const custom = theme.selected.id.startsWith("custom-");
  return (
    <section className="space-y-8">
      <div>
        <h2>Appearance</h2>
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
                <ThemePreview theme={theme.selected} mode={mode} />
                <span className="pb-1">{modeNames[mode]}</span>
              </Label>
            </div>
          ))}
        </RadioGroup>
      </div>
      <div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="mb-0">Themes</h2>
          <div className="actions">
            <Button
              onClick={() =>
                setEditor({
                  ...theme.selected,
                  id: `custom-${crypto.getRandomValues(new Uint32Array(2)).join("-")}`,
                  name: `${theme.selected.name} custom`,
                })
              }
            >
              <Plus />
              New theme
            </Button>
            <Button onClick={() => file.current?.click()}>
              <Upload />
              Import
            </Button>
            <Button onClick={() => download(theme.selected)}>
              <Download />
              Export
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
        <RadioGroup
          aria-label="Color theme"
          value={theme.color}
          onValueChange={(value) => theme.setColor(String(value))}
          className="grid grid-cols-2 gap-3 xl:grid-cols-3"
        >
          {theme.themes.map((item) => (
            <ThemeChoice key={item.id} theme={item} active={item.id === theme.color} />
          ))}
        </RadioGroup>
      </div>
      {custom && (
        <div className="actions">
          <Button onClick={() => setEditor(theme.selected)}>
            <Pencil />
            Edit {theme.selected.name}
          </Button>
          <Confirm
            label="Delete custom theme"
            description={`Remove ${theme.selected.name} from this browser?`}
            danger
            icon={<Trash2 />}
            onConfirm={async () => theme.remove(theme.selected.id)}
          />
        </div>
      )}
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
