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
    <Avatar
      aria-hidden="true"
      className={cn("size-8 overflow-hidden rounded-full text-xs", className)}
    >
      {image && <AvatarImage src={image} alt="" />}
      <AvatarFallback className="rounded-full bg-primary/10 font-medium text-primary text-[length:inherit]">
        {name
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .map((word) => word.slice(0, 1))
          .join("")
          .toUpperCase() || "?"}
      </AvatarFallback>
    </Avatar>
  );
}

export function UserIdentity({
  name,
  email,
  image,
}: {
  name: string;
  email: string;
  image?: string | null | undefined;
}) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <UserAvatar name={name} image={image} />
      <span className="min-w-0">
        <span dir="auto" className="block wrap-anywhere whitespace-normal font-medium">
          {name}
        </span>
        <span className="block break-all whitespace-normal text-xs text-muted-foreground">
          {email}
        </span>
      </span>
    </span>
  );
}
