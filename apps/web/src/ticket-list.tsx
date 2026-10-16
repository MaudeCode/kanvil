import { toast } from "sonner";
import { TicketContextMenu } from "./components/object-context-menu.tsx";
import { useEffect, useState, type MouseEvent } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Plus, ChevronDown, BookmarkPlus, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import {
  useTable,
  tableFeatures,
  columnSizingFeature,
  columnResizingFeature,
  rowSelectionFeature,
  columnVisibilityFeature,
  type ColumnDef,
} from "@tanstack/react-table";
import { z } from "zod";
import {
  ticketFilter,
  defaultOrder,
  states,
  stateLabels,
  type Ticket,
  type Project,
  type Output,
} from "@kanvil/contracts";
import { api, useIdentity, useProjectAccess, useOperation } from "./data.tsx";
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
  PropertyValue,
  TicketProperty,
  pair,
  useTicketChange,
  type PropertyName,
  type PropertyValues,
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
import { TicketEditor } from "./ticket-editor.tsx";
import { writeListOrder } from "./lib/list-order.ts";
import { useShortcut } from "./hooks/use-shortcut.ts";
import { cn } from "@/lib/utils";

import {
  searchSchema,
  ticketDensitySchema,
  ticketLabelDisplaySchema,
  ticketGroupingSchema,
  type TicketGrouping,
  type TicketSearch,
  type TicketDensity,
  type TicketLabelDisplay,
} from "./search.ts";
const features = tableFeatures({
  columnSizingFeature,
  columnResizingFeature,
  rowSelectionFeature,
  columnVisibilityFeature,
});
const pageSize = 100;
const defaultVisibility = {
  kind: false,
  scopes: false,
  assigneeId: false,
  createdAt: false,
  updatedAt: false,
};
function TicketStatusHeader({
  status,
  count,
  collapsed,
  onToggle,
}: {
  status: Ticket["status"];
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center">
      <Button
        variant="ghost"
        className="flex-1 justify-start gap-2 rounded-none px-3"
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${stateLabels[status]} tickets`}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <ChevronDown
          className={cn("size-3 transition-transform duration-200", collapsed && "-rotate-90")}
        />
        <TicketIndicator property="status" value={status} />
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      </Button>
    </div>
  );
}
function readDisplayPreference<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const result = schema.safeParse(localStorage.getItem(key));
    return result.success ? result.data : fallback;
  } catch {
    return fallback;
  }
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
const columns: ColumnDef<typeof features, Ticket>[] = [
  {
    id: "select",
    size: 44,
    enableResizing: false,
    enableHiding: false,
    header: ({ table }) => (
      <Check
        label="Select all displayed tickets"
        className="sr-checkbox"
        checked={table.getIsAllRowsSelected()}
        indeterminate={table.getIsSomeRowsSelected() && !table.getIsAllRowsSelected()}
        onCheckedChange={(checked) => table.toggleAllRowsSelected(checked)}
      />
    ),
    cell: ({ row }) => (
      <Check
        label={`Select ${row.original.key}`}
        className="sr-checkbox"
        checked={row.getIsSelected()}
        onCheckedChange={(checked) => row.toggleSelected(checked)}
      />
    ),
  },
  { accessorKey: "key", header: "Ticket", size: 100, minSize: 90 },
  {
    accessorKey: "title",
    header: "Title",
    size: 400,
    enableHiding: false,
    minSize: 200,
    cell: ({ row }) => (
      <Link
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
        header: key === "labels" ? "Labels" : "Scopes",
        size: 180,
        minSize: 120,
        cell: ({ row }) => (
          <TicketTags
            tags={row.original[key]}
            label={key === "labels" ? "Labels" : "Scopes"}
            variant={key === "labels" ? "secondary" : "outline"}
          />
        ),
      }) satisfies ColumnDef<typeof features, Ticket>,
  ),
  {
    accessorKey: "status",
    header: "Status",
    size: 115,
    minSize: 105,
    cell: ({ row }) => (
      <PropertyCell ticket={row.original} property="status" value={row.original.status} />
    ),
  },
  {
    accessorKey: "priority",
    header: "Priority",
    size: 72,
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
    header: "Difficulty",
    size: 90,
    minSize: 85,
    cell: ({ row }) => (
      <PropertyCell ticket={row.original} property="difficulty" value={row.original.difficulty} />
    ),
  },
  {
    accessorKey: "kind",
    header: "Kind",
    size: 110,
    cell: ({ row }) => (
      <PropertyCell ticket={row.original} property="kind" value={row.original.kind} />
    ),
  },
  {
    accessorKey: "assigneeId",
    header: "Assignee",
    size: 160,
    cell: ({ row }) => (
      <PropertyCell ticket={row.original} property="assignee" value={row.original.assigneeId} />
    ),
  },
  {
    accessorKey: "dueAt",
    header: "Due",
    size: 100,
    minSize: 90,
    cell: ({ row }) => (
      <DueDate
        value={row.original.dueAt}
        open={row.original.status !== "done" && row.original.status !== "cancelled"}
      />
    ),
  },
  ...(["createdAt", "updatedAt"] as const).map(
    (key) =>
      ({
        accessorKey: key,
        header: key === "createdAt" ? "Created" : "Updated",
        size: 130,
        cell: ({ row }) => (
          <RelativeTime value={row.original[key]} className="text-muted-foreground" />
        ),
      }) satisfies ColumnDef<typeof features, Ticket>,
  ),
];
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
  dueAt: "due",
  createdAt: "created",
  updatedAt: "updated",
};
const pageKey = (status: Ticket["status"] | undefined) => status ?? "all";
const interactive = "a, button, input, label, [role=checkbox], [role=combobox], [role=menu]";
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
export function TicketList({
  project,
  search,
  onSearch,
}: {
  project: Project;
  search: TicketSearch;
  onSearch: (next: TicketSearch) => void;
}) {
  const access = useProjectAccess(project.id);
  const identity = useIdentity();
  const navigate = useNavigate();
  const storageKey = `kanvil:${identity.id}:ticket-columns`;
  const densityKey = `kanvil:${identity.id}:ticket-density`;
  const labelDisplayKey = `kanvil:${identity.id}:ticket-label-display`;
  const groupingKey = `kanvil:${identity.id}:ticket-grouping`;
  const [labelDisplay, setLabelDisplay] = useState<TicketLabelDisplay>(() =>
    readDisplayPreference(labelDisplayKey, ticketLabelDisplaySchema, "compact"),
  );
  const [grouping, setGrouping] = useState<TicketGrouping>(() =>
    readDisplayPreference(groupingKey, ticketGroupingSchema, "status"),
  );
  const [density, setDensity] = useState<TicketDensity>(() =>
    readDisplayPreference(densityKey, ticketDensitySchema, "compact"),
  );
  const [visibility, setVisibility] = useState<Record<string, boolean>>(() => {
    try {
      return {
        ...defaultVisibility,
        ...z
          .record(z.string(), z.boolean())
          .parse(JSON.parse(localStorage.getItem(storageKey) ?? "{}")),
      };
    } catch {
      return defaultVisibility;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(visibility));
      localStorage.setItem(densityKey, density);
      localStorage.setItem(labelDisplayKey, labelDisplay);
      localStorage.setItem(groupingKey, grouping);
    } catch {
      /* Display controls work without storage. */
    }
  }, [
    storageKey,
    visibility,
    densityKey,
    density,
    labelDisplayKey,
    labelDisplay,
    groupingKey,
    grouping,
  ]);
  const filterKey = JSON.stringify({ ...search, offset: 0, grouping });
  const [paging, setPaging] = useState<{ filterKey: string; pages: Record<string, number> }>({
    filterKey,
    pages: {},
  });
  const [collapsed, setCollapsed] = useState<Set<Ticket["status"]>>(() => new Set());
  const pages = paging.filterKey === filterKey ? paging.pages : {};
  // Grouped lists fetch one series of pages per status section; a flat list fetches one series.
  const sections: (Ticket["status"] | undefined)[] =
    grouping === "status"
      ? states.filter((status) => !search.status || status === search.status)
      : [undefined];
  const pageQueries = sections.flatMap((status) =>
    Array.from({ length: pages[pageKey(status)] ?? 1 }, (_, page) => ({
      status,
      offset: page * pageSize,
    })),
  );
  const queries = useQueries({
    queries: pageQueries.map(({ status, offset }) =>
      api.query("list_tickets", {
        projectId: project.id,
        ...search,
        status: status ?? search.status,
        offset,
        limit: pageSize,
      }),
    ),
  });
  const groups = sections.map((status) => ({
    status,
    data: {
      items: pageQueries.flatMap((entry, index) =>
        entry.status === status ? (queries[index]?.data?.items ?? []) : [],
      ),
      total: queries[pageQueries.findIndex((entry) => entry.status === status)]?.data?.total ?? 0,
    },
  }));
  const requiredPages = Object.fromEntries(
    groups.map((group) => [
      pageKey(group.status),
      Math.max(1, Math.ceil(group.data.total / pageSize)),
    ]),
  );
  const missingPages = sections.some(
    (status) => (pages[pageKey(status)] ?? 1) < (requiredPages[pageKey(status)] ?? 1),
  );
  // Load the remaining pages of a section as soon as its total is known.
  if (missingPages) setPaging({ filterKey, pages: requiredPages });
  const latest = new Map<string, Ticket>();
  for (const group of groups)
    for (const ticket of group.data?.items ?? []) {
      const previous = latest.get(ticket.id);
      if (!previous || ticket.version > previous.version) latest.set(ticket.id, ticket);
    }
  // Rows that arrive through realtime after the first load get a short highlight.
  const loading = missingPages || queries.some((query) => query.isPending);
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
  const tickets = {
    isPending: loading,
    error: queries.find((query) => query.error)?.error,
    data: {
      items: [...latest.values()].filter(
        (ticket) => grouping === "none" || !collapsed.has(ticket.status),
      ),
      total: groups.reduce((sum, group) => sum + (group.data?.total ?? 0), 0),
    },
  };
  const views = useQuery(api.query("list_views", { projectId: project.id }));
  const saveView = useOperation("save_view"),
    deleteView = useOperation("delete_view");
  const [creating, setCreating] = useState<Partial<Pick<Ticket, "status">> | null>(null);
  const [viewName, setViewName] = useState(""),
    [savingView, setSavingView] = useState(false);
  const [deletingView, setDeletingView] = useState<Output<"list_views">[number] | null>(null);
  const currentFilters = ticketFilter.parse(
      Object.fromEntries(Object.entries(search).filter(([key]) => key !== "offset")),
    ),
    isDefault = JSON.stringify(currentFilters) === JSON.stringify(ticketFilter.parse({}));
  const activeView = views.data?.find(
    (view) => JSON.stringify(currentFilters) === JSON.stringify(ticketFilter.parse(view.filters)),
  );
  const viewLabel = activeView?.name ?? (isDefault ? "All tickets" : "Custom view");
  const table = useTable({
    features,
    columns,
    data: tickets.data?.items ?? [],
    getRowId: (row) => row.id,
    columnResizeMode: "onChange",
    enableRowSelection: access.canWrite,
    state: { columnVisibility: { ...visibility, title: true, select: access.canWrite } },
    onColumnVisibilityChange: setVisibility,
  });
  const selected = table.getSelectedRowModel().rows.map((row) => row.original);
  // Rows in the order they render: sections top to bottom, skipping collapsed ones.
  const orderedIds = groups
    .filter((group) => group.data.total > 0)
    .flatMap(({ status }) =>
      status && collapsed.has(status)
        ? []
        : table
            .getRowModel()
            .rows.filter((row) => !status || row.original.status === status)
            .map((row) => row.id),
    );
  const orderKey = orderedIds.join("\n");
  useEffect(() => {
    if (!loading) writeListOrder(project.id, orderKey ? orderKey.split("\n") : []);
  }, [loading, project.id, orderKey]);
  // Keyboard highlight: J/K or arrows move it, Enter opens, X selects, S/P/A edit a property.
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (active)
      document
        .querySelector(`tr[data-id="${CSS.escape(active)}"]`)
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
  const rowKeys = { enabled: creating === null };
  // Enter and the arrows keep their default on focused links, buttons, and pickers, except
  // inside the highlighted row, where a closed picker still has focus after Escape.
  const navKeys = {
    ...rowKeys,
    guard: (event: KeyboardEvent) =>
      !(
        event.target instanceof Element &&
        event.target.closest(interactive) &&
        !event.target.closest("tr[data-active=true]")
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
    "x",
    () => {
      if (active && access.canWrite) table.getRowModel().rowsById[active]?.toggleSelected();
    },
    rowKeys,
  );
  const openProperty = (column: string) => {
    if (active)
      document
        .querySelector<HTMLElement>(
          `tr[data-id="${CSS.escape(active)}"] td[data-column="${column}"] [role=combobox]`,
        )
        ?.click();
  };
  useShortcut("s", () => openProperty("status"), rowKeys);
  useShortcut("p", () => openProperty("priority"), rowKeys);
  useShortcut("a", () => openProperty("assigneeId"), rowKeys);
  const toggleStatus = (status: Ticket["status"]) => {
    table.resetRowSelection();
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };
  const changeSearch = (next: TicketSearch) => {
    table.resetRowSelection();
    setPaging({ filterKey: JSON.stringify({ ...next, offset: 0, grouping }), pages: {} });
    onSearch(next);
  };
  useShortcut(
    "c",
    () => {
      if (access.canWrite) setCreating({});
    },
    { enabled: creating === null },
  );
  const openRow = (ticket: Ticket, event: MouseEvent<HTMLTableRowElement>) => {
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
  return (
    <>
      <TicketListControls
        projectId={project.id}
        search={search}
        onSearch={changeSearch}
        view={
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  aria-label="Ticket views"
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
                  {[{ id: "all", name: "All tickets" }, ...(views.data ?? [])].map((view) => (
                    <DropdownMenuRadioItem key={view.id} value={view.id} closeOnClick>
                      {view.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                {access.canWrite && (
                  <DropdownMenuItem
                    onClick={() => table.toggleAllRowsSelected(!table.getIsAllRowsSelected())}
                  >
                    {table.getIsAllRowsSelected()
                      ? "Clear selection"
                      : "Select all displayed tickets"}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => setSavingView(true)}>
                  <BookmarkPlus />
                  Save current view
                </DropdownMenuItem>
                {activeView && (
                  <DropdownMenuItem onClick={() => setDeletingView(activeView)}>
                    <Trash2 />
                    Delete view {activeView.name}
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        }
        actions={
          <IconButton
            label="New ticket"
            title="New ticket (C)"
            variant="default"
            disabled={!access.canWrite}
            onClick={() => setCreating({})}
          >
            <Plus />
          </IconButton>
        }
        density={density}
        onDensityChange={setDensity}
        labelDisplay={labelDisplay}
        onLabelDisplayChange={setLabelDisplay}
        grouping={grouping}
        onGroupingChange={setGrouping}
        columns={table
          .getAllLeafColumns()
          .filter((column) => column.getCanHide())
          .map((column) => ({
            id: column.id,
            label: String(column.columnDef.header),
            visible: column.getIsVisible(),
          }))}
        onColumnChange={(id, visible) => table.getColumn(id)?.toggleVisibility(visible)}
        onReset={() => {
          setVisibility(defaultVisibility);
          setDensity("compact");
          setLabelDisplay("compact");
          setGrouping("status");
          changeSearch({ ...search, sort: "priority", order: undefined, offset: 0 });
        }}
      />
      <Modal
        title="Save view"
        open={savingView}
        onOpenChange={setSavingView}
        busy={saveView.isPending}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
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
                toast.success("View saved");
              })
              .catch(() => {});
          }}
        >
          <Input
            label="View name"
            required
            maxLength={80}
            value={viewName}
            onChange={(event) => setViewName(event.target.value)}
          />
          <FormActions
            error={saveView.error}
            pending={saveView.isPending}
            submitLabel="Save view"
            onCancel={() => setSavingView(false)}
          />
        </form>
      </Modal>
      {deletingView && (
        <Confirm
          label={`Delete view ${deletingView.name}`}
          description={`Remove ${deletingView.name} from saved views? Tickets stay unchanged.`}
          trigger={false}
          open
          onOpenChange={(open) => {
            if (!open) setDeletingView(null);
          }}
          onConfirm={async () => {
            await deleteView.mutateAsync({ projectId: project.id, viewId: deletingView.id });
            setDeletingView(null);
          }}
        />
      )}
      <ErrorNotice error={tickets.error ?? deleteView.error} />
      {selected.length > 0 && (
        <TicketSelectionToolbar selected={selected} onClear={() => table.resetRowSelection()} />
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
          Retry loading tickets
        </Button>
      ) : (
        <div className="table-scroll min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain [&_[data-slot=table-container]]:overflow-visible">
          {/* One table per section lets each sticky heading be pushed away by the next one; the
              wrapper is the single accessible table. */}
          <div
            role="table"
            aria-label="Tickets"
            // Comfortable spacing also scales the text, badges, and icons so rows fill the extra room.
            className="ticket-table data-[density=comfortable]:[&_[data-priority]_svg]:size-5! data-[density=comfortable]:[&_[data-slot=badge]]:h-6 data-[density=comfortable]:[&_[data-slot=badge]]:px-2 data-[density=comfortable]:[&_[data-slot=badge]]:text-xs data-[density=comfortable]:[&_.status]:text-sm data-[density=comfortable]:[&_[data-slot=checkbox]]:size-5 data-[density=comfortable]:[&_.ticket-title]:text-[15px] data-[density=comfortable]:[&_.ticket-title]:leading-6 data-[density=comfortable]:[&_td]:text-sm data-[density=comfortable]:[&_td_svg]:size-4 data-[density=comfortable]:[&_td[data-column=key]]:text-xs"
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
                              "relative h-8 bg-transparent px-3 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase",
                              sort && "p-0",
                            )}
                            style={{ width: header.getSize() }}
                          >
                            {sort ? (
                              <Button
                                variant="ghost"
                                className={cn(
                                  "h-8 w-full justify-start gap-1 rounded-none px-3 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase hover:text-foreground",
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
                                <table.FlexRender header={header} />
                                {direction === "asc" && <ArrowUp className="size-3" />}
                                {direction === "desc" && <ArrowDown className="size-3" />}
                              </Button>
                            ) : (
                              <table.FlexRender header={header} />
                            )}
                            {header.column.getCanResize() && (
                              <Button
                                variant="ghost"
                                className="resizer absolute top-2 right-0 bottom-2 h-auto w-2 min-w-0 cursor-col-resize touch-none rounded-none border-r bg-transparent p-0 hover:border-primary hover:bg-transparent"
                                aria-label={`Resize ${header.id} column`}
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
            {groups
              .filter((group) => group.data && group.data.total > 0)
              .map(({ status, data }) => (
                <Table key={pageKey(status)} role="presentation" className={tableClass}>
                  <ColumnGroup leaves={table.getVisibleLeafColumns()} />
                  <TableBody
                    role="rowgroup"
                    aria-label={status ? `${stateLabels[status]} tickets` : "Tickets"}
                  >
                    {status && (
                      <TableRow
                        className="ticket-status-heading hover:bg-transparent"
                        data-status={status}
                      >
                        <TableHead
                          scope="rowgroup"
                          className="sticky top-8 z-10 border-b bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))] p-0"
                          colSpan={
                            table.getAllLeafColumns().filter((column) => column.getIsVisible())
                              .length
                          }
                        >
                          <TicketStatusHeader
                            status={status}
                            count={data.total}
                            collapsed={collapsed.has(status)}
                            onToggle={() => toggleStatus(status)}
                          />
                        </TableHead>
                      </TableRow>
                    )}
                    {(!status || !collapsed.has(status)) &&
                      table
                        .getRowModel()
                        .rows.filter((row) => !status || row.original.status === status)
                        .map((row) => (
                          <TicketContextMenu key={row.id} ticket={row.original}>
                            <TableRow
                              className="ticket-row cursor-pointer data-[fresh=true]:animate-row-in data-[selected=true]:bg-primary/5 data-[active=true]:bg-muted/60 data-[active=true]:[&>td:first-child]:shadow-[inset_2px_0_0_var(--primary)]"
                              role="row"
                              data-id={row.id}
                              data-selected={row.getIsSelected()}
                              data-active={active === row.id || undefined}
                              data-fresh={seen.fresh.has(row.id) || undefined}
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
          {!tickets.error && tickets.data.total === 0 && (
            <EmptyState title={isDefault && !search.q ? "No tickets yet" : "No matching tickets"}>
              {!isDefault ? (
                <Button onClick={() => changeSearch(searchSchema.parse({}))}>Clear filters</Button>
              ) : (
                access.canWrite && (
                  <Button variant="default" onClick={() => setCreating({})}>
                    <Plus />
                    Create the first ticket
                  </Button>
                )
              )}
            </EmptyState>
          )}
        </div>
      )}
      {!tickets.isPending && !tickets.error && (
        <footer className="shrink-0 py-2 text-xs text-muted-foreground">
          {tickets.data.total} tickets
        </footer>
      )}
      <Modal
        size="composer"
        title="New ticket"
        open={creating !== null}
        onOpenChange={(open) => {
          if (!open) setCreating(null);
        }}
      >
        {creating && (
          <TicketEditor
            projectId={project.id}
            initial={creating}
            onSaved={() => setCreating(null)}
          />
        )}
      </Modal>
    </>
  );
}
