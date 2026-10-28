import { defaultRangeExtractor, type Range } from "@tanstack/react-virtual";

// Extends the virtualizer's normal window with bounded interaction targets, addressed by ticket ID.
export function ticketWindow(
  range: Range,
  indexById: ReadonlyMap<string, number>,
  pins: (string | null | undefined)[],
  focus?: number,
) {
  return [
    ...new Set([
      ...defaultRangeExtractor(range),
      ...pins.flatMap((id) => {
        const index = id ? indexById.get(id) : undefined;
        return index === undefined ? [] : [index];
      }),
      ...(focus !== undefined && focus >= 0 && focus < range.count ? [focus] : []),
    ]),
  ].toSorted((a, b) => a - b);
}
