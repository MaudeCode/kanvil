import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { isHexColor, projectIconColors, type LabelColor } from "@kanvil/contracts";
import { api, useOperation } from "../data.tsx";
import { reportError } from "../ui.tsx";
import { Button } from "@/components/ui/button";
import { accentColor } from "../lib/accent-colors.ts";
import { cn } from "@/lib/utils";

function Swatch({
  value,
  label,
  selected,
  disabled,
  onSelect,
}: {
  value: LabelColor;
  label: string;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const tone = accentColor(value);
  return (
    <Button
      disabled={disabled}
      variant={selected ? "secondary" : "ghost"}
      size="icon"
      aria-label={`${value} ${label.toLowerCase()}`}
      aria-pressed={selected}
      className={tone.className}
      style={tone.style}
      onClick={onSelect}
    >
      <span className="size-3 rounded-full bg-current" />
    </Button>
  );
}

// Shared swatches for project icons and labels. With `custom`, the picker also offers the
// site-wide custom colors (removable) and a native color input that adds a new one.
export function AccentColorPicker<T extends LabelColor>({
  label,
  value,
  onChange,
  disabled = false,
  custom = false,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  custom?: boolean;
}) {
  // Site-wide and rarely changed: refetch each time a picker opens so removals elsewhere show.
  const palette = useQuery({
    ...api.query("list_label_colors", {}),
    enabled: custom,
    staleTime: 0,
  });
  const remove = useOperation("remove_label_color");
  const saved = palette.data?.map((entry) => entry.value) ?? [];
  // The chosen hex shows as a swatch even before a save adds it to the site palette.
  const shown = isHexColor(value) && !saved.includes(value) ? [value, ...saved] : saved;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `custom` is only enabled by callers whose T includes hex colors.
  const pick = (next: LabelColor) => onChange(next as T);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      {projectIconColors.map((tone) => (
        <Swatch
          key={tone}
          value={tone}
          label={label}
          selected={value === tone}
          disabled={disabled}
          onSelect={() => pick(tone)}
        />
      ))}
      {custom && (
        <>
          {shown.length > 0 && <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />}
          {shown.map((hex) => (
            <span key={hex} className="group/swatch relative">
              <Swatch
                value={hex}
                label={label}
                selected={value === hex}
                disabled={disabled}
                onSelect={() => pick(hex)}
              />
              {saved.includes(hex) && (
                <Button
                  variant="secondary"
                  size="icon-xs"
                  aria-label={`Remove ${hex} from custom colors`}
                  disabled={disabled || remove.isPending}
                  className="absolute -top-1 -right-1 size-4 rounded-full border opacity-0 shadow-sm transition-opacity group-hover/swatch:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
                  onClick={() => {
                    void remove.mutateAsync({ value: hex }).catch(reportError);
                  }}
                >
                  <X className="size-2.5" />
                </Button>
              )}
            </span>
          ))}
          <label
            className={cn(
              "relative inline-flex size-8 cursor-pointer items-center justify-center rounded-md border border-dashed text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground focus-within:ring-2 focus-within:ring-ring",
              disabled && "pointer-events-none opacity-50",
            )}
            title="Custom color"
          >
            <Plus className="size-4" aria-hidden="true" />
            <input
              type="color"
              aria-label="Custom color"
              disabled={disabled}
              value={isHexColor(value) ? value : "#6366f1"}
              onChange={(event) => pick(event.target.value.toLowerCase())}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
          </label>
        </>
      )}
    </div>
  );
}
