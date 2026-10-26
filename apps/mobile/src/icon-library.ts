import { useQuery } from "@tanstack/react-query";
import { loadProjectIcons } from "@kanvil/contracts/icons";

// The installed Lucide library serves project icons and ticket properties in both apps.
export const useIconLibrary = (enabled = true) =>
  useQuery({
    queryKey: ["project-icon-library"],
    queryFn: loadProjectIcons,
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
  });
