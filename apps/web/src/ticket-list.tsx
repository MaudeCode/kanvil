import { toast } from "sonner";
import { TicketContextMenu } from "./components/object-context-menu.tsx";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Plus,
  ChevronDown,
  BookmarkPlus,
  Trash2,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  NotebookTabs,
} from "lucide-react";
import { format, isValid, parseISO, startOfToday } from "date-fns";
import {
  useTable,
  tableFeatures,
  columnSizingFeature,
  columnResizingFeature,
  rowSelectionFeature,
  columnVisibilityFeature,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  capabilitiesOf,
  ticketFilter,
  closedStates,
  defaultOrder,
  dueFilterLabels,
  states,
  stateLabels,
  type CustomField,
  type Ticket,
  type Project,
  type Output,
} from "@kanvil/contracts";
import { formatList, t } from "@kanvil/contracts/i18n";
import { api, useIdentity, useProjectAccess, useProjects, useOperation } from "./data.tsx";
import { ProjectIcon } from "./components/project-icon.tsx";
import {
  Button,
  DueDate,
  EmptyState,
  Check,
  Confirm,
  ErrorNotice,
  Input,
  Loading,
  Modal,
  RelativeTime,
  TicketIndicator,
  FormActions,
  IconButton,
  reportError,
} from "./ui.tsx";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { TicketTags } from "./components/ticket-tags.tsx";
import { TicketListControls } from "./components/ticket-list-controls.tsx";
import { TicketSelectionToolbar } from "./components/ticket-selection-toolbar.tsx";
import {
  CustomFieldProperty,
  FieldValue,
  PropertyValue,
  TicketProperty,
  pair,
  parseStatus,
  propertyChange,
  stateValue,
  statusValue,
  useCustomFields,
  useTicketChange,
  useWorkflow,
  type PropertyName,
  type PropertyValues,
  type StatusValue,
} from "./components/ticket-property.tsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";
import { TicketSchedule, scheduleWindow } from "./components/ticket-schedule.tsx";
import { TicketEditor } from "./ticket-editor.tsx";
import { usePreviewCollection, useTicketPreview } from "./components/ticket-preview.tsx";
import { neighborFor, placeNear, writeListOrder } from "./lib/list-order.ts";
import { moveCommandNames, type MoveCommand } from "./lib/actions.ts";
import { useShortcut } from "./hooks/use-shortcut.ts";
import { useReorderDrag } from "./hooks/use-reorder-drag.ts";
import { cn } from "@/lib/utils";
import { ArchivedNotice } from "./components/project-lifecycle.tsx";

import {
  searchSchema,
  filterIdentity,
  matchesFilter,
  ticketColumnLabels,
  customFieldColumn,
  type TicketGrouping,
  type TicketSearch,
} from "./search.ts";
import {
  preferences,
  resetPreferences,
  ticketDisplayPreferences,
  usePreference,
  weekStarts,
} from "./hooks/use-preference.ts";
const features = tableFeatures({
  columnSizingFeature,
  columnResizingFeature,
  rowSelectionFeature,
  columnVisibilityFeature,
});
const pageSize = 100;
// A collapsible group of rows: a status, a project, or a due-date window.
interface Section {
  id: string;
  label: string;
  heading: ReactNode;
  total: number;
  has: (ticket: Ticket) => boolean;
}
function TicketSectionHeader({
  section,
  collapsed,
  onToggle,
  selection,
}: {
  section: Section;
  collapsed: boolean;
  onToggle: () => void;
  // Selects every row of the section; lines up with the rows' selection column.
  selection?: Omit<ComponentProps<typeof Check>, "label"> | undefined;
}) {
  return (
    <div className="flex items-center">
      {selection && (
        <div className="flex w-11 shrink-0 justify-center pl-3 @max-[850px]:w-8 @max-[850px]:justify-start @max-[850px]:pl-0">
          <Check
            label={t("ticket.list.selectSection", { section: section.label })}
            className="sr-checkbox"
            {...selection}
          />
        </div>
      )}
      <Button
        variant="ghost"
        className="flex-1 justify-start gap-2 rounded-none px-3"
        aria-label={
          collapsed
            ? t("ticket.list.expandSection", { section: section.label })
            : t("ticket.list.collapseSection", { section: section.label })
        }
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <ChevronDown
          className={cn("size-3 transition-transform duration-200", collapsed && "-rotate-90")}
        />
        {section.heading}
        <span className="text-xs tabular-nums text-muted-foreground">{section.total}</span>
      </Button>
    </div>
  );
}
// Due-date windows for My work, measured from now like the server's due filters.
const dueWindows = [
  ["overdue", 0],
  ["today", 86_400_000],
  ["week", 7 * 86_400_000],
  ["later", Infinity],
] as const;
const dueWindowLabel = (id: (typeof dueWindows)[number][0] | "none") =>
  id === "later" ? t("ticket.list.later") : dueFilterLabels[id];
