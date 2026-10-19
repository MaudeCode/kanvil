import {
  AtSign,
  CircleDot,
  Clock,
  MessageSquare,
  Pencil,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { NotificationCategory } from "@kanvil/contracts";
// One icon per category, shared by notification settings and the Inbox; labels live in contracts.
export const notificationCategoryIcons: Record<NotificationCategory, LucideIcon> = {
  assignment: UserRound,
  status: CircleDot,
  comment: MessageSquare,
  mention: AtSign,
  update: Pencil,
  due_soon: Clock,
  overdue: TriangleAlert,
};
