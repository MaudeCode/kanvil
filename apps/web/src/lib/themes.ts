import { z } from "zod";
const hex = z.string().regex(/^#[0-9a-f]{6}$/i, "Use a six-digit hex color");
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
const colors = (
  background: string,
  foreground: string,
  sidebar: string,
  primary: string,
  primaryForeground: string,
): ThemePalette => ({ background, foreground, sidebar, primary, primaryForeground });
export const builtInThemes: [ThemeDefinition, ...ThemeDefinition[]] = [
  {
    id: "kanvil",
    name: "Kanvil",
    light: colors("#ffffff", "#252933", "#f3f4f7", "#3458c5", "#ffffff"),
    dark: colors("#16181d", "#e5e7eb", "#101216", "#93b0ff", "#101c35"),
  },
  {
    id: "graphite",
    name: "Graphite",
    light: colors("#ffffff", "#262626", "#f4f4f4", "#303030", "#ffffff"),
    dark: colors("#171717", "#ededed", "#101010", "#e3e3e3", "#171717"),
  },
  {
    id: "forest",
    name: "Forest",
    light: colors("#f9fcf9", "#233a2b", "#edf3ed", "#24724b", "#ffffff"),
    dark: colors("#17231d", "#e2ede5", "#111b16", "#87d2a2", "#13291c"),
  },
  {
    id: "ember",
    name: "Ember",
    light: colors("#fffaf5", "#423126", "#f8efe5", "#a34824", "#ffffff"),
    dark: colors("#271d17", "#f2e6dc", "#1d1511", "#efaf79", "#352016"),
  },
  {
    id: "ocean",
    name: "Ocean",
    light: colors("#f7fbff", "#16324f", "#edf3f9", "#176b9b", "#ffffff"),
    dark: colors("#0e1a27", "#dbeaf5", "#0a1420", "#7ac5f1", "#102536"),
  },
  {
    id: "iris",
    name: "Iris",
    light: colors("#fcfaff", "#302740", "#f0ecf8", "#7352ac", "#ffffff"),
    dark: colors("#211c2e", "#e9e3f5", "#181421", "#c1a4ed", "#2a1d3f"),
  },
  {
    id: "rose",
    name: "Rose",
    light: colors("#fff9fa", "#462832", "#f7eaee", "#a53e63", "#ffffff"),
    dark: colors("#2b1b23", "#f5e3eb", "#21141a", "#efa3c1", "#3b1928"),
  },
  {
    id: "nord",
    name: "Nord",
    light: colors("#eceff4", "#2e3440", "#e5e9f0", "#4c647a", "#ffffff"),
    dark: colors("#2e3440", "#eceff4", "#242933", "#88c0d0", "#172b32"),
  },
  {
    id: "sand",
    name: "Sand",
    light: colors("#faf7f0", "#433c2c", "#eee8dc", "#8a6225", "#ffffff"),
    dark: colors("#29251d", "#eee8d8", "#201c16", "#d8b980", "#332712"),
  },
  {
    id: "slate",
    name: "Slate",
    light: colors("#f8fafc", "#1e293b", "#eef2f6", "#475569", "#ffffff"),
    dark: colors("#18202d", "#e2e8f0", "#111824", "#a7b8d0", "#162336"),
  },
];
function luminance(color: string) {
  const channels = [1, 3, 5]
    .map((index) => Number.parseInt(color.slice(index, index + 2), 16) / 255)
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
      throw new Error(`Increase the ${mode} theme's text contrast to at least 4.5:1.`);
  }
  return theme;
}
export function themeVariables(p: ThemePalette): Record<string, string> {
  const mix = (percentage: number) =>
    `color-mix(in oklch, ${p.background}, ${p.foreground} ${percentage}%)`;
  return {
    background: p.background,
    foreground: p.foreground,
    sidebar: p.sidebar,
    "sidebar-foreground": p.foreground,
    primary: p.primary,
    "primary-foreground": p.primaryForeground,
    card: p.background,
    "card-foreground": p.foreground,
    popover: mix(2),
    "popover-foreground": p.foreground,
    secondary: mix(6),
    "secondary-foreground": p.foreground,
    muted: mix(5),
    "muted-foreground": `color-mix(in oklch, ${p.foreground}, ${p.background} 32%)`,
    accent: mix(9),
    "accent-foreground": p.foreground,
    border: mix(14),
    input: mix(22),
    ring: p.primary,
    "sidebar-primary": p.primary,
    "sidebar-primary-foreground": p.primaryForeground,
    "sidebar-accent": `color-mix(in oklch, ${p.sidebar}, ${p.foreground} 10%)`,
    "sidebar-accent-foreground": p.foreground,
    "sidebar-border": mix(14),
    "sidebar-ring": p.primary,
  };
}
export function decodeThemeFile(raw: string) {
  if (raw.length > 100000) throw new Error("Theme files must be smaller than 100 KB.");
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
