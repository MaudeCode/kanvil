import { projectIconColors, type Project } from "@kanvil/contracts";
import { Button } from "@/components/ui/button";
import { accentColorClasses } from "../lib/accent-colors.ts";

// Shared swatches from the project icon picker, also used by project labels.
export function AccentColorPicker({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: Project["iconColor"];
  onChange: (value: Project["iconColor"]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label={label}>
      {projectIconColors.map((tone) => (
        <Button
          key={tone}
          disabled={disabled}
          variant={value === tone ? "secondary" : "ghost"}
          size="icon"
          aria-label={`${tone} ${label.toLowerCase()}`}
          aria-pressed={value === tone}
          className={accentColorClasses[tone]}
          onClick={() => onChange(tone)}
        >
          <span className="size-3 rounded-full bg-current" />
        </Button>
      ))}
    </div>
  );
}
