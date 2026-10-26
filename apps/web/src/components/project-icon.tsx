import { loadProjectIcons } from "@kanvil/contracts/icons";
import { accentColorClasses } from "../lib/accent-colors.ts";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react/offline";
import { FolderOpen } from "lucide-react";
import type { Project } from "@kanvil/contracts";
import { cn } from "@/lib/utils";
export function useIconLibrary(enabled = true) {
  return useQuery({
    queryKey: ["project-icon-library"],
    queryFn: loadProjectIcons,
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
        accentColorClasses[project.iconColor],
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
