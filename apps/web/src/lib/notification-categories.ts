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
import { notificationCategorySymbols } from "@kanvil/contracts/icons";
const glyphs = {
  "user-round": UserRound,
  "circle-dot": CircleDot,
  "message-square": MessageSquare,
  "at-sign": AtSign,
  pencil: Pencil,
  clock: Clock,
  "triangle-alert": TriangleAlert,
};
export const notificationCategoryIcons: Record<NotificationCategory, LucideIcon> = {
  assignment: glyphs[notificationCategorySymbols.assignment],
  status: glyphs[notificationCategorySymbols.status],
  comment: glyphs[notificationCategorySymbols.comment],
  mention: glyphs[notificationCategorySymbols.mention],
  update: glyphs[notificationCategorySymbols.update],
  due_soon: glyphs[notificationCategorySymbols.due_soon],
  overdue: glyphs[notificationCategorySymbols.overdue],
};
