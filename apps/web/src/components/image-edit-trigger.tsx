import { type ReactNode } from "react";
import { Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ImageEditTrigger({
  label,
  disabled = false,
  round = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  round?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      aria-label={label}
      title={label}
      variant="ghost"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group/image relative h-auto border-0 p-0 hover:bg-transparent disabled:cursor-default disabled:opacity-100",
        round ? "rounded-full" : "rounded-xl",
      )}
    >
      {children}
      {!disabled && (
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center rounded-[inherit] bg-background/80 text-foreground opacity-0 transition-opacity group-hover/image:opacity-100 group-focus-visible/image:opacity-100"
        >
          <Camera className="size-5" />
        </span>
      )}
    </Button>
  );
}
