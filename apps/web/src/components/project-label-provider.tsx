import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CatalogLabel } from "@kanvil/contracts";
import { api } from "../data.tsx";

type Label = Pick<CatalogLabel, "name" | "color">;
const ProjectLabels = createContext<Label[]>([]);
export const useProjectLabels = () => useContext(ProjectLabels);
// `labels` supplies a catalog the caller already has, such as a shared project's public one.
export function ProjectLabelProvider({
  projectId,
  labels: given,
  children,
}: {
  projectId: string | undefined;
  labels?: Label[];
  children: ReactNode;
}) {
  const labels = useQuery({
    ...api.query("list_project_labels", { projectId: projectId ?? "" }),
    enabled: !!projectId && !given,
  });
  return <ProjectLabels value={given ?? labels.data ?? []}>{children}</ProjectLabels>;
}
