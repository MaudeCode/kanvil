// The interface language for web and native: the supported locales, the i18next instance with the
// English catalog built in, loading another locale, and the date and number formats that follow
// it. API values, ticket content, and identifiers are never translated; only their presentation.
import i18next from "i18next";
import { z } from "zod";
import en from "./en-US/index.ts";

export const locales = [
  "az-AZ",
  "de-DE",
  "el-GR",
  "en-US",
  "es-ES",
  "fr-FR",
  "hi-IN",
  "id-ID",
  "it-IT",
  "ja-JP",
  "ko-KR",
  "mk-MK",
  "nl-NL",
  "pl-PL",
  "pt-BR",
  "ru-RU",
  "tr-TR",
  "uk-UA",
  "vi-VN",
  "zh-CN",
  "zh-TW",
] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en-US";
export const isLocale = (value: unknown): value is Locale =>
  locales.some((locale) => locale === value);
// Each language in its own words, and its first day of the week (0 is Sunday) from CLDR.
export const localeDetails: Record<Locale, { name: string; firstDay: 0 | 1 | 6 }> = {
  "az-AZ": { name: "Azərbaycan dili", firstDay: 1 },
  "de-DE": { name: "Deutsch", firstDay: 1 },
  "el-GR": { name: "Ελληνικά", firstDay: 1 },
  "en-US": { name: "English", firstDay: 0 },
  "es-ES": { name: "Español", firstDay: 1 },
  "fr-FR": { name: "Français", firstDay: 1 },
  "hi-IN": { name: "हिन्दी", firstDay: 0 },
  "id-ID": { name: "Bahasa Indonesia", firstDay: 0 },
  "it-IT": { name: "Italiano", firstDay: 1 },
  "ja-JP": { name: "日本語", firstDay: 0 },
  "ko-KR": { name: "한국어", firstDay: 0 },
  "mk-MK": { name: "Македонски", firstDay: 1 },
  "nl-NL": { name: "Nederlands", firstDay: 1 },
  "pl-PL": { name: "Polski", firstDay: 1 },
  "pt-BR": { name: "Português (Brasil)", firstDay: 0 },
  "ru-RU": { name: "Русский", firstDay: 1 },
  "tr-TR": { name: "Türkçe", firstDay: 1 },
  "uk-UA": { name: "Українська", firstDay: 1 },
  "vi-VN": { name: "Tiếng Việt", firstDay: 1 },
  "zh-CN": { name: "简体中文", firstDay: 1 },
  "zh-TW": { name: "繁體中文", firstDay: 0 },
};
// A saved choice: a locale, or `system` to follow the browser or device. Anything else, such as a
// locale a later release removed, reads as `system`.
export const localePreference = z.union([z.enum(locales), z.literal("system")]).catch("system");
export type LocalePreference = z.output<typeof localePreference>;

// The locale for a saved choice and the platform's preferred languages: an exact match, then the
// same language (Traditional Chinese scripts and regions choose zh-TW), then English.
export function resolveLocale(
  preference: unknown,
  preferred: readonly (string | null | undefined)[] = [],
): Locale {
  const choice = localePreference.parse(preference);
  if (choice !== "system") return choice;
  for (const candidate of preferred) {
    if (!candidate) continue;
    const tag = candidate.replaceAll("_", "-").toLowerCase();
    const exact = locales.find((locale) => locale.toLowerCase() === tag);
    if (exact) return exact;
    const [language] = tag.split("-");
    if (language === "zh") return /-(hant|tw|hk|mo)\b/.test(tag) ? "zh-TW" : "zh-CN";
    const sameLanguage = locales.find((locale) => locale.split("-")[0] === language);
    if (sameLanguage) return sameLanguage;
  }
  return defaultLocale;
}

export type Catalog = { readonly [key: string]: string | Catalog };
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}
// One instance per app. It starts in English synchronously, so the server and tests read English
// labels without setup, and clients switch with `applyLocale`.
export const i18n = i18next.createInstance();
void i18n.init({
  lng: defaultLocale,
  fallbackLng: defaultLocale,
  supportedLngs: locales,
  resources: { [defaultLocale]: { translation: en } },
  initAsync: false,
  // React escapes text itself; catalogs hold plain text.
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});
// `{{label, lowercase}}` puts a label mid-sentence where the language lowercases it there.
i18n.services.formatter?.add("lowercase", (value: unknown, locale) =>
  String(value).toLocaleLowerCase(locale),
);
export const t: typeof i18n.t = i18n.t.bind(i18n);
export const activeLocale = (): Locale => (isLocale(i18n.language) ? i18n.language : defaultLocale);

