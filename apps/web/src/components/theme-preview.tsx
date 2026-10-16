import { useId } from "react";
import type { ThemeDefinition, ThemePalette } from "../lib/themes.ts";
import { cn } from "@/lib/utils";
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
  variant = "wireframe",
  className,
}: {
  theme: ThemeDefinition;
  mode?: "light" | "dark" | "system";
  variant?: "wireframe" | "orb";
  className?: string;
}) {
  const id = useId();
  if (variant === "orb" && mode !== "system") {
    const palette = theme[mode],
      light = mode === "light";
    // Adapted from T3 Code's MIT-licensed theme preview orbs; see third-party-themes.txt.
    return (
      <span
        aria-hidden="true"
        className={cn(
          "relative block size-14 shrink-0 overflow-hidden rounded-full border-2 border-background",
          className,
        )}
        style={{
          boxShadow: light
            ? "inset 0 0 0 1px rgb(0 0 0 / .1), 0 1px 2px rgb(0 0 0 / .08)"
            : "inset 0 0 0 1px rgb(255 255 255 / .14), 0 1px 2px rgb(0 0 0 / .18)",
        }}
      >
        <span
          className="absolute inset-0 rounded-full"
          style={{
            backgroundColor: `color-mix(in oklab, ${palette.background} 80%, ${light ? "#ffffff" : "#09090b"})`,
            backgroundImage: `radial-gradient(circle at ${light ? "72% 22%" : "28% 78%"} in oklab, ${palette.primary} 0%, color-mix(in oklab, ${palette.primary} ${light ? "72%" : "62%"}, transparent) 28%, transparent 58%), radial-gradient(circle at ${light ? "18% 82%" : "82% 18%"} in oklab, color-mix(in oklab, ${palette.primary} 45%, transparent) 0%, transparent 55%)`,
            filter: "blur(3px)",
            transform: "scale(1.1)",
          }}
        />
      </span>
    );
  }
  return (
    <svg
      viewBox="0 0 160 96"
      preserveAspectRatio="none"
      className={cn("w-full rounded-md", className)}
      aria-hidden="true"
    >
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
