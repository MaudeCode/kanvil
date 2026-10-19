# Languages

The web and native apps read in 21 languages: Azərbaycan dili (`az-AZ`), Deutsch (`de-DE`), Ελληνικά (`el-GR`), English (`en-US`), Español (`es-ES`), Français (`fr-FR`), हिन्दी (`hi-IN`), Bahasa Indonesia (`id-ID`), Italiano (`it-IT`), 日本語 (`ja-JP`), 한국어 (`ko-KR`), Македонски (`mk-MK`), Nederlands (`nl-NL`), Polski (`pl-PL`), Português (Brasil) (`pt-BR`), Русский (`ru-RU`), Türkçe (`tr-TR`), Українська (`uk-UA`), Tiếng Việt (`vi-VN`), 简体中文 (`zh-CN`), and 繁體中文 (`zh-TW`).

Choose one under **Settings → Preferences → Language** on the web or **Settings → Language** in the native app. **System default** follows the browser's or device's preferred languages: an exact match, then the same language (Traditional Chinese scripts and regions choose `zh-TW`), then English. The web choice belongs to the browser and also applies to the sign-in page; the native choice belongs to the device. Signing out or changing servers keeps it.

Only presentation changes. API values, saved filters and views, URLs, ticket content, names, keys, and identifiers stay as they are. Dates, times, numbers, relative times, calendar month and weekday names, and the first day of the week follow the interface language; **Week starts on** defaults to **Language default** and can still be set to Sunday, Monday, or Saturday. Error codes the server explains in English (`forbidden`, `not_found`, `version_conflict`, `claim_conflict`, `rate_limited`, and others listed in `translatedErrors`) read in the interface language; any other server message is shown as sent. Client-side validation messages come from Zod's catalog for the language. Rendered Markdown and ticket titles take their direction from their own text, so right-to-left content stays readable in any language.

The server, MCP tools, notifications it sends, and the API documentation stay in English.

## Catalogs

`packages/contracts/src/i18n` holds the locale list (`locales`, `localeDetails`), the i18next instance, `applyLocale`, the formatters (`formatDate`, `dateFormat`, `formatNumber`, `formatRelativeTime`, `firstWeekday`), and one directory per locale. Each directory has the same sections: `common` (contract values and generic actions shared by web and native), `shell`, `ticket`, `detail`, `settings`, and `admin` for the web, and `native` for the native app. English (`en-US`) is the source and the fallback for any missing key; other catalogs load only when chosen.

Contract label tables such as `stateLabels`, `priorityLabels`, `kindLabels`, `difficultyLabels`, `roleLabels`, `permissionLabels`, `relationChoices`, and `eventLabels` read the active language each time an entry is read, so web and native share one wording and the server keeps English. `apps/web/src/lib/locale.tsx` and `apps/mobile/src/locale.tsx` save the choice, load the catalog (and on the web the calendar wording), and remount the app below `LocaleRoot` when the language changes.

## Adding strings

Call `t("section.group.key", values)` from `@kanvil/contracts/i18n` and add the English text to that section in `en-US`, then to every other locale. Write complete sentences with `{{placeholders}}`; never join translated fragments. Use `{{label, lowercase}}` where English lowercases a label mid-sentence. Plurals use i18next keys with `count`: English has `_one` and `_other`, and each locale has exactly the categories its plural rules use (for example Russian `_one`, `_few`, `_many`, `_other`; Japanese only `_other`). Text with embedded elements uses `Trans` with named tags such as `<link>`. Text built at module load must read the language at render time instead.

`pnpm check` runs `packages/contracts/src/i18n/i18n.test.ts`, which fails when a locale lacks or adds a key, has the wrong plural categories, changes a placeholder or tag, or leaves a value empty, and checks the locale resolution, fallback, label, format, and error behavior.

## Adding a locale

Add its identifier to `locales` with its name and CLDR first weekday in `localeDetails`, a directory with every section, a loader in `catalogs`, its Zod messages in `validation`, and its calendar wording in `apps/web/src/lib/locale.tsx`. The catalog test then requires every key and plural form.
