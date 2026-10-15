import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { ThemeMode } from "@kanvil/contracts/theme";
import {
  builtInThemes,
  themeVariables,
  validateTheme,
  type ThemeDefinition,
} from "../lib/themes.ts";
export const modeNames: Record<ThemeMode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};
const storageKey = "kanvil:custom-themes:v1";
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
  setMode: (mode: ThemeMode) => void;
  setColor: (id: string) => void;
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
    [color, setColor] = useState(() => localStorage.getItem("kanvil:color-theme") ?? "kanvil");
  const themes = [...builtInThemes, ...customThemes],
    selected = themes.find((theme) => theme.id === color) ?? builtInThemes[0];
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = mode === "system" ? (media.matches ? "dark" : "light") : mode;
      const root = document.documentElement;
      root.classList.toggle("dark", resolved === "dark");
      root.style.colorScheme = resolved;
      root.dataset.theme = selected.id;
      for (const [name, value] of Object.entries(themeVariables(selected[resolved])))
        root.style.setProperty(`--${name}`, value);
    };
    apply();
    media.addEventListener("change", apply);
    localStorage.setItem("kanvil:theme", mode);
    localStorage.setItem("kanvil:color-theme", selected.id);
    return () => media.removeEventListener("change", apply);
  }, [mode, selected]);
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
  return (
    <ThemeContext
      value={{
        mode,
        color: selected.id,
        themes,
        customThemes,
        selected,
        setMode,
        setColor: (id) => {
          if (themes.some((theme) => theme.id === id)) setColor(id);
        },
        save: (theme) => {
          importThemes([theme]);
          setColor(theme.id);
        },
        remove: (id) => {
          if (selected.id === id) setColor("kanvil");
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
