import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { NavigationContainerRefWithCurrent } from "@react-navigation/native";
import { createContext, useContext } from "react";
import type { TicketLayout } from "@kanvil/contracts/navigation";
export type Routes = {
  Home: undefined;
  Tickets: {
    projectId: string;
    name?: string;
    layout?: TicketLayout;
    collection?: "all" | "planning";
    viewId?: string;
  };
  Ticket: { projectId: string; ticketId: string };
  Edit: { projectId: string; ticketId?: string };
  WorkspaceSettings: { workspaceId: string; section?: string };
  ProjectSettings: { projectId: string; section?: string };
  AccountSettings: { section: string };
  Administration: { section?: string };
  CreateWorkspace: undefined;
  Import: { workspaceId: string };
};
export type ScreenProps<K extends keyof Routes> = NativeStackScreenProps<Routes, K>;
// Native sheets own an independent navigator. Their ticket actions still target the main app.
export const MainNavigation = createContext<NavigationContainerRefWithCurrent<Routes> | null>(null);
export function useAppNavigation() {
  const navigation = useContext(MainNavigation);
  if (!navigation) throw new Error("The main navigation is unavailable");
  return navigation;
}

declare global {
  namespace ReactNavigation {
    interface RootParamList extends Routes {}
  }
}
