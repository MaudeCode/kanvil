export const palettes = {
  light: {
    background: "#f5f6f8",
    backdrop: "rgba(23,33,43,0.35)",
    surface: "#ffffff",
    foreground: "#202632",
    muted: "#626c7c",
    line: "#dce1e9",
    accent: "#3458c5",
    accentSurface: "#e8edfb",
    danger: "#b42318",
    warning: "#946000",
    success: "#18794e",
  },
  dark: {
    background: "#171a21",
    backdrop: "rgba(0,0,0,0.6)",
    surface: "#1e222c",
    foreground: "#edf0f7",
    muted: "#a2acc0",
    line: "#343a49",
    accent: "#a4b8ff",
    accentSurface: "#2b3553",
    danger: "#ff9c92",
    warning: "#ebbf73",
    success: "#83d5ac",
  },
} as const;
export type ThemeMode = "light" | "dark" | "system";

export const brandPath = "M8 7h4v8l8-8h5L15 17l10 8h-6l-7-6v6H8z";
