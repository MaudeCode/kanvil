import { useId } from "react";
import type { ThemeDefinition, ThemePalette } from "../lib/themes.ts";
function Pane({ palette, clip }: { palette: ThemePalette; clip?: string }) {
  return (
    <g clipPath={clip}>
      <rect width="160" height="96" fill={palette.background} />
      <rect width="34" height="96" fill={palette.sidebar} />
      <rect x="7" y="10" width="19" height="4" rx="2" fill={palette.primary} />
      {[0, 1, 2].map((row) => (
        <rect
          key={row}
          x="7"
          y={27 + row * 12}
          width={row === 2 ? 12 : 21}
          height="3"
          rx="1.5"
          fill={palette.foreground}
          opacity=".25"
        />
      ))}
      <rect x="45" y="12" width="65" height="5" rx="2" fill={palette.foreground} opacity=".8" />
      <rect x="127" y="10" width="23" height="8" rx="3" fill={palette.primary} />
      {[0, 1, 2].map((row) => (
        <g key={row}>
          <rect
            x="45"
            y={34 + row * 18}
            width="57"
            height="3"
            rx="1.5"
            fill={palette.foreground}
            opacity=".3"
          />
          <circle
            cx="130"
            cy={35 + row * 18}
            r="3"
            fill={palette.primary}
            opacity={row === 1 ? 1 : 0.35}
          />
          <rect
            x="45"
            y={43 + row * 18}
            width="105"
            height=".6"
            fill={palette.foreground}
            opacity=".12"
          />
        </g>
      ))}
    </g>
  );
}
export function ThemePreview({
  theme,
  mode = "system",
}: {
  theme: ThemeDefinition;
  mode?: "light" | "dark" | "system";
}) {
  const id = useId();
  return (
    <svg viewBox="0 0 160 96" className="w-full rounded-md" aria-hidden="true">
      <defs>
        <clipPath id={`${id}-light`}>
          <rect width="80" height="96" />
        </clipPath>
        <clipPath id={`${id}-dark`}>
          <rect x="80" width="80" height="96" />
        </clipPath>
      </defs>
      {mode === "system" ? (
        <>
          <Pane palette={theme.light} clip={`url(#${id}-light)`} />
          <Pane palette={theme.dark} clip={`url(#${id}-dark)`} />
        </>
      ) : (
        <Pane palette={theme[mode]} />
      )}
    </svg>
  );
}
