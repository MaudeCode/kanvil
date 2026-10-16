import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ThemeMode } from "@kanvil/contracts/theme";
import { z } from "zod";
import {
  builtInThemes,
  themeVariables,
  validateTheme,
  resolveThemeId,
  type ThemeDefinition,
} from "../lib/themes.ts";
export const modeNames: Record<ThemeMode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};
const storageKey = "kanvil:custom-themes:v1";
const halvesKey = "kanvil:theme-halves:v1";
export type ThemeAppearance = Exclude<ThemeMode, "system">;
const halvesSchema = z.object({ light: z.string().optional(), dark: z.string().optional() });
function savedHalves(): z.output<typeof halvesSchema> {
  try {
    return halvesSchema.parse(JSON.parse(localStorage.getItem(halvesKey) ?? "{}"));
  } catch {
    return {};
  }
}
function subscribeSystemAppearance(listener: () => void) {
  const media = matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
const systemIsDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
function savedThemes() {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(values)
      ? values
          .slice(0, 50)
          .map(validateTheme)
          .filter((theme) => theme.id.startsWith("custom-"))
      : [];
  } catch {
    return [];
  }
}
type Themes = {
  mode: ThemeMode;
  color: string;
  themes: ThemeDefinition[];
  customThemes: ThemeDefinition[];
  selected: ThemeDefinition;
  lightTheme: ThemeDefinition;
  darkTheme: ThemeDefinition;
  setMode: (mode: ThemeMode) => void;
  setColor: (id: string) => void;
  setColorForMode: (mode: ThemeAppearance, id: string) => void;
  save: (theme: ThemeDefinition) => void;
  remove: (id: string) => void;
  importThemes: (themes: ThemeDefinition[]) => void;
};
const ThemeContext = createContext<Themes | null>(null);
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem("kanvil:theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [customThemes, setCustomThemes] = useState(savedThemes),
    [color, setColor] = useState(() => resolveThemeId(localStorage.getItem("kanvil:color-theme")));
  const [halves, setHalves] = useState(savedHalves);
  const prefersDark = useSyncExternalStore(subscribeSystemAppearance, systemIsDark);
  const resolved = mode === "system" ? (prefersDark ? "dark" : "light") : mode;
  const themes = [...builtInThemes, ...customThemes],
    base = themes.find((theme) => theme.id === color) ?? builtInThemes[0],
    lightTheme =
      themes.find((theme) => theme.id === resolveThemeId(halves.light ?? base.id)) ?? base,
    darkTheme = themes.find((theme) => theme.id === resolveThemeId(halves.dark ?? base.id)) ?? base,
    selected = resolved === "light" ? lightTheme : darkTheme;
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.style.colorScheme = resolved;
    root.dataset.theme = selected.id;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", selected[resolved].background);
    for (const [name, value] of Object.entries(themeVariables(selected[resolved])))
      root.style.setProperty(`--${name}`, value);
    localStorage.setItem("kanvil:theme", mode);
    localStorage.setItem("kanvil:color-theme", base.id);
    localStorage.setItem(halvesKey, JSON.stringify(halves));
  }, [mode, selected, resolved, base.id, halves]);
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(customThemes));
  }, [customThemes]);
  function importThemes(values: ThemeDefinition[]) {
    const valid = values.map(validateTheme);
    const merged = [
      ...new Map([...customThemes, ...valid].map((theme) => [theme.id, theme])).values(),
    ];
    if (merged.length > 50) throw new Error("Keep at most 50 custom themes.");
    setCustomThemes(merged);
  }
  function selectTheme(id: string) {
    setColor(id);
    setHalves({});
  }
  return (
    <ThemeContext
      value={{
        mode,
        color: lightTheme.id === darkTheme.id ? lightTheme.id : "",
        themes,
        customThemes,
        selected,
        lightTheme,
        darkTheme,
        setMode,
        setColor: (id) => {
          if (themes.some((theme) => theme.id === id)) {
            selectTheme(id);
          }
        },
        setColorForMode: (appearance, id) => {
          if (themes.some((theme) => theme.id === id))
            setHalves((current) => ({ ...current, [appearance]: id }));
        },
        save: (theme) => {
          importThemes([theme]);
          selectTheme(theme.id);
        },
        remove: (id) => {
          if (base.id === id) setColor(builtInThemes[0].id);
          setHalves((current) =>
            Object.fromEntries(Object.entries(current).filter(([, value]) => value !== id)),
          );
          setCustomThemes((current) => current.filter((theme) => theme.id !== id));
        },
        importThemes,
      }}
    >
      {children}
    </ThemeContext>
  );
}
export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider is missing");
  return value;
}
