import { expect, it } from "vite-plus/test";
import {
  builtInThemes,
  validateTheme,
  encodeThemeFile,
  decodeThemeFile,
  themeVariables,
  contrast,
  resolveThemeId,
} from "./themes.ts";
it("keeps all bundled theme pairs readable and exports portable custom themes", () => {
  for (const theme of builtInThemes) {
    expect(validateTheme(theme)).toEqual(theme);
    for (const mode of ["light", "dark"] as const) {
      const variables = themeVariables(theme[mode]);
      expect(variables.background).toBe(theme[mode].background);
      expect(
        contrast(theme[mode].sidebar, variables["sidebar-foreground"]!),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(theme[mode].background, variables["muted-foreground"] ?? theme[mode].foreground),
      ).toBeGreaterThanOrEqual(4.5);
      for (const surface of ["background", "sidebar", "secondary", "accent", "popover"]) {
        expect(
          contrast(variables[surface]!, variables.foreground!),
          `${theme.name} ${mode} ${surface} text`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(variables[surface]!, variables["muted-foreground"]!),
          `${theme.name} ${mode} ${surface} muted text`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      for (const token of ["success", "warning", "destructive"])
        expect(contrast(variables.background!, variables[token]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme[mode].background, theme[mode].primary)).toBeGreaterThanOrEqual(4.5);
    }
    const custom = decodeThemeFile(encodeThemeFile([theme]));
    expect(custom).toEqual([{ ...theme, id: `custom-${theme.id}` }]);
  }
});
it("defaults to Aligned and resolves old palette preferences without touching custom themes", () => {
  expect(builtInThemes[0].id).toBe("aligned");
  expect(builtInThemes.length).toBeGreaterThanOrEqual(18);
  expect(new Set(builtInThemes.map((t) => t.id)).size).toBe(builtInThemes.length);
  for (const name of [
    "Catppuccin Mocha",
    "Solarized",
    "GitHub",
    "Dracula",
    "One Dark",
    "Nord",
    "Tokyo Night",
    "Gruvbox",
    "Rosé Pine",
    "Everforest",
    "Monokai",
    "Night Owl",
    "Ayu",
  ])
    expect(builtInThemes.some((t) => t.name === name)).toBe(true);
  expect(resolveThemeId(null)).toBe("aligned");
  expect(resolveThemeId("kanvil")).toBe("aligned");
  expect(resolveThemeId("linear")).toBe("aligned");
  expect(resolveThemeId("ocean")).toBe("tokyo-night");
  expect(resolveThemeId("custom-my-theme")).toBe("custom-my-theme");
});
it("rejects unreadable colors, CSS injection, oversized and incompatible theme imports", () => {
  const theme = builtInThemes[0];
  expect(() =>
    validateTheme({ ...theme, light: { ...theme.light, foreground: theme.light.background } }),
  ).toThrow("contrast");
  expect(() =>
    validateTheme({ ...theme, dark: { ...theme.dark, primary: "url(https://example.test)" } }),
  ).toThrow();
  expect(() => decodeThemeFile("x".repeat(100001))).toThrow("100 KB");
  expect(() => decodeThemeFile(JSON.stringify({ version: 2, themes: [theme] }))).toThrow();
});
