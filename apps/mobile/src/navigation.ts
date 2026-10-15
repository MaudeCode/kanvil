import type { NativeStackScreenProps } from "@react-navigation/native-stack";
export type Routes = {
  Home: undefined;
  Tickets: { projectId: string; name?: string };
  Ticket: { projectId: string; ticketId: string };
  Edit: { projectId: string; ticketId?: string };
};
export type ScreenProps<K extends keyof Routes> = NativeStackScreenProps<Routes, K>;

declare global {
  namespace ReactNavigation {
    interface RootParamList extends Routes {}
  }
}
