import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";

// TagInput owns editing; this extends the list's shared label/scope renderer for dense reading.
export function TicketTags({
  tags,
  label,
  variant,
}: {
  tags: string[];
  label: string;
  variant: "secondary" | "outline";
}) {
  if (!tags.length) return null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            className="ticket-tags-trigger h-auto max-w-full min-w-0 justify-start gap-1 p-0 hover:bg-transparent"
            aria-label={`${label}: ${tags.join(", ")}`}
          />
        }
      >
        {tags.map((tag, index) => (
          <Badge
            key={tag}
            variant={variant}
            className="ticket-tag min-w-0 max-w-28 shrink data-[preview-extra]:hidden"
            data-secondary={index === 1 || undefined}
            data-preview-extra={index > 1 || undefined}
          >
            <span className="truncate">{tag}</span>
          </Badge>
        ))}
        {tags.length > 1 && (
          <Badge
            variant="outline"
            className="ticket-tags-overflow shrink-0 data-[wide-overflow=false]:hidden"
            data-wide-overflow={tags.length > 2}
          >
            <span className="ticket-tags-count-wide">+{tags.length - 2}</span>
            <span className="ticket-tags-count-narrow">+{tags.length - 1}</span>
          </Badge>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-3">
        <PopoverTitle>{label}</PopoverTitle>
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <Badge
              key={tag}
              variant={variant}
              className="h-auto max-w-full whitespace-normal break-words"
            >
              {tag}
            </Badge>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
