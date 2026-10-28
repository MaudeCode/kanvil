import type { ChangeEvent } from "@kanvil/contracts";
import type { Query } from "@tanstack/react-query";

// Project-wide reads that only change on these event families; ticket traffic leaves them alone.
const settledBy: Record<string, string[]> = {
  // A role edit rewrites the stand-in role of everyone holding it.
  list_members: ["membership.", "role.", "project."],
  list_workspace_members: ["membership.", "role.", "project."],
  list_workspace_roles: ["role.", "membership.", "project."],
  list_project_roles: ["role.", "membership.", "project."],
  // An acceptance announces the new membership rather than an invitation change.
  list_invitations: ["invitation.", "membership."],
  list_project_labels: ["label.", "project."],
  // Its ticket counts move with ticket traffic.
  list_workflow_states: ["workflow.", "project.", "ticket."],
  list_workspace_labels: ["label.", "project."],
  // Its usage counts move with ticket traffic.
  list_custom_fields: ["custom_field.", "project.", "ticket."],
  list_calendar_feeds: ["calendar_feed.", "label.", "membership.", "project."],
  list_label_colors: ["label."],
  list_views: ["label.", "custom_field.", "project."],
  get_project: ["project.", "label."],
  list_project_destinations: ["destination.", "project."],
  // Personal; writes invalidate it and pending sends poll it.
  list_notification_channels: [],
  // Personal; running imports poll them instead of refreshing on each record they write.
  list_imports: [],
  get_import: [],
  // An account deletion announces itself as a membership change in every project it reached.
  list_deleted_accounts: ["membership."],
};
// Decides which cached queries a realtime event can have changed.
export function affectedBy(event: ChangeEvent) {
  return (query: Query) => {
    const [namespace, , name, input] = query.queryKey;
    if (namespace !== "kanvil") return false;
    if (typeof name !== "string" || !input || typeof input !== "object") return true;
    const families = settledBy[name];
    if (families && !families.some((family) => event.type.startsWith(family))) return false;
    const projectId = Reflect.get(input, "projectId"),
      ticketId = Reflect.get(input, "ticketId");
    if (typeof projectId !== "string") return true;
    if (projectId !== event.projectId) return false;
    if (!event.ticketId || typeof ticketId !== "string") return true;
    return ticketId === event.ticketId || ticketId === event.data.key;
  };
}

// Extends realtime invalidation with one active refresh and one accumulated follow-up.
export function createRefreshQueue(
  refresh: (events: ChangeEvent[] | undefined) => Promise<unknown>,
  signal: AbortSignal,
) {
  let pending: ChangeEvent[] = [];
  let full = false;
  let running: Promise<void> | undefined;
  const drain = (): Promise<void> => {
    if (running) return running;
    running = Promise.resolve()
      .then(async () => {
        while (!signal.aborted && (full || pending.length)) {
          const batch = full ? undefined : pending;
          pending = [];
          full = false;
          await refresh(batch);
        }
      })
      .finally(() => {
        running = undefined;
        if (!signal.aborted && (full || pending.length)) return drain();
        return undefined;
      });
    return running;
  };
  return {
    push: (event: ChangeEvent) => {
      if (signal.aborted) return;
      pending.push(event);
      void drain().catch(() => {});
    },
    flush: () => {
      if (signal.aborted) return Promise.resolve();
      full = true;
      return drain();
    },
  };
}