function dueWindow(ticket: Ticket, now: number) {
  if (!ticket.dueAt) return "none";
  const left = new Date(ticket.dueAt).getTime() - now;
  return dueWindows.find(([, within]) => left < within)?.[0] ?? "later";
}
// Inline property editing on a row; readers see the plain value.
function PropertyCell<P extends PropertyName>({
  ticket,
  property,
  value,
  iconOnly = false,
}: {
  ticket: Ticket;
  property: P;
  value: PropertyValues[P];
  iconOnly?: boolean;
}) {
  const access = useProjectAccess(ticket.projectId),
    { change, pending } = useTicketChange(ticket);
  if (!access.canWrite)
    return (
      <PropertyValue {...pair(property, value)} projectId={ticket.projectId} iconOnly={iconOnly} />
    );
  return (
    <TicketProperty
      variant="cell"
      property={property}
      value={value}
      projectId={ticket.projectId}
      iconOnly={iconOnly}
      disabled={pending}
      onChange={(next) => void change({ [property]: next })}
    />
  );
}
// Built at render, so headers and accessible names follow the interface language.
const ticketColumns = (): ColumnDef<typeof features, Ticket>[] => [
  {
    id: "select",
    size: 44,
    enableResizing: false,
    enableHiding: false,
    header: ({ table }) => (
      <Check
        label={t("ticket.list.selectAll")}
        className="sr-checkbox"
        checked={table.getIsAllRowsSelected()}
        indeterminate={table.getIsSomeRowsSelected() && !table.getIsAllRowsSelected()}
        onCheckedChange={(checked) => table.toggleAllRowsSelected(checked)}
      />
    ),
    cell: ({ row }) => (
      <Check
        label={t("ticket.list.selectTicket", { key: row.original.key })}
        className="sr-checkbox"
        checked={row.getIsSelected()}
        onCheckedChange={(checked) => row.toggleSelected(checked)}
      />
    ),
  },
  { accessorKey: "key", header: ticketColumnLabels.key, size: 100, minSize: 90 },
  {
    accessorKey: "title",
    header: t("ticket.list.title"),
    size: 400,
    enableHiding: false,
    minSize: 200,
    cell: ({ row }) => (
      <Link
        dir="auto"
        className="ticket-title block text-[13px] leading-5 font-normal whitespace-normal wrap-anywhere text-foreground hover:text-primary"
        to="/projects/$projectId/tickets/$ticketId"
        params={{ projectId: row.original.projectId, ticketId: row.original.id }}
      >
        {row.original.title}
      </Link>
    ),
  },
  ...(["labels", "scopes"] as const).map(
    (key) =>
      ({
        accessorKey: key,
        header: ticketColumnLabels[key],
        size: 140,
        minSize: 120,
        cell: ({ row }) => (
          <TicketTags
            tags={row.original[key]}
            label={key === "labels" ? t("ticket.tags.labels") : t("ticket.tags.scopes")}
            variant={key === "labels" ? "secondary" : "outline"}
          />
        ),
      }) satisfies ColumnDef<typeof features, Ticket>,
  ),
  {
    accessorKey: "status",
    header: ticketColumnLabels.status,
    size: 115,
    minSize: 105,
    cell: ({ row }) => (
      <PropertyCell ticket={row.original} property="status" value={statusValue(row.original)} />
    ),
  },
  {
    accessorKey: "priority",
    header: ticketColumnLabels.priority,
    // Room for the heading and its sort arrow; longer names in other languages truncate.
    size: 96,
    minSize: 64,
    cell: ({ row }) => (
      <PropertyCell
        ticket={row.original}
        property="priority"
        value={row.original.priority}
        iconOnly
      />
    ),
  },
  {
    accessorKey: "difficulty",
    header: ticketColumnLabels.difficulty,
    size: 106,
    minSize: 85,
    cell: ({ row }) => (
      <PropertyCell ticket={row.original} property="difficulty" value={row.original.difficulty} />
    ),
  },
  {
    accessorKey: "kind",
    header: ticketColumnLabels.kind,
    size: 110,
    cell: ({ row }) => (
      <PropertyCell ticket={row.original} property="kind" value={row.original.kind} />
    ),
  },
  {
    accessorKey: "assigneeId",
    header: ticketColumnLabels.assigneeId,
    size: 160,
    cell: ({ row }) => (
      <PropertyCell ticket={row.original} property="assignee" value={row.original.assigneeId} />
    ),
  },
  {
    accessorKey: "startAt",
    header: ticketColumnLabels.startAt,
    size: 100,
    minSize: 90,
    cell: ({ row }) => <DueDate value={row.original.startAt} open={false} />,
  },
  {
    accessorKey: "dueAt",
    header: ticketColumnLabels.dueAt,
    size: 100,
    minSize: 90,
    cell: ({ row }) => (
      <DueDate
        value={row.original.dueAt}
        open={!closedStates.some((closed) => closed === row.original.status)}
      />
    ),
  },
];
const timeColumns = () =>
  (["createdAt", "updatedAt"] as const).map(
    (key) =>
      ({
        accessorKey: key,
        header: ticketColumnLabels[key],
        size: 130,
        cell: ({ row }) => (
          <RelativeTime value={row.original[key]} className="text-muted-foreground" />
        ),
      }) satisfies ColumnDef<typeof features, Ticket>,
  );
// A project's custom field as a column; writers edit it inline like the built-in properties.
function CustomFieldCell({ ticket, field }: { ticket: Ticket; field: CustomField }) {
  const access = useProjectAccess(ticket.projectId),
    { change, pending } = useTicketChange(ticket),
    value = ticket.customFields[field.id];
  if (!access.canWrite)
    return value === undefined ? null : <FieldValue field={field} value={value} />;
  return (
    <CustomFieldProperty
      variant="cell"
      field={field}
      value={value}
      disabled={pending}
      onChange={(next) => void change({ customFields: { [field.id]: next } })}
    />
  );
}
const fieldColumn = (field: CustomField): ColumnDef<typeof features, Ticket> => ({
  id: customFieldColumn(field.id),
  header: () => (
    <span className="block truncate px-3 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
      {field.name}
    </span>
  ),
  size: 140,
  minSize: 90,
  cell: ({ row }) => <CustomFieldCell ticket={row.original} field={field} />,
});
// Columns whose header sorts the list; the sort key is the server's, not the column's.
const sortBy: Partial<Record<string, TicketSearch["sort"]>> = {
  key: "number",
  title: "title",
  labels: "labels",
  status: "status",
  priority: "priority",
  difficulty: "difficulty",
  kind: "kind",
  assigneeId: "assignee",
  startAt: "start",
  dueAt: "due",
  createdAt: "created",
  updatedAt: "updated",
};
// Where a move puts a ticket: next to a neighbor as displayed, into a status or state, or both.
interface Placement {
  anchor?: string;
  below?: boolean;
  status?: StatusValue;
}
// A bare category leaves a ticket already in that category where it is, like a status-only write.
const sameStatus = (ticket: Ticket, value: StatusValue) =>
  value === (value.includes(":") ? statusValue(ticket) : ticket.status);
// One server query series: a status section, a planning group, or the whole list. `status`,
// `stateId`, and `archived` override the page's filters for that series.
interface Fetch extends Omit<Section, "total"> {
  status?: Ticket["status"];
  stateId?: string;
  archived?: TicketSearch["archived"];
}
const allTickets = (): Fetch => ({
  id: "all",
  label: t("ticket.list.all"),
  heading: null,
  has: () => true,
});
// Planning splits a project into work not yet scheduled and work put away.
const planningGroups = (): Fetch[] => [
  {
    id: "planned",
    label: t("ticket.list.planned"),
    heading: <span className="text-xs">{t("ticket.list.planned")}</span>,
    status: "backlog",
    archived: "exclude",
    has: (ticket) => !ticket.archived && ticket.status === "backlog",
  },
  {
    id: "archived",
    label: t("ticket.list.archived"),
    heading: <span className="text-xs">{t("ticket.list.archived")}</span>,
    archived: "only",
    has: (ticket) => ticket.archived,
  },
];
const interactive = "a, button, input, label, [role=checkbox], [role=combobox], [role=menu]";
// A ticket record in the table or on the board: realtime arrival, selection, and highlight.
const rowClass =
  "ticket-row cursor-pointer data-[fresh=true]:animate-row-in data-[selected=true]:bg-primary/5 data-[active=true]:bg-muted/60";
// Comfortable spacing also scales the text, badges, and icons so rows fill the extra room.
const densityClass =
  "data-[density=comfortable]:[&_[data-priority]_svg]:size-5! data-[density=comfortable]:[&_[data-slot=badge]]:h-6 data-[density=comfortable]:[&_[data-slot=badge]]:px-2 data-[density=comfortable]:[&_[data-slot=badge]]:text-xs data-[density=comfortable]:[&_.status]:text-sm data-[density=comfortable]:[&_[data-slot=checkbox]]:size-5 data-[density=comfortable]:[&_.ticket-title]:text-[15px] data-[density=comfortable]:[&_.ticket-title]:leading-6";
