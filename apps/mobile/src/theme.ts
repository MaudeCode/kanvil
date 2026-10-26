import { useMemo, useSyncExternalStore } from "react";
import { Appearance, useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import {
  builtInThemes,
  themeSchema,
  themeVariables,
  resolveThemeId,
} from "@kanvil/contracts/themes";
import { palettes } from "@kanvil/contracts/theme";

const preferenceSchema = z.object({
  mode: z.enum(["system", "light", "dark"]).default("system"),
  theme: z.string().default("aligned"),
  light: z.string().nullable().default(null),
  dark: z.string().nullable().default(null),
  custom: z.array(themeSchema).max(50).default([]),
});
let preference = preferenceSchema.parse({});
const key = "kanvil:appearance";
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => preference;
function apply(next: typeof preference) {
  preference = next;
  Appearance.setColorScheme(next.mode === "system" ? "unspecified" : next.mode);
  for (const listener of listeners) listener();
}
export async function restoreAppearance() {
  const raw = await AsyncStorage.getItem(key);
  try {
    if (raw) apply(preferenceSchema.parse(JSON.parse(raw)));
  } catch {
    /* Invalid local preferences fall back to System and Aligned. */
  }
}
export async function setAppearance(patch: Partial<typeof preference>) {
  const next = preferenceSchema.parse({ ...preference, ...patch });
  apply(next);
  await AsyncStorage.setItem(key, JSON.stringify(next));
}
export const useAppearance = () => useSyncExternalStore(subscribe, snapshot);
export function useNativePalette() {
  const settings = useAppearance(),
    mode = useColorScheme() === "dark" ? "dark" : "light";
  return useMemo(() => {
    const themes = [...builtInThemes, ...settings.custom],
      id = resolveThemeId(settings[mode] ?? settings.theme);
    const theme = themes.find((item) => item.id === id) ?? builtInThemes[0];
    const colors = themeVariables(theme[mode]);
    return {
      ...palettes[mode],
      background: colors.muted ?? theme[mode].sidebar,
      surface: theme[mode].background,
      foreground: theme[mode].foreground,
      muted: colors["muted-foreground"] ?? palettes[mode].muted,
      line: colors.border ?? palettes[mode].line,
      accent: theme[mode].primary,
      accentForeground: theme[mode].primaryForeground,
      accentSurface: colors.accent ?? palettes[mode].accentSurface,
      danger: colors.destructive ?? palettes[mode].danger,
      warning: colors.warning ?? palettes[mode].warning,
      success: colors.success ?? palettes[mode].success,
    };
  }, [settings, mode]);
}
