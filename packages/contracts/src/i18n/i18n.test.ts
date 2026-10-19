import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  ApiError,
  errorMessage,
  formatCustomFieldValue,
  formatTimestamp,
  priorityLabels,
  relationChoices,
  repositoryTriggerLabel,
  stateLabels,
  workflowStateName,
} from "../index.ts";
import {
  applyLocale,
  activeLocale,
  firstWeekday,
  formatDate,
  formatNumber,
  formatRelativeTime,
  i18n,
  loadCatalog,
  localeDetails,
  locales,
  resolveLocale,
  t,
  type Catalog,
  type Locale,
} from "./index.ts";
import en from "./en-US/index.ts";

const pluralSuffix = /_(zero|one|two|few|many|other)$/;
// Every leaf of a catalog by its dotted path.
function leaves(catalog: Catalog, prefix = ""): Map<string, string> {
  const found = new Map<string, string>();
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") found.set(path, value);
    else for (const [inner, text] of leaves(value, path)) found.set(inner, text);
  }
  return found;
}
// Plain keys, and plural keys grouped by their base with the categories present.
function shape(catalog: Catalog) {
  const plain = new Map<string, string>(),
    plural = new Map<string, Map<string, string>>();
  for (const [path, value] of leaves(catalog)) {
    const match = pluralSuffix.exec(path);
    if (!match?.[1]) plain.set(path, value);
    else {
      const base = path.slice(0, match.index),
        forms = plural.get(base) ?? new Map<string, string>();
      forms.set(match[1], value);
      plural.set(base, forms);
    }
  }
  return { plain, plural };
}
// Values with how often each occurs, so comparisons ignore order.
function counts(values: Iterable<string | undefined>) {
  const found = new Map<string, number>();
  for (const value of values) if (value) found.set(value, (found.get(value) ?? 0) + 1);
  return found;
}
const placeholders = (value: string) =>
  counts([...value.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((match) => match[1]));
const tags = (value: string) =>
  counts([...value.matchAll(/<\/?([\w-]+)\s*\/?>/g)].map((match) => match[0]));
const pluralCategories = (locale: Locale) =>
  counts(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
const source = shape(en);
const catalog = loadCatalog;
// The platform's first day of the week (Monday is 1, Sunday 7), where the runtime reports it.
function platformWeekStart(locale: Locale): number | undefined {
  const intl = new Intl.Locale(locale),
    read: unknown = Reflect.get(intl, "getWeekInfo");
  if (typeof read !== "function") return undefined;
  const info = z.object({ firstDay: z.number() }).safeParse(Reflect.apply(read, intl, []));
  return info.success ? info.data.firstDay : undefined;
}

describe("catalogs", () => {
  it("defines every English key with every plural form English needs", () => {
    expect(source.plain.size).toBeGreaterThan(100);
    for (const [base, forms] of source.plural)
      expect(counts(forms.keys()), base).toEqual(pluralCategories("en-US"));
  });
  it.each(locales.filter((locale) => locale !== "en-US"))(
    "%s has every key, plural form, placeholder, and tag of English",
    async (locale) => {
      const { plain, plural } = shape(await catalog(locale));
      const missing = [...source.plain.keys()].filter((key) => !plain.has(key)),
        extra = [...plain.keys()].filter((key) => !source.plain.has(key));
      expect(missing, "missing keys").toEqual([]);
      expect(extra, "keys English does not have").toEqual([]);
      expect(counts(plural.keys()), "plural keys").toEqual(counts(source.plural.keys()));
      for (const [key, text] of source.plain) {
        const translated = plain.get(key) ?? "";
        expect(translated.trim(), key).not.toBe("");
        expect(placeholders(translated), key).toEqual(placeholders(text));
        expect(tags(translated), key).toEqual(tags(text));
      }
      for (const [base, forms] of plural) {
        expect(counts(forms.keys()), base).toEqual(pluralCategories(locale));
        const other = source.plural.get(base)?.get("other") ?? "";
        for (const [form, text] of forms) {
          expect(text.trim(), `${base}_${form}`).not.toBe("");
          expect(tags(text), `${base}_${form}`).toEqual(tags(other));
          // A form may spell its number out ("one ticket") but uses no placeholder English lacks.
          for (const name of placeholders(text).keys())
            expect(placeholders(other).has(name), `${base}_${form} uses {{${name}}}`).toBe(true);
        }
        expect(placeholders(forms.get("other") ?? ""), `${base}_other`).toEqual(
          placeholders(other),
        );
      }
    },
  );
  it("names each language in its own words and starts weeks where CLDR does", () => {
    expect(new Set(Object.values(localeDetails).map(({ name }) => name)).size).toBe(locales.length);
    for (const locale of locales) {
      const day = platformWeekStart(locale);
      if (day !== undefined) expect(firstWeekday(locale), locale).toBe(day % 7);
    }
  });
});

describe("locale choice", () => {
  it("resolves a saved choice, then the platform's languages, then English", () => {
    expect(resolveLocale("de-DE", ["fr-FR"])).toBe("de-DE");
    expect(resolveLocale("system", ["fr-CA", "de-DE"])).toBe("fr-FR");
    expect(resolveLocale(undefined, ["pt-PT"])).toBe("pt-BR");
    expect(resolveLocale("system", ["zh-Hant-HK"])).toBe("zh-TW");
    expect(resolveLocale("system", ["zh"])).toBe("zh-CN");
    expect(resolveLocale("system", ["JA_jp"])).toBe("ja-JP");
    // A removed or corrupt saved value and an unsupported language both fall back safely.
    expect(resolveLocale("xx-XX", ["sw-KE"])).toBe("en-US");
    expect(resolveLocale({ locale: "de-DE" }, [])).toBe("en-US");
    expect(resolveLocale("system", [null, "", undefined])).toBe("en-US");
  });
});

describe("presentation in another language", () => {
  afterEach(async () => {
    await applyLocale("en-US");
  });
  it("reads labels, dates, numbers, and errors in the active language", async () => {
    expect(stateLabels.in_progress).toBe("In progress");
    await applyLocale("de-DE");
    expect(activeLocale()).toBe("de-DE");
    const german = await catalog("de-DE");
    expect(stateLabels.in_progress).toBe(leaves(german).get("common.status.in_progress"));
    expect(priorityLabels.none).not.toBe("No priority");
    // Default state names read in the language; names a project chose stay as written.
    expect(workflowStateName({ slug: "todo", name: "To do", category: "todo" })).toBe(
      stateLabels.todo,
    );
    expect(workflowStateName({ slug: "todo", name: "Triage", category: "todo" })).toBe("Triage");
    expect(workflowStateName({ slug: "triage", name: "To do", category: "todo" })).toBe("To do");
    expect(relationChoices[0]?.label).toBe(leaves(german).get("common.relation.blocks.outgoing"));
    expect(repositoryTriggerLabel("pull_request_merged", "gitlab")).toBe(
      leaves(german).get("common.change.merge_request.merged"),
    );
    expect(formatNumber(1234.5)).toBe("1.234,5");
    expect(formatDate("2026-03-04T12:00:00Z", { dateStyle: "short", timeZone: "UTC" })).toBe(
      "04.03.26",
    );
    expect(formatTimestamp("2026-03-04T12:00:00Z")).toContain("2026");
    expect(formatRelativeTime(Date.now() - 3 * 60_000)).toBe("vor 3 Minuten");
    expect(
      formatCustomFieldValue({ type: "number", options: [] }, 1234.5),
      "custom fields format like the language",
    ).toBe("1.234,5");
    // Codes the server explains in English read in the interface language.
    expect(
      errorMessage(new ApiError(403, "forbidden", "Only the workspace owner can do this")),
    ).toBe(leaves(german).get("common.error.code.forbidden"));
    // Unknown codes keep the server's message.
    expect(errorMessage(new ApiError(409, "duplicate_label", "That label exists"))).toBe(
      "That label exists",
    );
    // Client-side validation messages come from Zod's catalog for the language.
    const issue = z.string().min(3).safeParse("a");
    expect(issue.success).toBe(false);
    if (!issue.success) expect(errorMessage(issue.error)).not.toMatch(/Too small/);
    expect(firstWeekday()).toBe(1);
  });
  it("keeps English server messages and English fallback for keys a catalog lacks", async () => {
    expect(
      errorMessage(new ApiError(403, "forbidden", "Only the workspace owner can do this")),
    ).toBe("Only the workspace owner can do this");
    expect(formatRelativeTime(Date.now() + 2 * 86_400_000)).toBe("in 2 days");
    const partial = i18n.cloneInstance({ lng: "de-DE", forkResourceStore: true });
    partial.addResourceBundle("de-DE", "translation", { common: { status: {} } }, false, true);
    expect(partial.t("common.status.todo")).toBe("To do");
    await expect(applyLocale("de-DE")).resolves.toBe("de-DE");
    expect(t("common.language.label")).not.toBe("Language");
  });
});
