import { ticketSymbols } from "./icons.ts";
import type { Ticket } from "./index.ts";
import { isPresetColor, type LabelColor } from "./index.ts";
import { t } from "./i18n/index.ts";
// One preset table, with CSS and native representations of each accent.
const accents = {
  default: { className: "text-primary", light: null, dark: null },
  red: { className: "text-red-500", light: "#ef4444", dark: "#ef4444" },
  orange: { className: "text-orange-500", light: "#f97316", dark: "#f97316" },
  amber: { className: "text-amber-500", light: "#f59e0b", dark: "#f59e0b" },
  yellow: { className: "text-yellow-600 dark:text-yellow-400", light: "#ca8a04", dark: "#facc15" },
  lime: { className: "text-lime-600 dark:text-lime-400", light: "#65a30d", dark: "#a3e635" },
  green: { className: "text-green-600 dark:text-green-400", light: "#16a34a", dark: "#4ade80" },
  emerald: {
    className: "text-emerald-600 dark:text-emerald-400",
    light: "#059669",
    dark: "#34d399",
  },
  teal: { className: "text-teal-600 dark:text-teal-400", light: "#0d9488", dark: "#2dd4bf" },
  cyan: { className: "text-cyan-600 dark:text-cyan-400", light: "#0891b2", dark: "#22d3ee" },
  sky: { className: "text-sky-500", light: "#0ea5e9", dark: "#0ea5e9" },
  blue: { className: "text-blue-500", light: "#3b82f6", dark: "#3b82f6" },
  indigo: { className: "text-indigo-500", light: "#6366f1", dark: "#6366f1" },
  violet: { className: "text-violet-500", light: "#8b5cf6", dark: "#8b5cf6" },
  purple: { className: "text-purple-500", light: "#a855f7", dark: "#a855f7" },
  fuchsia: { className: "text-fuchsia-500", light: "#d946ef", dark: "#d946ef" },
  pink: { className: "text-pink-500", light: "#ec4899", dark: "#ec4899" },
  rose: { className: "text-rose-500", light: "#f43f5e", dark: "#f43f5e" },
  gray: { className: "text-muted-foreground", light: null, dark: null },
};
export const accentColorClasses = Object.fromEntries(
  Object.entries(accents).map(([name, value]) => [name, value.className]),
);
export const accentColorName = (value: LabelColor) =>
  isPresetColor(value) ? t(`settings.color.${value}`) : value;
export function accentColor(value: LabelColor): { className?: string; style?: { color: string } } {
  return isPresetColor(value)
    ? { className: accentColorClasses[value] ?? "text-primary" }
    : { style: { color: value } };
}
export function nativeAccentColor(
  value: LabelColor,
  mode: "light" | "dark",
  palette: { accent: string; muted: string },
) {
  if (!isPresetColor(value)) return value;
  return accents[value][mode] ?? (value === "gray" ? palette.muted : palette.accent);
}

// A custom workflow tint overrides its category, identically in symbols and schedule bars.
export function nativeStatusColor(
  status: Ticket["status"],
  tint: LabelColor | undefined,
  mode: "light" | "dark",
  palette: { accent: string; muted: string; warning: string; success: string },
) {
  return tint && tint !== "default"
    ? nativeAccentColor(tint, mode, palette)
    : palette[ticketSymbols.status[status].tone];
}
