import type { ReservedRegion } from "react-native-reserved-regions";

type Rect = ReservedRegion["frame"];
type Bounds = Pick<Rect, "width" | "height">;
const minimumPrimary = 280,
  minimumSecondary = 320;
const fullRect = (bounds: Bounds) => ({ x: 0, y: 0, ...bounds });
const collapsed = (rect: Rect) => ({ collapsed: true, primary: rect, secondary: rect });
function divisionLayout(bounds: Bounds, regions: readonly ReservedRegion[]) {
  const full = fullRect(bounds);
  for (const region of regions) {
    if (region.kind !== "division") continue;
    const fold = region.frame,
      vertical = fold.height > fold.width;
    const start = vertical ? fold.x : fold.y,
      gap = vertical ? fold.width : fold.height;
    const length = vertical ? bounds.width : bounds.height;
    // Ignore an old display's measurement while the new viewport is being laid out.
    if (start <= 0 || gap < 0 || start + gap >= length) continue;
    return {
      primary: vertical ? { ...full, width: start } : { ...full, height: start },
      secondary: vertical
        ? { ...full, x: start + gap, width: length - start - gap }
        : { ...full, y: start + gap, height: length - start - gap },
      primarySpace: start,
      secondarySpace: length - start - gap,
    };
  }
  return null;
}
const larger = (first: Rect, second: Rect) =>
  first.width * first.height >= second.width * second.height ? first : second;

// Forms and single lists occupy one usable facet while the fold is active.
export function usableViewport(bounds: Bounds, regions: readonly ReservedRegion[]) {
  const division = divisionLayout(bounds, regions);
  if (!division) return fullRect(bounds);
  // Reading and editing belong on the trailing facet; a constrained fold still needs room.
  return division.secondarySpace >= minimumSecondary
    ? division.secondary
    : larger(division.primary, division.secondary);
}
// Region frames and the viewport use the same provider-local coordinates, after bar insets.
export function paneLayout(bounds: Bounds, regions: readonly ReservedRegion[], enabled = true) {
  if (!enabled) return collapsed(fullRect(bounds));
  const division = divisionLayout(bounds, regions);
  if (division) {
    const { primary, secondary, primarySpace, secondarySpace } = division;
    if (primarySpace < minimumPrimary || secondarySpace < minimumSecondary)
      return collapsed(larger(primary, secondary));
    return { collapsed: false, primary, secondary };
  }
  const full = fullRect(bounds);
  if (bounds.width < minimumPrimary + minimumSecondary) return collapsed(full);
  const width = Math.min(420, Math.max(minimumPrimary, bounds.width * 0.42));
  return {
    collapsed: false,
    primary: { ...full, width },
    secondary: { ...full, x: width, width: bounds.width - width },
  };
}

// A compact flow reserves the measured overflow label; a long first item still wraps fully.
export function inlineItemCount(
  widths: readonly number[],
  available: number,
  overflow: number,
  gap = 5,
) {
  if (!widths.length || available <= 0) return 0;
  if (widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1) <= available)
    return widths.length;
  let used = 0,
    count = 0;
  for (const width of widths) {
    const next = used + (count ? gap : 0) + width;
    if (next + gap + overflow > available) break;
    used = next;
    count++;
  }
  return Math.max(1, count);
}
