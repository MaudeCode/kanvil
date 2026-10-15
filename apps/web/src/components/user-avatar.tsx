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
    <Avatar className={cn("size-8 overflow-hidden rounded-full text-xs", className)}>
      {image && <AvatarImage src={image} alt="" />}
      <AvatarFallback className="rounded-full bg-primary/10 font-medium text-primary text-[length:inherit]">
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
