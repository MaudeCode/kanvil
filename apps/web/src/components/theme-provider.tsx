import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { ThemeMode } from "@kanvil/contracts/theme";

export const colorThemes = ["kanvil", "graphite", "forest", "ember"] as const;
export type ColorTheme = (typeof colorThemes)[number];
export const themeNames: Record<ColorTheme, string> = {
  kanvil: "Kanvil",
  graphite: "Graphite",
  forest: "Forest",
  ember: "Ember",
};
export const modeNames: Record<ThemeMode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};
const ThemeContext = createContext<{
  mode: ThemeMode;
  color: ColorTheme;
  setMode: (value: ThemeMode) => void;
  setColor: (value: ColorTheme) => void;
} | null>(null);
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem("kanvil:theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [color, setColor] = useState<ColorTheme>(
    () =>
      colorThemes.find((value) => value === localStorage.getItem("kanvil:color-theme")) ?? "kanvil",
  );
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = mode === "system" ? (media.matches ? "dark" : "light") : mode;
      document.documentElement.classList.toggle("dark", resolved === "dark");
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    media.addEventListener("change", apply);
    localStorage.setItem("kanvil:theme", mode);
    return () => media.removeEventListener("change", apply);
  }, [mode]);
  useEffect(() => {
    document.documentElement.dataset.theme = color;
    localStorage.setItem("kanvil:color-theme", color);
  }, [color]);
  return <ThemeContext value={{ mode, color, setMode, setColor }}>{children}</ThemeContext>;
}
export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider is missing");
  return value;
}
