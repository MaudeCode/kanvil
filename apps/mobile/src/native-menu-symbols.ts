import type { ButtonProps } from "@expo/ui/swift-ui";

// System menus accept SF Symbols; adapt the shared Lucide vocabulary at this boundary.
const symbols: Record<string, ButtonProps["systemImage"]> = {
  "layout-list": "list.bullet",
  "columns-3": "rectangle.split.3x1",
  calendar: "calendar",
  "chart-gantt": "chart.bar.xaxis",
  "circle-dashed": "circle.dashed",
  circle: "circle",
  "circle-dot": "circle.inset.filled",
  clock: "clock",
  "circle-check": "checkmark.circle",
  "circle-x": "xmark.circle",
  "octagon-alert": "exclamationmark.octagon",
  "arrow-up": "arrow.up",
  equal: "equal",
  "arrow-down": "arrow.down",
  minus: "minus",
  sparkles: "sparkles",
  bug: "ladybug",
  wrench: "wrench",
  "flask-conical": "flask",
  "book-open": "book",
  "chart-bar": "chart.bar.fill",
  "circle-user-round": "person.crop.circle",
};
export function nativeMenuSymbol(name: string) {
  return symbols[name] ?? Object.values(symbols).find((symbol) => symbol === name);
}
