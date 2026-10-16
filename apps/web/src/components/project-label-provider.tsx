import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Output } from "@kanvil/contracts";
import { api } from "../data.tsx";

const ProjectLabels = createContext<Output<"list_project_labels">>([]);
export const useProjectLabels = () => useContext(ProjectLabels);
export function ProjectLabelProvider({
  projectId,
  children,
}: {
  projectId: string | undefined;
  children: ReactNode;
}) {
  const labels = useQuery({
    ...api.query("list_project_labels", { projectId: projectId ?? "" }),
    enabled: !!projectId,
  });
  return <ProjectLabels value={labels.data ?? []}>{children}</ProjectLabels>;
}