const tableClass = "min-w-full table-fixed @min-[1051px]:w-(--table-width)";
// Every section table shares the header table's column widths.
function ColumnGroup({ leaves }: { leaves: { id: string; getSize: () => number }[] }) {
  return (
    <colgroup>
      {leaves.map((column) => (
        <col key={column.id} data-column={column.id} style={{ width: column.getSize() }} />
      ))}
    </colgroup>
  );
}
// A project's tickets, its planning view, or My work: the open tickets assigned to you across one
// workspace.
export type TicketListScope = { project: Project; planning?: boolean } | { workspaceId: string };
export function TicketList({
  scope,
  search: route,
  onSearch,
}: {
  scope: TicketListScope;
  search: TicketSearch;
  // Filter changes replace the current history entry.
  onSearch: (next: TicketSearch) => void;
}) {
  // The previewed ticket and the calendar or timeline period ride in the URL beside the filters;
  // neither is part of a saved view.
  const { peek, peekProject: _peekProject, period, ...search } = route;
  const project = "project" in scope ? scope.project : undefined;
  const projectAccess = useProjectAccess(project?.id ?? "", !!project);
  // My work spans projects: rows edit inline through their own project's access, and
  // selection, bulk edits, saved views, and creation stay with a single project.
  const canWrite = !!project && projectAccess.canWrite;
  const projects = useProjects();
  const identity = useIdentity();
  const navigate = useNavigate();
  const [projectGrouping] = usePreference(preferences.grouping),
    [workGrouping] = usePreference(preferences.workGrouping),
    [layout] = usePreference(preferences.layout),
    [backgrounds] = usePreference(preferences.backgrounds);
  const planning = "project" in scope && !!scope.planning;
  // The board shows a project's active work in status lanes; planning and My work stay lists.
  const board = !!project && !planning && layout === "board";
  // A project's active work can show as a calendar or timeline of one ungrouped, date-bounded fetch.
  const schedule =
    !!project && !planning && (layout === "calendar" || layout === "timeline") ? layout : undefined;
  const [weekStart] = usePreference(preferences.weekStart);
  // A day that does not exist, such as 2026-02-31, falls back to today.
  const periodDay = period ? parseISO(period) : undefined,
    anchor = periodDay && isValid(periodDay) ? periodDay : startOfToday(),
    range = schedule ? scheduleWindow(schedule, anchor, weekStarts[weekStart]) : undefined;
  const grouping: TicketGrouping | "planning" = planning
    ? "planning"
    : board
      ? "status"
      : schedule
        ? "none"
        : project
          ? projectGrouping
          : workGrouping;
  const [labelDisplay] = usePreference(preferences.labelDisplay),
    [density] = usePreference(preferences.density),
    [visibility, setVisibility] = usePreference(preferences.columns);
  const filterKey = JSON.stringify({ ...search, offset: 0, grouping, range });
  const [paging, setPaging] = useState<{ filterKey: string; pages: Record<string, number> }>({
    filterKey,
    pages: {},
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // A move in flight shows at once: the ticket in its new status, next to its new neighbor.
  const [placing, setPlacing] = useState<Placement & { id: string }>();
  const pages = paging.filterKey === filterKey ? paging.pages : {};
  // A project's status sections and board lanes follow its workflow states; My work, which spans
  // projects, groups by category.
  // Status steps walk the same states, so a project list always reads its workflow.
  const workflowQuery = useWorkflow(project?.id ?? ""),
    workflow = workflowQuery.data ?? [],
    // Sections wait for the workflow rather than fetching by category first.
    workflowPending = !!project && grouping === "status" && workflowQuery.isPending;
  // Status sections and planning groups fetch one series of pages each; other lists fetch one
  // series and group it here.
  const fetches: Fetch[] =
    grouping === "planning"
      ? planningGroups().filter(
          (entry) => !entry.status || matchesFilter(search, "status", entry.status),
        )
      : workflowPending
        ? []
        : grouping === "status" && project && workflow.length
          ? workflow
              .filter((state) => matchesFilter(search, "status", state.category))
              .map((state) => ({
                id: state.id,
                label: state.name,
                heading: (
                  <PropertyValue
                    property="status"
                    value={stateValue(state)}
                    projectId={project.id}
                  />
                ),
                status: state.category,
                stateId: state.id,
                has: (ticket: Ticket) => ticket.stateId === state.id,
              }))
          : grouping === "status"
            ? states
                .filter((status) => matchesFilter(search, "status", status))
                .map((status) => ({
                  id: status,
                  label: stateLabels[status],
                  heading: <TicketIndicator property="status" value={status} />,
                  status,
                  has: (ticket: Ticket) => ticket.status === status,
                }))
            : [allTickets()];
  const pageQueries = fetches.flatMap((entry) =>
    Array.from({ length: pages[entry.id] ?? 1 }, (_, page) => ({
      entry,
      offset: page * pageSize,
    })),
  );
  const queries = useQueries({
    queries: pageQueries.map(({ entry, offset }) =>
      project
        ? api.query("list_tickets", {
            projectId: project.id,
            ...search,
            ...(entry.status ? { status: entry.status, statusNot: undefined } : {}),
            ...(entry.stateId ? { stateId: entry.stateId } : {}),
            ...(range
              ? {
                  scheduledFrom: range.from.toISOString(),
                  scheduledTo: range.to.toISOString(),
                  sort: "start" as const,
                  order: "asc" as const,
                }
              : {}),
            archived: entry.archived ?? search.archived,
            offset,
            limit: pageSize,
          })
        : api.query("list_my_work", {
            workspaceId: "workspaceId" in scope ? scope.workspaceId : undefined,
            q: search.q,
            sort: search.sort,
            order: search.order,
            offset,
            limit: pageSize,
          }),
    ),
  });
  const groups = fetches.map((entry) => ({
    entry,
    data: {
      items: pageQueries.flatMap((query, index) =>
        query.entry.id === entry.id ? (queries[index]?.data?.items ?? []) : [],
      ),
      total:
        queries[pageQueries.findIndex((query) => query.entry.id === entry.id)]?.data?.total ?? 0,
    },
  }));
  const requiredPages = Object.fromEntries(
    groups.map((group) => [group.entry.id, Math.max(1, Math.ceil(group.data.total / pageSize))]),
  );
  const missingPages = fetches.some(
    (entry) => (pages[entry.id] ?? 1) < (requiredPages[entry.id] ?? 1),
  );
  // Load the remaining pages of a section as soon as its total is known.
  if (missingPages) setPaging({ filterKey, pages: requiredPages });
  const latest = new Map<string, Ticket>();
  for (const group of groups)
    for (const ticket of group.data?.items ?? []) {
      const previous = latest.get(ticket.id);
      if (!previous || ticket.version > previous.version) latest.set(ticket.id, ticket);
    }
  const placed = placing && latest.get(placing.id);
  if (placing?.status && placed)
    latest.set(placed.id, { ...placed, ...propertyChange("status", placing.status) });
  // Rows that arrive through realtime after the first load get a short highlight.
  const loading = workflowPending || missingPages || queries.some((query) => query.isPending);
  const currentIds = [...latest.keys()].join("\n");
  const [seen, setSeen] = useState<{ filterKey: string; ids: string | null; fresh: Set<string> }>({
    filterKey,
    ids: null,
    fresh: new Set(),
  });
  if (seen.filterKey !== filterKey) setSeen({ filterKey, ids: null, fresh: new Set() });
  else if (seen.ids === null) {
    if (!loading) setSeen({ filterKey, ids: currentIds, fresh: new Set() });
  } else if (seen.ids !== currentIds) {
    const known = new Set(seen.ids.split("\n"));
    setSeen({
      filterKey,
      ids: currentIds,
      fresh: new Set([...latest.keys()].filter((id) => !known.has(id))),
    });
  }
  const all = placing?.anchor
    ? placeNear([...latest.values()], placing.id, placing.anchor, !!placing.below)
    : [...latest.values()];
  const total = groups.reduce((sum, group) => sum + (group.data?.total ?? 0), 0);
  // Due windows move with the clock, so a ticket passes into Overdue while the list stays open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (grouping === "due") setNow(Date.now());
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [grouping]);
  const sections: Section[] =
    grouping === "project"
      ? // Sections come from the tickets, so a project missing from the cached list never hides one.
        [...new Set(all.map((ticket) => ticket.projectId))]
          .map((id) => ({ id, owner: projects.data?.find((item) => item.id === id) }))
          .toSorted((a, b) => (a.owner?.name ?? "").localeCompare(b.owner?.name ?? ""))
          .map(({ id, owner }) => ({
            id,
            label: owner?.name ?? t("ticket.project.label"),
            heading: (
              <span className="flex min-w-0 items-center gap-2 text-xs">
                {owner && <ProjectIcon project={owner} className="size-4" />}
                <span dir={owner ? "auto" : undefined} className="truncate">
                  {owner?.name ?? t("ticket.project.label")}
                </span>
              </span>
            ),
            total: all.filter((ticket) => ticket.projectId === id).length,
            has: (ticket: Ticket) => ticket.projectId === id,
          }))
      : grouping === "due"
        ? [...dueWindows.map(([id]) => id), "none" as const].flatMap((id) => {
            const count = all.filter((ticket) => dueWindow(ticket, now) === id).length,
              label = dueWindowLabel(id);
            return count
              ? [
                  {
                    id,
                    label,
                    heading: <span className="text-xs">{label}</span>,
                    total: count,
                    has: (ticket: Ticket) => dueWindow(ticket, now) === id,
                  },
                ]
              : [];
          })
        : groups.flatMap(({ entry: { id, label, heading, has }, data }) =>
            data.total > 0 || board ? [{ id, label, heading, has, total: data.total }] : [],
          );
  const grouped = grouping !== "none";
  // Board lanes never collapse; the list keeps its collapsed sections for when it returns.
  const hidden = (id: string) => grouped && !board && collapsed.has(id);
  const tickets = {
    isPending: loading,
    error: queries.find((query) => query.error)?.error,
    data: {
      items: all.filter(
        (ticket) => !sections.some((section) => hidden(section.id) && section.has(ticket)),
      ),
      total,
    },
  };
  const views = useQuery({
    ...api.query("list_views", { projectId: project?.id ?? "" }),
    enabled: !!project,
  });
  const saveView = useOperation("save_view"),
    deleteView = useOperation("delete_view");
  const [creating, setCreating] = useState(false);
  const [viewName, setViewName] = useState(""),
    [savingView, setSavingView] = useState(false);
  const [deletingView, setDeletingView] = useState<Output<"list_views">[number] | null>(null);
  const currentFilters = filterIdentity(search),
    isDefault = currentFilters === filterIdentity({});
  const activeView = views.data?.find((view) => filterIdentity(view.filters) === currentFilters);
  const viewLabel =
    activeView?.name ?? (isDefault ? t("ticket.list.allTickets") : t("ticket.list.customView"));
  const fields = useCustomFields(project?.id);
  const table = useTable({
    features,
    columns: [...ticketColumns(), ...(fields.data ?? []).map(fieldColumn), ...timeColumns()],
    data: tickets.data?.items ?? [],
    getRowId: (row) => row.id,
    columnResizeMode: "onChange",
    enableRowSelection: canWrite,
    // Field columns start hidden, like the less common built-in ones.
    state: {
      columnVisibility: {
        ...Object.fromEntries(
          (fields.data ?? []).map((field) => [customFieldColumn(field.id), false]),
        ),
        ...visibility,
        title: true,
        select: canWrite,
      },
    },
    onColumnVisibilityChange: (change) =>
      setVisibility(typeof change === "function" ? change(visibility) : change),
  });
  const selected = table.getSelectedRowModel().rows.map((row) => row.original);
  const sectionRows = (section: Section) =>
    table.getRowModel().rows.filter((row) => section.has(row.original));
  // Rows in the order they render: sections top to bottom, skipping collapsed ones.
  const orderedIds = sections.flatMap((section) =>
    hidden(section.id) ? [] : sectionRows(section).map((row) => row.id),
  );
  const orderKey = orderedIds.join("\n");
  const sectionSelection = (section: Section) => {
    const rows = sectionRows(section),
      count = rows.filter((row) => row.getIsSelected()).length;
    return {
      checked: count > 0 && count === rows.length,
      indeterminate: count > 0 && count < rows.length,
      disabled: !rows.length,
      onCheckedChange: (checked: boolean) =>
        table.setRowSelection((previous) => {
          const next = { ...previous };
          for (const row of rows)
            if (checked) next[row.id] = true;
            else delete next[row.id];
          return next;
        }),
    };
  };
  // Names the selection for confirmations: the project, then how many come from each section.
  const selectedFrom = grouped
    ? formatList(
        sections.flatMap((section) => {
          const count = selected.filter(section.has).length;
          return count ? [t("ticket.list.sectionCount", { n: count, section: section.label })] : [];
        }),
      )
    : "";
  const source =
      project && (planning ? t("ticket.list.planning", { project: project.name }) : project.name),
    collection = source
      ? selectedFrom
        ? t("ticket.list.collection", { source, sections: selectedFrom })
        : source
      : "";
  useEffect(() => {
    if (!loading && project) writeListOrder(project.id, orderKey ? orderKey.split("\n") : []);
  }, [loading, project, orderKey]);
  // Keyboard highlight: J/K or arrows move it, Enter opens, Space previews, X selects, S/P/A edit
  // a property.
  const [active, setActive] = useState<string | null>(peek ?? null);
  // The highlight follows the previewed ticket as J and K step through it in the sheet; the last
  // one shown keeps its row for focus while the sheet closes.
  const [peeked, setPeeked] = useState(peek);
  if (peek && peek !== peeked) {
    setPeeked(peek);
    setActive(peek);
  }
  // The app's preview sheet steps through this list. My work spans projects, so its URL also
  // names the previewed ticket's project: an edit can drop the ticket from the list.
  const preview = useTicketPreview();
  const showPreview = (id: string) => {
    setActive(id);
    preview?.open({ ticketId: id, projectId: project?.id ?? latest.get(id)?.projectId });
  };
  // Focus returns to the row of the ticket last shown.
  usePreviewCollection(orderedIds, showPreview, () =>
    peeked
      ? document.querySelector<HTMLElement>(
          `.ticket-row[data-id="${CSS.escape(peeked)}"] .ticket-title`,
        )
      : null,
  );
  useEffect(() => {
    if (active)
      document
        .querySelector(`.ticket-row[data-id="${CSS.escape(active)}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const move = (delta: number) => {
    if (!orderedIds.length) return;
    const index = active ? orderedIds.indexOf(active) : -1;
    const next =
      index < 0
        ? delta > 0
          ? 0
          : orderedIds.length - 1
        : Math.min(orderedIds.length - 1, Math.max(0, index + delta));
    setActive(orderedIds[next] ?? null);
  };
  const rowKeys = { enabled: !creating && !peek && !schedule };
  // Enter and the arrows keep their default on focused links, buttons, and pickers, except
  // inside the highlighted row, where a closed picker still has focus after Escape.
  const navKeys = {
    ...rowKeys,
    guard: (event: KeyboardEvent) =>
      !(
        event.target instanceof Element &&
        event.target.closest(interactive) &&
        !event.target.closest(".ticket-row[data-active=true]")
      ),
  };
  useShortcut("j", () => move(1), rowKeys);
  useShortcut("ArrowDown", () => move(1), navKeys);
  useShortcut("k", () => move(-1), rowKeys);
  useShortcut("ArrowUp", () => move(-1), navKeys);
  useShortcut(
    "Enter",
    () => {
      const ticket = active ? latest.get(active) : undefined;
      if (ticket)
        void navigate({
          to: "/projects/$projectId/tickets/$ticketId",
          params: { projectId: ticket.projectId, ticketId: ticket.id },
        });
    },
    navKeys,
  );
  useShortcut(
    " ",
    () => {
      if (active && latest.has(active)) showPreview(active);
    },
    {
      ...rowKeys,
      // A focused control keeps Space, except the highlighted row's title link, where focus
      // returns after a preview closes.
      guard: (event: KeyboardEvent) => {
        const control = event.target instanceof Element && event.target.closest(interactive);
        return !control || control.matches(".ticket-row[data-active=true] .ticket-title");
      },
    },
  );
  useShortcut(
    "x",
    () => {
      if (active && canWrite) table.getRowModel().rowsById[active]?.toggleSelected();
    },
    rowKeys,
  );
  const openProperty = (column: string) => {
    if (active)
      document
        .querySelector<HTMLElement>(
          `.ticket-row[data-id="${CSS.escape(active)}"] [data-column="${column}"] [role=combobox]`,
        )
        ?.click();
  };
  useShortcut("s", () => openProperty("status"), rowKeys);
  useShortcut("p", () => openProperty("priority"), rowKeys);
  useShortcut("a", () => openProperty("assigneeId"), rowKeys);
  const toggleSection = (id: string) => {
    table.resetRowSelection();
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // Filter changes keep the layout and its period.
  const changeSearch = (next: TicketSearch) => {
    table.resetRowSelection();
    setPaging({ filterKey: JSON.stringify({ ...next, offset: 0, grouping, range }), pages: {} });
    onSearch({ ...next, period });
  };
  useShortcut(
    "c",
    () => {
      if (canWrite) setCreating(true);
    },
    { enabled: !creating },
  );
  // Moves: the manual order (`sort: manual`) and status steps are one versioned write. Keys, the
  // ticket menu, and drag and drop all resolve to a placement and go through `place`.
  const manual = search.sort === "manual",
    reorderable = canWrite && manual,
    descending = (search.order ?? defaultOrder[search.sort]) === "desc";
  const moveTicket = useOperation("move_ticket"),
    cache = useQueryClient(),
    [announcement, setAnnouncement] = useState(""),
    followActive = useRef(false);
  // Moves made before the previous one is saved wait their turn and use the version it returned,
  // so quick repeated keys are neither dropped nor rejected as stale.
  const queue = useRef(Promise.resolve()),
    savedVersions = useRef(new Map<string, number>());
  const statusName = (value: StatusValue) => {
    const { status, stateId } = parseStatus(value);
    return workflow.find((state) => state.id === stateId)?.name ?? stateLabels[status];
  };
  const place = (ticket: Ticket, { anchor: neighborId, below = false, status }: Placement) => {
    const changed = status && !sameStatus(ticket, status) ? status : undefined,
      neighbor = neighborId ? latest.get(neighborId) : undefined;
    if (!neighbor && !changed) return;
    const shown = {
      id: ticket.id,
      below,
      ...(neighbor ? { anchor: neighbor.id } : {}),
      ...(changed ? { status: changed } : {}),
    };
    setPlacing(shown);
    const moved = {
      key: ticket.key,
      neighbor: neighbor?.key,
      status: changed && statusName(changed),
    };
    setAnnouncement(
      neighbor
        ? changed
          ? below
            ? t("ticket.list.movedToBelow", moved)
            : t("ticket.list.movedToAbove", moved)
          : below
            ? t("ticket.list.movedBelow", moved)
            : t("ticket.list.movedAbove", moved)
        : changed
          ? t("ticket.list.movedTo", moved)
          : t("ticket.list.moved", moved),
    );
    // A descending list shows the manual order reversed.
    const after = below !== descending;
    queue.current = queue.current
      .then(async () => {
        const saved = await moveTicket.mutateAsync({
          projectId: ticket.projectId,
          ticketId: ticket.id,
          expectedVersion: Math.max(ticket.version, savedVersions.current.get(ticket.id) ?? 0),
          ...(neighbor ? (after ? { after: neighbor.id } : { before: neighbor.id }) : {}),
          ...(changed ? propertyChange("status", changed) : {}),
        });
        savedVersions.current.set(saved.id, saved.version);
      })
      .catch((error: unknown) => {
        void cache.invalidateQueries({ queryKey: ["kanvil"] });
        reportError(error);
      })
      .finally(() => setPlacing((current) => (current === shown ? undefined : current)));
  };
  const sectionOf = (ticket: Ticket) => sections.find((section) => section.has(ticket));
  // Status steps work in any order; in the manual order the ticket arrives on top of its new
  // section. Top, up, down, and bottom need the manual order.
  const targetFor = (ticket: Ticket, command: MoveCommand): Placement | undefined => {
    if (command === "previous" || command === "next") {
      // A project steps through its workflow states; My work, across projects, through categories.
      const steps: StatusValue[] = workflow.length ? workflow.map(stateValue) : [...states],
        at = steps.indexOf(workflow.length ? statusValue(ticket) : ticket.status),
        status = steps[at + (command === "next" ? 1 : -1)];
      if (!status) return undefined;
      const lane = sectionOf({ ...ticket, ...propertyChange("status", status) }),
        first =
          manual && lane ? sectionRows(lane).find((row) => row.id !== ticket.id)?.id : undefined;
      return { status, ...(first ? { anchor: first } : {}) };
    }
    const section = sectionOf(ticket);
    return reorderable && section
      ? neighborFor(
          sectionRows(section).map((row) => row.id),
          ticket.id,
          command,
        )
      : undefined;
  };
  const runMove = (ticket: Ticket, placement: Placement) => {
    followActive.current = true;
    place(ticket, placement);
  };
  // My work spans projects, so status steps check each ticket's own project, like inline edits.
  const writable = (ticket: Ticket) =>
    project
      ? canWrite
      : capabilitiesOf(
          projects.data?.find((item) => item.id === ticket.projectId) ?? { role: null },
        ).includes("ticket.write");
  const moveActive = (command: MoveCommand) => {
    const ticket = active ? latest.get(active) : undefined,
      placement = ticket && writable(ticket) && targetFor(ticket, command);
    if (ticket && placement) runMove(ticket, placement);
  };
  // The ticket menu lists the moves this list offers, disabled where there is nowhere to go.
  const menuMoves = (ticket: Ticket) =>
    moveCommandNames
      .filter((command) => manual || command === "previous" || command === "next")
      .map((command) => {
        const placement = targetFor(ticket, command);
        return { command, run: placement && (() => runMove(ticket, placement)) };
      });
  useShortcut("ArrowUp", () => moveActive("up"), { ...rowKeys, alt: true, shift: false });
  useShortcut("ArrowDown", () => moveActive("down"), { ...rowKeys, alt: true, shift: false });
  useShortcut("ArrowUp", () => moveActive("top"), { ...rowKeys, alt: true, shift: true });
  useShortcut("ArrowDown", () => moveActive("bottom"), { ...rowKeys, alt: true, shift: true });
  useShortcut("[", () => moveActive("previous"), rowKeys);
  useShortcut("]", () => moveActive("next"), rowKeys);
  // A row moved from the keyboard stays in view.
  useEffect(() => {
    // Waits for the moved row to render in its new place.
    if (!followActive.current || !active || !orderKey.includes(active)) return;
    followActive.current = false;
    document
      .querySelector(`.ticket-row[data-id="${CSS.escape(active)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [orderKey, active]);
  // Dropping on a row places the ticket beside it, taking that row's status on a status grouping.
  const drag = useReorderDrag((id, neighborId, below) => {
    const ticket = latest.get(id),
      neighbor = latest.get(neighborId);
    if (ticket && neighbor)
      place(ticket, {
        anchor: neighborId,
        below,
        ...(grouping === "status" && { status: statusValue(neighbor) }),
      });
  });
  // Rows take drops in the manual order, except across planning groups.
  const accepts = (section: Section) => {
    const dragged = drag.dragging ? latest.get(drag.dragging) : undefined;
    return manual && (grouping === "status" || !dragged || section.has(dragged));
  };
  // Dropping on a board lane outside its cards sets the status, and in the manual order places the
  // ticket at the end of the lane.
  const [dropLane, setDropLane] = useState<string | null>(null);
  const dropOn = (section: Section) => {
    const ticket = drag.dragging ? latest.get(drag.dragging) : undefined,
      state = workflow.find((item) => item.id === section.id),
      status = state ? stateValue(state) : states.find((category) => category === section.id);
    drag.end();
    setDropLane(null);
    const last = manual
      ? sectionRows(section).findLast((row) => row.id !== ticket?.id)?.id
      : undefined;
    if (ticket && status) place(ticket, { status, ...(last ? { anchor: last, below: true } : {}) });
  };
  const openRow = (ticket: Ticket, event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    // Pickers render in a portal; their clicks bubble through React but are not in the row.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (event.target instanceof Element && event.target.closest(interactive)) return;
    if (window.getSelection()?.toString()) return;
    void navigate({
      to: "/projects/$projectId/tickets/$ticketId",
      params: { projectId: ticket.projectId, ticketId: ticket.id },
    });
  };
  const empty = !tickets.error && tickets.data.total === 0 && (
    <EmptyState
      title={
        !isDefault || search.q
          ? t("ticket.list.emptyFiltered")
          : planning
            ? t("ticket.list.emptyPlanning")
            : project
              ? t("ticket.list.emptyProject")
              : t("ticket.list.emptyWork")
      }
    >
      {!isDefault ? (
        <Button onClick={() => changeSearch(searchSchema.parse({}))}>
          {t("ticket.filter.clear")}
        </Button>
      ) : (
        canWrite && (
          <Button variant="default" onClick={() => setCreating(true)}>
            <Plus />
            {t("ticket.list.createFirst")}
          </Button>
        )
      )}
    </EmptyState>
  );
  return (
    <>
      {project?.background && backgrounds === "show" && (
        <img
          src={project.background}
          alt=""
          aria-hidden="true"
          className="project-background pointer-events-none absolute inset-0 -z-10 size-full object-cover opacity-15 mask-[linear-gradient(to_bottom,black,transparent_90%)] dark:opacity-20"
        />
      )}
      {project && <ArchivedNotice project={project} />}
      <TicketListControls
        projectId={project?.id}
        archivedFilter={!planning}
        search={search}
        onSearch={changeSearch}
        view={
          !project ? null : planning ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              render={<Link to="/projects/$projectId" params={{ projectId: project.id }} />}
            >
              <ArrowLeft />
              {t("ticket.list.activeWork")}
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    aria-label={t("ticket.list.views")}
                    title={viewLabel}
                    className="max-w-full min-w-0 justify-start"
                  />
                }
              >
                <span className="truncate">{viewLabel}</span>
                <ChevronDown className="size-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-[70dvh] w-60 overflow-y-auto">
                <DropdownMenuGroup>
                  <DropdownMenuRadioGroup
                    value={activeView?.id ?? (isDefault ? "all" : "custom")}
                    onValueChange={(id) => {
                      const chosen = views.data?.find((view) => view.id === id);
                      if (id === "all") changeSearch(searchSchema.parse({}));
                      else if (chosen) changeSearch({ ...chosen.filters, offset: 0 });
                    }}
                  >
                    {[{ id: "all", name: t("ticket.list.allTickets") }, ...(views.data ?? [])].map(
                      (view) => (
                        <DropdownMenuRadioItem key={view.id} value={view.id} closeOnClick>
                          {view.name}
                        </DropdownMenuRadioItem>
                      ),
                    )}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  {canWrite && !schedule && (
                    <DropdownMenuItem
                      onClick={() => table.toggleAllRowsSelected(!table.getIsAllRowsSelected())}
                    >
                      {table.getIsAllRowsSelected()
                        ? t("ticket.selection.clear")
                        : t("ticket.list.selectAll")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setSavingView(true)}>
                    <BookmarkPlus />
                    {t("ticket.list.saveCurrentView")}
                  </DropdownMenuItem>
                  {activeView && (
                    <DropdownMenuItem onClick={() => setDeletingView(activeView)}>
                      <Trash2 />
                      {t("ticket.list.deleteView", { name: activeView.name })}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
        actions={
          project && (
            <>
              {!planning && (
                <IconButton
                  label={t("ticket.list.planningLink")}
                  render={
                    <Link to="/projects/$projectId/planning" params={{ projectId: project.id }} />
                  }
                >
                  <NotebookTabs />
                </IconButton>
              )}
              <IconButton
                label={t("ticket.menu.newTicket")}
                title={t("ticket.list.newTicketShortcut", { shortcut: "C" })}
                variant="default"
                disabled={!canWrite}
                onClick={() => setCreating(true)}
              >
                <Plus />
              </IconButton>
            </>
          )
        }
        onReset={() => {
          resetPreferences(identity.id, ticketDisplayPreferences);
          changeSearch({ ...search, sort: "priority", order: undefined, offset: 0 });
        }}
      />
      <Modal
        title={t("ticket.list.saveView")}
        open={savingView}
        onOpenChange={setSavingView}
        busy={saveView.isPending}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (project)
              void saveView
                .mutateAsync({
                  projectId: project.id,
                  name: viewName,
                  filters: ticketFilter.parse(
                    Object.fromEntries(Object.entries(search).filter(([key]) => key !== "offset")),
                  ),
                })
                .then(() => {
                  setSavingView(false);
                  setViewName("");
                  toast.success(t("ticket.list.viewSaved"));
                })
                .catch(() => {});
          }}
        >
          <Input
            label={t("ticket.list.viewName")}
            required
            maxLength={80}
            value={viewName}
            onChange={(event) => setViewName(event.target.value)}
          />
          <FormActions
            error={saveView.error}
            pending={saveView.isPending}
            submitLabel={t("ticket.list.saveView")}
            onCancel={() => setSavingView(false)}
          />
        </form>
      </Modal>
      {deletingView && (
        <Confirm
          label={t("ticket.list.deleteView", { name: deletingView.name })}
          description={t("ticket.list.deleteViewConfirm", { name: deletingView.name })}
          trigger={false}
          open
          onOpenChange={(open) => {
            if (!open) setDeletingView(null);
          }}
          onConfirm={async () => {
            if (project)
              await deleteView.mutateAsync({ projectId: project.id, viewId: deletingView.id });
            setDeletingView(null);
          }}
        />
      )}
      <ErrorNotice error={tickets.error ?? deleteView.error} />
      {canWrite && selected.length > 0 && (
        <TicketSelectionToolbar
          selected={selected}
          total={orderedIds.length}
          collection={collection}
          onClear={() => table.resetRowSelection()}
        />
      )}
      {tickets.isPending ? (
        <Loading />
      ) : tickets.error ? (
        <Button
          disabled={queries.some((query) => query.isFetching)}
          onClick={() => {
            for (const query of queries) if (query.error) void query.refetch();
          }}
        >
          {t("ticket.list.retry")}
        </Button>
      ) : board ? (
        <div
          role="region"
          aria-label={t("ticket.list.board")}
          className={cn(
            "ticket-board relative min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain",
            densityClass,
          )}
          data-density={density}
          data-label-display={labelDisplay}
        >
          {/* With nothing to show, the empty state replaces the lanes. */}
          {empty || (
            <div className="flex min-h-full w-max gap-5 pb-4">
              {sections.map((section) => (
                <section
                  key={section.id}
                  aria-label={t("ticket.list.sectionTickets", { section: section.label })}
                  data-status={section.id}
                  data-drop={dropLane === section.id || undefined}
                  className="flex w-[min(19rem,calc(100vw-3.5rem))] shrink-0 flex-col transition-colors data-[drop=true]:bg-primary/5"
                  onDragOver={(event) => {
                    if (!drag.dragging) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDropLane(section.id);
                  }}
                  onDragLeave={(event) => {
                    if (
                      !(event.relatedTarget instanceof Node) ||
                      !event.currentTarget.contains(event.relatedTarget)
                    )
                      setDropLane((lane) => (lane === section.id ? null : lane));
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    dropOn(section);
                  }}
                >
                  <h2 className="sticky top-0 z-10 mb-0 flex h-9 items-center gap-2 border-b bg-background px-2 text-xs font-normal">
                    {canWrite && (
                      <Check
                        label={t("ticket.list.selectSection", { section: section.label })}
                        className="sr-checkbox"
                        {...sectionSelection(section)}
                      />
                    )}
                    {section.heading}
                    <span className="tabular-nums text-muted-foreground">{section.total}</span>
                  </h2>
                  <ul className="m-0 flex flex-1 list-none flex-col p-0">
                    {sectionRows(section).map((row) => {
                      const cells = row.getVisibleCells(),
                        cell = (id: string) => cells.find((item) => item.column.id === id);
                      const select = cell("select"),
                        key = cell("key"),
                        title = cell("title");
                      return (
                        <TicketContextMenu
                          key={row.id}
                          ticket={row.original}
                          onPreview={() => showPreview(row.id)}
                          moves={writable(row.original) ? () => menuMoves(row.original) : undefined}
                        >
                          <li
                            className={cn(
                              rowClass,
                              "flex flex-col gap-1.5 border-b px-2 py-2.5 transition-colors hover:bg-muted/40 data-[active=true]:shadow-[inset_2px_0_0_var(--primary)] data-[dragging=true]:opacity-50 data-[drop=after]:shadow-[inset_0_-2px_0_var(--primary)] data-[drop=before]:shadow-[inset_0_2px_0_var(--primary)] in-data-[density=comfortable]:gap-2.5 in-data-[density=comfortable]:py-4",
                            )}
                            data-id={row.id}
                            data-selected={row.getIsSelected()}
                            data-active={active === row.id || undefined}
                            data-fresh={seen.fresh.has(row.id) || undefined}
                            {...drag.item(row.id, {
                              draggable: canWrite,
                              accepts: accepts(section),
                            })}
                            onDragEnd={() => {
                              drag.end();
                              setDropLane(null);
                            }}
                            onClick={(event) => openRow(row.original, event)}
                          >
                            <div className="flex min-h-6 items-center gap-2">
                              {select && <table.FlexRender cell={select} />}
                              {key && (
                                <span
                                  data-column="key"
                                  className="font-mono text-[11px] text-muted-foreground"
                                >
                                  <table.FlexRender cell={key} />
                                </span>
                              )}
                              <span data-column="status" className="ml-auto">
                                <PropertyCell
                                  ticket={row.original}
                                  property="status"
                                  value={statusValue(row.original)}
                                  iconOnly
                                />
                              </span>
                            </div>
                            {title && <table.FlexRender cell={title} />}
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs empty:hidden">
                              {cells
                                .filter(
                                  (item) =>
                                    !["select", "key", "title", "status"].includes(item.column.id),
                                )
                                .map((item) => (
                                  <span
                                    key={item.id}
                                    data-column={item.column.id}
                                    className="min-w-0 max-w-full empty:hidden"
                                  >
                                    <table.FlexRender cell={item} />
                                  </span>
                                ))}
                            </div>
                          </li>
                        </TicketContextMenu>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      ) : schedule && range ? (
        <TicketSchedule
          layout={schedule}
          tickets={all}
          anchor={anchor}
          range={range}
          onAnchor={(next) =>
            onSearch({ ...route, period: next ? format(next, "yyyy-MM-dd") : undefined })
          }
        />
      ) : (
        <div className="table-scroll min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain [&_[data-slot=table-container]]:overflow-visible">
          {/* One table per section lets each sticky heading be pushed away by the next one; the
              wrapper is the single accessible table. */}
          <div
            role="table"
            aria-label={t("ticket.list.tickets")}
            className={cn(
              "ticket-table",
              densityClass,
              "data-[density=comfortable]:[&_td]:text-sm data-[density=comfortable]:[&_td_svg]:size-4 data-[density=comfortable]:[&_td[data-column=key]]:text-xs",
            )}
            data-density={density}
            data-label-display={labelDisplay}
            style={{ "--table-width": `${table.getTotalSize()}px` }}
          >
            <div className="sticky top-0 z-20 bg-background">
              <Table role="presentation" className={tableClass}>
                <ColumnGroup leaves={table.getVisibleLeafColumns()} />
                <TableHeader role="rowgroup">
                  {table.getHeaderGroups().map((group) => (
                    <TableRow key={group.id} role="row" className="hover:bg-transparent">
                      {group.headers.map((header) => {
                        const sort = sortBy[header.column.id],
                          sorted = sort !== undefined && search.sort === sort,
                          direction = sorted ? (search.order ?? defaultOrder[sort]) : undefined;
                        return (
                          <TableHead
                            key={header.id}
                            role="columnheader"
                            scope="col"
                            data-column={header.column.id}
                            aria-sort={
                              direction === "asc"
                                ? "ascending"
                                : direction === "desc"
                                  ? "descending"
                                  : undefined
                            }
                            className={cn(
                              "relative h-8 overflow-hidden bg-transparent px-3 text-[10.5px] font-medium tracking-[0.08em] text-ellipsis text-muted-foreground uppercase",
                              sort && "p-0",
                            )}
                            style={{ width: header.getSize() }}
                          >
                            {sort ? (
                              <Button
                                variant="ghost"
                                title={
                                  typeof header.column.columnDef.header === "string"
                                    ? header.column.columnDef.header
                                    : undefined
                                }
                                className={cn(
                                  "h-8 w-full justify-start gap-1 rounded-none pr-2 pl-3 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase hover:text-foreground",
                                  sorted && "text-foreground",
                                )}
                                onClick={() =>
                                  changeSearch({
                                    ...search,
                                    sort,
                                    order: sorted
                                      ? direction === "asc"
                                        ? "desc"
                                        : "asc"
                                      : undefined,
                                    offset: 0,
                                  })
                                }
                              >
                                {/* Long column names, as in German, end in an ellipsis. */}
                                <span className="min-w-0 truncate">
                                  <table.FlexRender header={header} />
                                </span>
                                {direction === "asc" && <ArrowUp className="size-3 shrink-0" />}
                                {direction === "desc" && <ArrowDown className="size-3 shrink-0" />}
                              </Button>
                            ) : (
                              <table.FlexRender header={header} />
                            )}
                            {header.column.getCanResize() && (
                              <Button
                                variant="ghost"
                                className="resizer absolute top-2 right-0 bottom-2 h-auto w-2 min-w-0 cursor-col-resize touch-none rounded-none border-r bg-transparent p-0 hover:border-primary hover:bg-transparent"
                                aria-label={t("ticket.list.resizeColumn", {
                                  column:
                                    fields.data?.find(
                                      (field) => customFieldColumn(field.id) === header.id,
                                    )?.name ?? header.id,
                                })}
                                onMouseDown={header.getResizeHandler()}
                                onTouchStart={header.getResizeHandler()}
                                onKeyDown={(event) => {
                                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                                    event.preventDefault();
                                    table.setColumnSizing((previous) => ({
                                      ...previous,
                                      [header.column.id]: Math.max(
                                        header.column.columnDef.minSize ?? 60,
                                        header.column.getSize() +
                                          (event.key === "ArrowRight" ? 20 : -20),
                                      ),
                                    }));
                                  }
                                }}
                              />
                            )}
                          </TableHead>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableHeader>
              </Table>
            </div>
            {sections.map((section) => (
              <Table key={section.id} role="presentation" className={tableClass}>
                <ColumnGroup leaves={table.getVisibleLeafColumns()} />
                <TableBody
                  role="rowgroup"
                  aria-label={
                    grouped
                      ? t("ticket.list.sectionTickets", { section: section.label })
                      : t("ticket.list.tickets")
                  }
                >
                  {grouped && (
                    <TableRow
                      className="ticket-status-heading hover:bg-transparent"
                      data-status={grouping === "status" ? section.id : undefined}
                    >
                      <TableHead
                        scope="rowgroup"
                        className="sticky top-8 z-10 border-b bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))] p-0"
                        colSpan={
                          table.getAllLeafColumns().filter((column) => column.getIsVisible()).length
                        }
                      >
                        <TicketSectionHeader
                          section={section}
                          collapsed={collapsed.has(section.id)}
                          onToggle={() => toggleSection(section.id)}
                          selection={canWrite ? sectionSelection(section) : undefined}
                        />
                      </TableHead>
                    </TableRow>
                  )}
                  {!hidden(section.id) &&
                    sectionRows(section).map((row) => (
                      <TicketContextMenu
                        key={row.id}
                        ticket={row.original}
                        onPreview={() => showPreview(row.id)}
                        moves={writable(row.original) ? () => menuMoves(row.original) : undefined}
                      >
                        <TableRow
                          className={cn(
                            rowClass,
                            "data-[active=true]:[&>td:first-child]:shadow-[inset_2px_0_0_var(--primary)] data-[dragging=true]:opacity-50 data-[drop=after]:[&>td]:shadow-[inset_0_-2px_0_var(--primary)] data-[drop=before]:[&>td]:shadow-[inset_0_2px_0_var(--primary)]",
                          )}
                          role="row"
                          data-id={row.id}
                          data-selected={row.getIsSelected()}
                          data-active={active === row.id || undefined}
                          data-fresh={seen.fresh.has(row.id) || undefined}
                          {...drag.item(row.id, {
                            draggable: reorderable,
                            accepts: accepts(section),
                          })}
                          onClick={(event) => openRow(row.original, event)}
                        >
                          {row.getVisibleCells().map((cell) => (
                            <TableCell
                              className={cn(
                                "px-3 py-2 align-middle text-xs whitespace-normal in-data-[density=comfortable]:py-4",
                                cell.column.id === "key" &&
                                  "font-mono text-[11px] text-muted-foreground",
                              )}
                              key={cell.id}
                              role="cell"
                              data-column={cell.column.id}
                              data-label={
                                typeof cell.column.columnDef.header === "string"
                                  ? cell.column.columnDef.header
                                  : undefined
                              }
                            >
                              <table.FlexRender cell={cell} />
                            </TableCell>
                          ))}
                        </TableRow>
                      </TicketContextMenu>
                    ))}
                </TableBody>
              </Table>
            ))}
          </div>
          {empty}
        </div>
      )}
      {!tickets.isPending && !tickets.error && (
        <footer className="shrink-0 py-2 text-xs text-muted-foreground">
          {schedule
            ? t("ticket.list.scheduledCount", { count: tickets.data.total })
            : t("ticket.list.count", { count: tickets.data.total })}
        </footer>
      )}
      <span role="status" className="sr-only">
        {announcement}
      </span>
      <Modal
        size="composer"
        title={t("ticket.menu.newTicket")}
        open={creating}
        onOpenChange={setCreating}
      >
        {creating && project && (
          <TicketEditor projectId={project.id} onSaved={() => setCreating(false)} />
        )}
      </Modal>
    </>
  );
}
