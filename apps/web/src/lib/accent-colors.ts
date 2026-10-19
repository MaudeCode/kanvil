import { isPresetColor, type LabelColor } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";

export const accentColorClasses = {
  default: "text-primary",
  red: "text-red-500",
  orange: "text-orange-500",
  amber: "text-amber-500",
  yellow: "text-yellow-600 dark:text-yellow-400",
  lime: "text-lime-600 dark:text-lime-400",
  green: "text-green-600 dark:text-green-400",
  emerald: "text-emerald-600 dark:text-emerald-400",
  teal: "text-teal-600 dark:text-teal-400",
  cyan: "text-cyan-600 dark:text-cyan-400",
  sky: "text-sky-500",
  blue: "text-blue-500",
  indigo: "text-indigo-500",
  violet: "text-violet-500",
  purple: "text-purple-500",
  fuchsia: "text-fuchsia-500",
  pink: "text-pink-500",
  rose: "text-rose-500",
  gray: "text-muted-foreground",
};
// A swatch's color in words: presets have a name, a custom hex reads as itself.
export const accentColorName = (value: LabelColor) =>
  isPresetColor(value) ? t(`settings.color.${value}`) : value;
// Presets map to a class; a custom hex becomes an inline color on the same element.
export function accentColor(value: LabelColor): { className?: string; style?: { color: string } } {
  return isPresetColor(value)
    ? { className: accentColorClasses[value] }
    : { style: { color: value } };
}
