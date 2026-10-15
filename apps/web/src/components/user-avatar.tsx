import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
export function UserAvatar({
  name,
  image,
  className,
}: {
  name: string;
  image?: string | null | undefined;
  className?: string;
}) {
  return (
    <Avatar className={cn("size-8 rounded-lg", className)}>
      {image && <AvatarImage src={image} alt="" />}
      <AvatarFallback className="rounded-lg bg-primary/10 font-medium text-primary">
        {name
          .split(/\s+/)
          .slice(0, 2)
          .map((word) => word.slice(0, 1))
          .join("")
          .toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
