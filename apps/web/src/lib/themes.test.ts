import { expect, it } from "vite-plus/test";
import {
  builtInThemes,
  validateTheme,
  encodeThemeFile,
  decodeThemeFile,
  themeVariables,
} from "./themes.ts";
it("keeps all bundled theme pairs readable and exports portable custom themes", () => {
  for (const theme of builtInThemes) {
    expect(validateTheme(theme)).toEqual(theme);
    for (const mode of ["light", "dark"] as const) {
      const variables = themeVariables(theme[mode]);
      expect(variables.background).toBe(theme[mode].background);
      expect(variables["sidebar-foreground"]).toBe(theme[mode].foreground);
    }
    const custom = decodeThemeFile(encodeThemeFile([theme]));
    expect(custom).toEqual([{ ...theme, id: `custom-${theme.id}` }]);
  }
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
