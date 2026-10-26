import { z } from "zod";
import { t } from "./i18n/index.ts";
const hex = z.string().regex(/^#[0-9a-f]{6}$/i, { error: () => t("settings.theme.hexColor") });
export const paletteSchema = z
  .object({ background: hex, foreground: hex, sidebar: hex, primary: hex, primaryForeground: hex })
  .strict();
export const themeSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    name: z.string().trim().min(1).max(60),
    light: paletteSchema,
    dark: paletteSchema,
  })
  .strict();
export type ThemeDefinition = z.infer<typeof themeSchema>;
export type ThemePalette = z.infer<typeof paletteSchema>;
function readable(color: string, background: string | string[], target: string) {
  const backgrounds = Array.isArray(background) ? background : [background];
  for (let step = 0; step <= 100; step++) {
    const candidate = blend(color, target, step / 100);
    if (backgrounds.every((surface) => contrast(candidate, surface) >= 4.5)) return candidate;
  }
  return target;
}
function colors(
  background: string,
  foreground: string,
  sidebar: string,
  primary: string,
  primaryForeground: string,
): ThemePalette {
  foreground = readable(
    foreground,
    [background, sidebar],
    luminance(background) > 0.5 ? "#000000" : "#ffffff",
  );
  const accent = readable(primary, background, foreground);
  return {
    background,
    foreground,
    sidebar,
    primary: accent,
    primaryForeground:
      contrast(accent, primaryForeground) >= 4.5
        ? primaryForeground
        : contrast(accent, background) >= contrast(accent, foreground)
          ? background
          : foreground,
  };
}
const latte = colors("#eff1f5", "#4c4f69", "#e6e9ef", "#8839ef", "#ffffff");
const roseDawn = colors("#faf4ed", "#575279", "#f2e9e1", "#907aa9", "#ffffff");
export const builtInThemes: [ThemeDefinition, ...ThemeDefinition[]] = [
  {
    id: "aligned",
    // Kanvil's own theme; the others carry the published names of their color schemes.
    get name() {
      return t("settings.theme.aligned");
    },
    light: colors("#ffffff", "#202020", "#f7f7f7", "#5e6ad2", "#ffffff"),
    dark: colors("#171717", "#eeeeee", "#111111", "#8a8ff5", "#181822"),
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    light: latte,
    dark: colors("#1e1e2e", "#cdd6f4", "#181825", "#cba6f7", "#1e1e2e"),
  },
  {
    id: "catppuccin-macchiato",
    name: "Catppuccin Macchiato",
    light: latte,
    dark: colors("#24273a", "#cad3f5", "#1e2030", "#c6a0f6", "#24273a"),
  },
  {
    id: "catppuccin-frappe",
    name: "Catppuccin Frappé",
    light: latte,
    dark: colors("#303446", "#c6d0f5", "#292c3c", "#ca9ee6", "#303446"),
  },
  {
    id: "solarized",
    name: "Solarized",
    light: colors("#fdf6e3", "#586e75", "#eee8d5", "#268bd2", "#ffffff"),
    dark: colors("#002b36", "#93a1a1", "#073642", "#268bd2", "#002b36"),
  },
  {
    id: "github",
    name: "GitHub",
    light: colors("#ffffff", "#1f2328", "#f6f8fa", "#0969da", "#ffffff"),
    dark: colors("#0d1117", "#e6edf3", "#010409", "#58a6ff", "#0d1117"),
  },
  {
    id: "dracula",
    name: "Dracula",
    light: colors("#fffbeb", "#1f1f1f", "#efebdb", "#644ac9", "#ffffff"),
    dark: colors("#282a36", "#f8f8f2", "#21222c", "#bd93f9", "#282a36"),
  },
  {
    id: "one-dark",
    name: "One Dark",
    light: colors("#fafafa", "#383a42", "#f0f0f0", "#4078f2", "#ffffff"),
    dark: colors("#282c34", "#abb2bf", "#21252b", "#61afef", "#21252b"),
  },
  {
    id: "nord",
    name: "Nord",
    light: colors("#eceff4", "#2e3440", "#e5e9f0", "#5e81ac", "#ffffff"),
    dark: colors("#2e3440", "#eceff4", "#272c36", "#88c0d0", "#2e3440"),
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    light: colors("#e1e2e7", "#343b58", "#d5d6db", "#2e7de9", "#ffffff"),
    dark: colors("#1a1b26", "#c0caf5", "#16161e", "#7aa2f7", "#1a1b26"),
  },
  {
    id: "tokyo-night-storm",
    name: "Tokyo Night Storm",
    light: colors("#e1e2e7", "#343b58", "#d5d6db", "#9854f1", "#ffffff"),
    dark: colors("#24283b", "#c0caf5", "#1f2335", "#bb9af7", "#24283b"),
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    light: colors("#fbf1c7", "#3c3836", "#f2e5bc", "#af3a03", "#fbf1c7"),
    dark: colors("#282828", "#ebdbb2", "#1d2021", "#fabd2f", "#282828"),
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    light: roseDawn,
    dark: colors("#191724", "#e0def4", "#1f1d2e", "#c4a7e7", "#191724"),
  },
  {
    id: "rose-pine-moon",
    name: "Rosé Pine Moon",
    light: roseDawn,
    dark: colors("#232136", "#e0def4", "#2a273f", "#ea9a97", "#232136"),
  },
  {
    id: "everforest",
    name: "Everforest",
    light: colors("#fdf6e3", "#5c6a72", "#efebd4", "#8da101", "#ffffff"),
    dark: colors("#2d353b", "#d3c6aa", "#272e33", "#a7c080", "#2d353b"),
  },
  {
    id: "monokai",
    name: "Monokai",
    light: colors("#fafaf8", "#272822", "#f0f0e9", "#a31b61", "#ffffff"),
    dark: colors("#272822", "#f8f8f2", "#1e1f1c", "#a6e22e", "#272822"),
  },
  {
    id: "night-owl",
    name: "Night Owl",
    light: colors("#fbfbfb", "#403f53", "#f0f0f0", "#4876d6", "#ffffff"),
    dark: colors("#011627", "#d6deeb", "#01111d", "#c792ea", "#011627"),
  },
  {
    id: "ayu",
    name: "Ayu",
    light: colors("#fafafa", "#5c6166", "#f3f4f5", "#ff9940", "#14191f"),
    dark: colors("#0b0e14", "#bfbdb6", "#06080f", "#e6b450", "#0b0e14"),
  },
];
const legacyThemes: Record<string, string> = {
  kanvil: "aligned",
  linear: "aligned",
  graphite: "github",
  forest: "everforest",
  ember: "gruvbox",
  ocean: "tokyo-night",
  iris: "dracula",
  rose: "rose-pine",
  sand: "solarized",
  slate: "github",
};
export function resolveThemeId(id: string | null) {
  return id ? (legacyThemes[id] ?? id) : builtInThemes[0].id;
}
function colorChannels(color: string) {
  return [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16));
}
function blend(background: string, foreground: string, ratio: number) {
  const front = colorChannels(foreground);
  return (
    "#" +
    colorChannels(background)
      .map((channel, index) =>
        Math.round(channel * (1 - ratio) + (front[index] ?? channel) * ratio)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
function luminance(color: string) {
  const channels = colorChannels(color)
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
}
export function contrast(a: string, b: string) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function validateTheme(value: unknown) {
  const theme = themeSchema.parse(value);
  for (const mode of ["light", "dark"] as const) {
    const p = theme[mode];
    if (
      contrast(p.background, p.foreground) < 4.5 ||
      contrast(p.sidebar, p.foreground) < 4.5 ||
      contrast(p.primary, p.primaryForeground) < 4.5
    )
      throw new Error(t(`settings.theme.contrast.${mode}`));
  }
  return theme;
}
export function tintedSurface(
  background: string,
  foreground: string,
  color: string,
  strength = 0.12,
) {
  for (let ratio = strength; ratio > 0; ratio -= 0.02) {
    const surface = blend(background, color, ratio);
    if (contrast(surface, foreground) >= 4.5) return surface;
  }
  return background;
}
export function themeVariables(p: ThemePalette): Record<string, string> {
  const mix = (percentage: number) => blend(p.background, p.foreground, percentage / 100),
    muted = readable(
      blend(p.foreground, p.background, 0.4),
      [p.background, p.sidebar, mix(7)],
      p.foreground,
    );
  return {
    background: p.background,
    foreground: p.foreground,
    sidebar: p.sidebar,
    "sidebar-foreground": readable(blend(p.sidebar, p.foreground, 0.72), p.sidebar, p.foreground),
    primary: p.primary,
    "primary-foreground": p.primaryForeground,
    "primary-surface": tintedSurface(p.background, p.foreground, p.primary),
    card: p.background,
    "card-foreground": p.foreground,
    popover: mix(2),
    "popover-foreground": p.foreground,
    secondary: mix(5),
    "secondary-foreground": p.foreground,
    muted: mix(4),
    "muted-foreground": muted,
    accent: mix(7),
    "accent-foreground": p.foreground,
    border: mix(10),
    input: mix(18),
    ring: p.primary,
    success: readable("#4aab7e", [p.background, mix(7)], p.foreground),
    warning: readable("#c99b45", [p.background, mix(7)], p.foreground),
    destructive: readable("#d95f76", [p.background, mix(7)], p.foreground),
    "sidebar-primary": p.primary,
    "sidebar-primary-foreground": p.primaryForeground,
    "sidebar-accent": blend(p.sidebar, p.foreground, 0.1),
    "sidebar-accent-foreground": p.foreground,
    "sidebar-border": blend(p.sidebar, p.foreground, 0.1),
    "sidebar-ring": p.primary,
  };
}
export function decodeThemeFile(raw: string) {
  if (raw.length > 100000) throw new Error(t("settings.theme.fileTooLarge"));
  const parsed = z
    .object({ version: z.literal(1), themes: z.array(themeSchema).min(1).max(50) })
    .strict()
    .parse(JSON.parse(raw));
  return parsed.themes.map((theme) =>
    validateTheme({
      ...theme,
      id: theme.id.startsWith("custom-") ? theme.id : `custom-${theme.id}`,
    }),
  );
}
export function encodeThemeFile(themes: ThemeDefinition[]) {
  return JSON.stringify({ version: 1, themes }, null, 2);
}
