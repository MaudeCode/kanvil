// The browser's interface language: the saved choice, loading its catalog and calendar wording,
// and the root that re-renders everything when it changes. Like the theme, the choice belongs to
// this browser and survives signing out, so the sign-in page reads in it too.
import { Fragment, useSyncExternalStore, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import type { DayPickerProps } from "react-day-picker";
import {
  activeLocale,
  applyLocale,
  i18n,
  localePreference,
  resolveLocale,
  type Locale,
  type LocalePreference,
} from "@kanvil/contracts/i18n";

const storageKey = "kanvil:locale";
type CalendarLocale = NonNullable<DayPickerProps["locale"]>;
const calendars: Record<Locale, () => Promise<CalendarLocale>> = {
  "az-AZ": async () => (await import("react-day-picker/locale/az")).az,
  "de-DE": async () => (await import("react-day-picker/locale/de")).de,
  "el-GR": async () => (await import("react-day-picker/locale/el")).el,
  "en-US": async () => (await import("react-day-picker/locale/en-US")).enUS,
  "es-ES": async () => (await import("react-day-picker/locale/es")).es,
  "fr-FR": async () => (await import("react-day-picker/locale/fr")).fr,
  "hi-IN": async () => (await import("react-day-picker/locale/hi")).hi,
  "id-ID": async () => (await import("react-day-picker/locale/id")).id,
  "it-IT": async () => (await import("react-day-picker/locale/it")).it,
  "ja-JP": async () => (await import("react-day-picker/locale/ja")).ja,
  "ko-KR": async () => (await import("react-day-picker/locale/ko")).ko,
  "mk-MK": async () => (await import("react-day-picker/locale/mk")).mk,
  "nl-NL": async () => (await import("react-day-picker/locale/nl")).nl,
  "pl-PL": async () => (await import("react-day-picker/locale/pl")).pl,
  "pt-BR": async () => (await import("react-day-picker/locale/pt-BR")).ptBR,
  "ru-RU": async () => (await import("react-day-picker/locale/ru")).ru,
  "tr-TR": async () => (await import("react-day-picker/locale/tr")).tr,
  "uk-UA": async () => (await import("react-day-picker/locale/uk")).uk,
  "vi-VN": async () => (await import("react-day-picker/locale/vi")).vi,
  "zh-CN": async () => (await import("react-day-picker/locale/zh-CN")).zhCN,
  "zh-TW": async () => (await import("react-day-picker/locale/zh-TW")).zhTW,
};
let calendar: CalendarLocale | undefined;
// Month and weekday names for the calendar in the interface language; English until one loads.
export const calendarLocale = () => calendar;

export function savedLocalePreference(): LocalePreference {
  try {
    return localePreference.parse(localStorage.getItem(storageKey));
  } catch {
    return "system";
  }
}
// Applies a choice before the first render and on every change. A language whose files fail to
// load leaves the interface in English instead of blocking it.
export async function startLocale(preference: LocalePreference = savedLocalePreference()) {
  const locale = resolveLocale(preference, navigator.languages);
  try {
    const wording = await calendars[locale]();
    calendar = wording;
    await applyLocale(locale);
  } catch (error) {
    calendar = undefined;
    console.error(error);
  }
  document.documentElement.lang = activeLocale();
}
export async function setLocalePreference(preference: LocalePreference) {
  try {
    if (preference === "system") localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, preference);
  } catch {
    /* Without storage the choice lasts until the page reloads. */
  }
  await startLocale(preference);
}
export function useLocalePreference() {
  const language = useSyncExternalStore(subscribe, () => i18n.language);
  return { preference: savedLocalePreference(), locale: language };
}
function subscribe(listener: () => void) {
  i18n.on("languageChanged", listener);
  return () => i18n.off("languageChanged", listener);
}
// Remounts the app when the language changes, so every label, label table, and format reads the
// new language at once. The route stays in the URL and signed-in data restores from this
// browser's cache.
export function LocaleRoot({ children }: { children: ReactNode }) {
  const language = useSyncExternalStore(subscribe, () => i18n.language);
  return (
    <I18nextProvider i18n={i18n}>
      <Fragment key={language}>{children}</Fragment>
    </I18nextProvider>
  );
}
