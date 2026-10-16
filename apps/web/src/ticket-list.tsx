import { toast } from "sonner";
import { TicketContextMenu } from "./components/object-context-menu.tsx";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, ChevronDown, BookmarkPlus, Trash2, ArrowLeft, ArrowRight } from "lucide-react";
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
  priorityLabels,
  type Ticket,
  type Project,
  type Output,
} from "@kanvil/contracts";
import { api, date, ActorName, useIdentity, useProjectAccess, useOperation } from "./data.tsx";
import {
  Button,
  EmptyState,
  Check,
  Confirm,
  ErrorNotice,
  Input,
  Loading,
  Modal,
  Status,
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

import {
  searchSchema,
  ticketDensitySchema,
  ticketLabelDisplaySchema,
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
const defaultVisibility = {
  kind: false,
  scopes: false,
  assigneeId: false,
  createdAt: false,
  updatedAt: false,
};
function readDisplayPreference<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const result = schema.safeParse(localStorage.getItem(key));
    return result.success ? result.data : fallback;
  } catch {
    return fallback;
  }
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
        className="ticket-title"
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
        size: 190,
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
    size: 125,
    minSize: 110,
    cell: ({ row }) => <Status value={row.original.status} />,
  },
  {
    accessorKey: "priority",
    header: "Priority",
    size: 95,
    minSize: 90,
    cell: ({ row }) => priorityLabels[row.original.priority],
  },
  {
    accessorKey: "difficulty",
    header: "Difficulty",
    size: 95,
    minSize: 85,
    cell: ({ row }) => row.original.difficulty ?? "—",
  },
  { accessorKey: "kind", header: "Kind", size: 110 },
  {
    accessorKey: "assigneeId",
    header: "Assignee",
    size: 160,
    cell: ({ row }) =>
      row.original.assigneeId ? (
        <ActorName projectId={row.original.projectId} actorId={row.original.assigneeId} />
      ) : (
        "Unassigned"
      ),
  },
  ...(["createdAt", "updatedAt"] as const).map(
    (key) =>
      ({
        accessorKey: key,
        header: key === "createdAt" ? "Created" : "Updated",
        size: 170,
        cell: ({ row }) => date(row.original[key]),
      }) satisfies ColumnDef<typeof features, Ticket>,
  ),
];
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
  const storageKey = `kanvil:${identity.id}:ticket-columns`;
  const densityKey = `kanvil:${identity.id}:ticket-density`;
  const labelDisplayKey = `kanvil:${identity.id}:ticket-label-display`;
  const [labelDisplay, setLabelDisplay] = useState<TicketLabelDisplay>(() =>
    readDisplayPreference(labelDisplayKey, ticketLabelDisplaySchema, "compact"),
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
    } catch {
      /* Display controls work without storage. */
    }
  }, [storageKey, visibility, densityKey, density, labelDisplayKey, labelDisplay]);
  const tickets = useQuery(
    api.query("list_tickets", { projectId: project.id, ...search, limit: 50 }),
  );
  const views = useQuery(api.query("list_views", { projectId: project.id }));
  const saveView = useOperation("save_view"),
    deleteView = useOperation("delete_view");
  const [createOpen, setCreateOpen] = useState(false);
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
  const changeSearch = (next: TicketSearch) => {
    table.resetRowSelection();
    onSearch(next);
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
          <Button
            variant="default"
            aria-label="New ticket"
            title="New ticket"
            disabled={!access.canWrite}
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={17} aria-hidden="true" />
            <span className="ticket-control-label">New ticket</span>
          </Button>
        }
        density={density}
        onDensityChange={setDensity}
        labelDisplay={labelDisplay}
        onLabelDisplayChange={setLabelDisplay}
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
          changeSearch({ ...search, sort: "priority", offset: 0 });
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
          <ErrorNotice error={saveView.error} />
          <Button type="submit" disabled={saveView.isPending}>
            Save view
          </Button>
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
      ) : (
        <div className="table-scroll">
          <Table
            className="ticket-table min-w-full @min-[1051px]:w-(--table-width)"
            role="table"
            aria-label="Tickets"
            data-density={density}
            data-label-display={labelDisplay}
            style={{ "--table-width": `${table.getTotalSize()}px` }}
          >
            <TableHeader role="rowgroup">
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} role="row">
                  {group.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      role="columnheader"
                      scope="col"
                      data-column={header.column.id}
                      style={{ width: header.getSize() }}
                    >
                      <table.FlexRender header={header} />
                      {header.column.getCanResize() && (
                        <Button
                          variant="ghost"
                          className="resizer"
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
                                  header.column.getSize() + (event.key === "ArrowRight" ? 20 : -20),
                                ),
                              }));
                            }
                          }}
                        />
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody role="rowgroup">
              {table.getRowModel().rows.map((row) => (
                <TicketContextMenu key={row.id} ticket={row.original}>
                  <TableRow role="row" data-selected={row.getIsSelected()}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        className="in-data-[density=comfortable]:py-4"
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
          {tickets.data?.total === 0 && (
            <EmptyState title={isDefault && !search.q ? "No tickets yet" : "No matching tickets"}>
              {!isDefault && (
                <Button onClick={() => changeSearch(searchSchema.parse({}))}>Clear filters</Button>
              )}
            </EmptyState>
          )}
        </div>
      )}
      <footer className="pagination ticket-pagination">
        <span>
          {tickets.data?.total ?? 0} tickets · {tickets.data?.total ? search.offset + 1 : 0}–
          {search.offset + (tickets.data?.items.length ?? 0)}
        </span>
        <Button
          disabled={search.offset === 0}
          onClick={() => changeSearch({ ...search, offset: Math.max(0, search.offset - 50) })}
        >
          <ArrowLeft />
          Previous
        </Button>
        <Button
          disabled={search.offset + 50 >= (tickets.data?.total ?? 0)}
          onClick={() => changeSearch({ ...search, offset: search.offset + 50 })}
        >
          Next
          <ArrowRight />
        </Button>
      </footer>
      <Modal title="New ticket" open={createOpen} onOpenChange={setCreateOpen}>
        {createOpen && <TicketEditor projectId={project.id} onSaved={() => setCreateOpen(false)} />}
      </Modal>
    </>
  );
}
