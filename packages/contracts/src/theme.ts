export const palettes = {
  light: {
    background: "#f7f8fa",
    surface: "#ffffff",
    foreground: "#17212b",
    muted: "#697783",
    line: "#e0e5e8",
    accent: "#17695e",
    accentSurface: "#e4f2ee",
    danger: "#b42318",
    warning: "#946000",
    success: "#18794e",
  },
  dark: {
    background: "#11171c",
    surface: "#182128",
    foreground: "#e8eef2",
    muted: "#9baab5",
    line: "#2c3942",
    accent: "#77cfbd",
    accentSurface: "#203d36",
    danger: "#ff9c92",
    warning: "#ebbf73",
    success: "#83d5ac",
  },
} as const;
export type ThemeMode = "light" | "dark" | "system";
