import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react/offline";
import { FolderOpen } from "lucide-react";
import type { Project } from "@kanvil/contracts";
import { cn } from "@/lib/utils";
export const projectIconTones = {
  default: "text-primary",
  red: "text-red-500",
  orange: "text-orange-500",
  yellow: "text-yellow-600 dark:text-yellow-400",
  green: "text-green-600 dark:text-green-400",
  teal: "text-teal-600 dark:text-teal-400",
  blue: "text-blue-500",
  purple: "text-purple-500",
  pink: "text-pink-500",
  gray: "text-muted-foreground",
};
export function useIconLibrary(enabled = true) {
  return useQuery({
    queryKey: ["project-icon-library"],
    queryFn: async () => (await import("@iconify-json/lucide")).icons,
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
export function ProjectIcon({
  project,
  className,
}: {
  project: Pick<Project, "iconName" | "iconColor" | "image">;
  className?: string;
}) {
  const library = useIconLibrary(!!project.iconName && !project.image),
    icon = project.iconName ? library.data?.icons[project.iconName] : undefined;
  return (
    <span
      data-slot="project-icon"
      aria-hidden="true"
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg",
        projectIconTones[project.iconColor],
        className,
      )}
    >
      {project.image ? (
        <img src={project.image} alt="" className="size-full object-contain" />
      ) : icon ? (
        <Icon
          icon={{ ...icon, width: library.data?.width ?? 24, height: library.data?.height ?? 24 }}
          className="size-full"
        />
      ) : (
        <FolderOpen className="size-full" />
      )}
    </span>
  );
}