type Loaded = { default: Catalog };
const catalogs: Record<Exclude<Locale, "en-US">, () => Promise<Loaded>> = {
  "az-AZ": () => import("./az-AZ/index.ts"),
  "de-DE": () => import("./de-DE/index.ts"),
  "el-GR": () => import("./el-GR/index.ts"),
  "es-ES": () => import("./es-ES/index.ts"),
  "fr-FR": () => import("./fr-FR/index.ts"),
  "hi-IN": () => import("./hi-IN/index.ts"),
  "id-ID": () => import("./id-ID/index.ts"),
  "it-IT": () => import("./it-IT/index.ts"),
  "ja-JP": () => import("./ja-JP/index.ts"),
  "ko-KR": () => import("./ko-KR/index.ts"),
  "mk-MK": () => import("./mk-MK/index.ts"),
  "nl-NL": () => import("./nl-NL/index.ts"),
  "pl-PL": () => import("./pl-PL/index.ts"),
  "pt-BR": () => import("./pt-BR/index.ts"),
  "ru-RU": () => import("./ru-RU/index.ts"),
  "tr-TR": () => import("./tr-TR/index.ts"),
  "uk-UA": () => import("./uk-UA/index.ts"),
  "vi-VN": () => import("./vi-VN/index.ts"),
  "zh-CN": () => import("./zh-CN/index.ts"),
  "zh-TW": () => import("./zh-TW/index.ts"),
};
// Zod's own messages for input it rejects on the client, in the same language.
type ZodLocale = { default: () => Parameters<typeof z.config>[0] };
const validation: Record<Locale, () => Promise<ZodLocale>> = {
  "az-AZ": () => import("zod/v4/locales/az.js"),
  "de-DE": () => import("zod/v4/locales/de.js"),
  "el-GR": () => import("zod/v4/locales/el.js"),
  "en-US": () => import("zod/v4/locales/en.js"),
  "es-ES": () => import("zod/v4/locales/es.js"),
  "fr-FR": () => import("zod/v4/locales/fr.js"),
  "hi-IN": () => import("zod/v4/locales/hi.js"),
  "id-ID": () => import("zod/v4/locales/id.js"),
  "it-IT": () => import("zod/v4/locales/it.js"),
  "ja-JP": () => import("zod/v4/locales/ja.js"),
  "ko-KR": () => import("zod/v4/locales/ko.js"),
  "mk-MK": () => import("zod/v4/locales/mk.js"),
  "nl-NL": () => import("zod/v4/locales/nl.js"),
  "pl-PL": () => import("zod/v4/locales/pl.js"),
  "pt-BR": () => import("zod/v4/locales/pt-BR.js"),
  "ru-RU": () => import("zod/v4/locales/ru.js"),
  "tr-TR": () => import("zod/v4/locales/tr.js"),
  "uk-UA": () => import("zod/v4/locales/uk.js"),
  "vi-VN": () => import("zod/v4/locales/vi.js"),
  "zh-CN": () => import("zod/v4/locales/zh-CN.js"),
  "zh-TW": () => import("zod/v4/locales/zh-TW.js"),
};
export const loadCatalog = async (locale: Locale): Promise<Catalog> =>
  locale === "en-US" ? en : (await catalogs[locale]()).default;
// Switches the interface to a locale, loading its catalog once. A catalog that fails to load
// leaves the interface in English rather than half translated; the error goes to the caller.
export async function applyLocale(locale: Locale): Promise<Locale> {
  try {
    if (!i18n.hasResourceBundle(locale, "translation"))
      i18n.addResourceBundle(locale, "translation", await loadCatalog(locale));
    z.config((await validation[locale]()).default());
    await i18n.changeLanguage(locale);
    return locale;
  } catch (error) {
    await i18n.changeLanguage(defaultLocale);
    throw error;
  }
}

// Formats follow the interface language, not the platform's, so dates and numbers read the same
// way as the words around them. Each format is built once per locale.
function perLocale<O extends object, T>(make: (locale: Locale, options: O) => T) {
  const made = new Map<string, T>();
  return (options: O): T => {
    const locale = activeLocale(),
      key = `${locale}|${JSON.stringify(options)}`;
    const found = made.get(key) ?? make(locale, options);
    made.set(key, found);
    return found;
  };
}
const dateFormats = perLocale(
    (locale, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options),
  ),
  numberFormats = perLocale(
    (locale, options: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options),
  ),
  relativeFormats = perLocale(
    (locale, options: Intl.RelativeTimeFormatOptions) =>
      new Intl.RelativeTimeFormat(locale, options),
  );
export const dateFormat = (options: Intl.DateTimeFormatOptions = { dateStyle: "medium" }) =>
  dateFormats(options);
export const formatDate = (
  value: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
): string => dateFormat(options).format(new Date(value));
export const formatNumber = (value: number, options: Intl.NumberFormatOptions = {}): string =>
  numberFormats(options).format(value);
const relativeUnits: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
];
// "3 minutes ago" or "in 2 days": the largest whole unit, rounded, like date-fns' strict distance.
export function formatRelativeTime(value: Date | string | number, now = Date.now()): string {
  const seconds = (new Date(value).getTime() - now) / 1000,
    [unit, size] = relativeUnits.find(([, length]) => Math.abs(seconds) >= length) ?? ["second", 1];
  return relativeFormats({ numeric: "always" }).format(Math.round(seconds / size), unit);
}
// The interface language's first day of the week, for pickers left on the language default.
export const firstWeekday = (locale: Locale = activeLocale()) => localeDetails[locale].firstDay;

const complete = <K extends string, V>(
  table: Partial<Record<K, V>>,
  keys: readonly K[],
): table is Record<K, V> => keys.every((key) => Object.hasOwn(table, key));
// A label table whose entries read the active language each time they are read, so a table
// exported once at module load still follows a later language change.
export function labelTable<K extends string, V = string>(
  keys: readonly K[],
  read: (key: K) => V,
): Record<K, V> {
  const table: Partial<Record<K, V>> = {};
  for (const key of keys)
    Object.defineProperty(table, key, { get: () => read(key), enumerable: true });
  if (!complete(table, keys)) throw new Error("A label table is missing a key");
  return table;
}
