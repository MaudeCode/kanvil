import { ProjectIcon } from "./components/project-icon.tsx";
import { toast } from "sonner";
import { TicketContextMenu } from "./components/object-context-menu.tsx";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, Settings, X, BookmarkPlus, ArrowLeft, ArrowRight } from "lucide-react";
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
import { ticketFilter, priorityLabels, type Ticket, type Project } from "@kanvil/contracts";
import { api, date, ActorName, useIdentity, useProjectAccess, useOperation } from "./data.tsx";
import {
  Button,
  IconButton,
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
import { Badge } from "@/components/ui/badge";
import { TicketListControls } from "./components/ticket-list-controls.tsx";
import { TicketSelectionToolbar } from "./components/ticket-selection-toolbar.tsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TicketEditor } from "./ticket-editor.tsx";

import { searchSchema, type TicketSearch } from "./search.ts";
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
          <div className="flex flex-wrap gap-1">
            {row.original[key].map((tag) => (
              <Badge
                variant={key === "labels" ? "secondary" : "outline"}
                className="h-auto max-w-full whitespace-normal break-words"
                key={tag}
              >
                {tag}
              </Badge>
            ))}
          </div>
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
    } catch {
      /* Display controls work without storage. */
    }
  }, [storageKey, visibility]);
  const tickets = useQuery(
    api.query("list_tickets", { projectId: project.id, ...search, limit: 50 }),
  );
  const views = useQuery(api.query("list_views", { projectId: project.id }));
  const saveView = useOperation("save_view"),
    deleteView = useOperation("delete_view");
  const [createOpen, setCreateOpen] = useState(false);
  const [viewName, setViewName] = useState(""),
    [savingView, setSavingView] = useState(false);
  const currentFilters = ticketFilter.parse(
      Object.fromEntries(Object.entries(search).filter(([key]) => key !== "offset")),
    ),
    isDefault = JSON.stringify(currentFilters) === JSON.stringify(ticketFilter.parse({}));
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
      <header className="page-header">
        <div>
          <div className="project-title">
            <ProjectIcon project={project} className="size-7" />
            <span className="project-prefix">{project.key}</span>
            <h1>{project.name}</h1>
          </div>
        </div>
        <div className="actions">
          <IconButton
            label="Project settings"
            render={<Link to="/projects/$projectId/settings" params={{ projectId: project.id }} />}
          >
            <Settings />
          </IconButton>
          <Button variant="default" disabled={!access.canWrite} onClick={() => setCreateOpen(true)}>
            <Plus size={17} aria-hidden="true" />
            New ticket
          </Button>
        </div>
      </header>
      <TicketListControls
        projectId={project.id}
        search={search}
        onSearch={changeSearch}
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
          changeSearch({ ...search, sort: "priority", offset: 0 });
        }}
      />
      <div className="views">
        <Tabs value={isDefault ? "tickets" : "custom"}>
          <TabsList variant="line">
            <TabsTrigger value="tickets" onClick={() => changeSearch(searchSchema.parse({}))}>
              All tickets
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {views.data?.map((view) => (
          <span className="view" key={view.id}>
            <Button
              variant={
                JSON.stringify(currentFilters) === JSON.stringify(ticketFilter.parse(view.filters))
                  ? "secondary"
                  : "ghost"
              }
              aria-pressed={
                JSON.stringify(currentFilters) === JSON.stringify(ticketFilter.parse(view.filters))
              }
              onClick={() => changeSearch({ ...view.filters, offset: 0 })}
            >
              {view.name}
            </Button>
            <Confirm
              label={`Delete view ${view.name}`}
              icon={<X />}
              description={`Remove ${view.name} from saved views? Tickets stay unchanged.`}
              onConfirm={() => deleteView.mutateAsync({ projectId: project.id, viewId: view.id })}
            />
          </span>
        ))}
        <Modal
          title="Save view"
          open={savingView}
          onOpenChange={setSavingView}
          busy={saveView.isPending}
          trigger={
            <>
              <BookmarkPlus />
              Save current view
            </>
          }
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
      </div>
      <ErrorNotice error={tickets.error ?? deleteView.error} />
      {selected.length > 0 && (
        <TicketSelectionToolbar selected={selected} onClear={() => table.resetRowSelection()} />
      )}
      {tickets.isPending ? (
        <Loading />
      ) : (
        <div className="table-scroll">
          <Table
            className="ticket-table @min-[1051px]:w-(--table-width)"
            role="table"
            aria-label="Tickets"
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
