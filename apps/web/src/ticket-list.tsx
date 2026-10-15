import { TicketContextMenu } from "./components/object-context-menu.tsx";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Plus,
  SlidersHorizontal,
  Settings,
  X,
  BookmarkPlus,
  ArrowLeft,
  ArrowRight,
} from "lucide-react";
import {
  useTable,
  tableFeatures,
  columnSizingFeature,
  columnResizingFeature,
  rowSelectionFeature,
  type ColumnDef,
} from "@tanstack/react-table";
import { z } from "zod";
import {
  ticketFilter,
  states,
  priorities,
  stateLabels,
  priorityLabels,
  type Ticket,
  type Project,
} from "@kanvil/contracts";
import { api, useProjectAccess, useOperation } from "./data.tsx";
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
  Select,
  SelectItem,
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
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TicketEditor } from "./ticket-editor.tsx";

import { searchSchema, type TicketSearch } from "./search.ts";
const features = tableFeatures({ columnSizingFeature, columnResizingFeature, rowSelectionFeature });
const columns: ColumnDef<typeof features, Ticket>[] = [
  {
    id: "select",
    size: 44,
    enableResizing: false,
    header: ({ table }) => (
      <Check
        label="Select all displayed tickets"
        className="sr-checkbox"
        checked={table.getIsAllRowsSelected()}
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
  { accessorKey: "key", header: "Ticket", size: 112, minSize: 90 },
  {
    accessorKey: "title",
    header: "Title",
    size: 500,
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
  {
    accessorKey: "status",
    header: "Status",
    size: 150,
    minSize: 120,
    cell: ({ row }) => <Status value={row.original.status} />,
  },
  {
    accessorKey: "priority",
    header: "Priority",
    size: 105,
    minSize: 90,
    cell: ({ row }) => priorityLabels[row.original.priority],
  },
  {
    accessorKey: "difficulty",
    header: "Difficulty",
    size: 100,
    minSize: 90,
    cell: ({ row }) => row.original.difficulty ?? "—",
  },
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
  const tickets = useQuery(
    api.query("list_tickets", { projectId: project.id, ...search, limit: 50 }),
  );
  const views = useQuery(api.query("list_views", { projectId: project.id }));
  const bulk = useOperation("bulk_update_tickets"),
    saveView = useOperation("save_view"),
    deleteView = useOperation("delete_view");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = [search.status, search.priority, search.archived !== "exclude"].filter(
    Boolean,
  ).length;
  const [createOpen, setCreateOpen] = useState(false),
    [bulkStatus, setBulkStatus] = useState<Ticket["status"]>("todo");
  const [viewName, setViewName] = useState("");
  const table = useTable({
    features,
    columns,
    data: tickets.data?.items ?? [],
    getRowId: (row) => row.id,
    columnResizeMode: "onChange",
    enableRowSelection: access.canWrite,
  });
  const selected = table.getSelectedRowModel().rows.map((row) => row.original);
  const filter = (patch: Partial<TicketSearch>) => onSearch({ ...search, ...patch, offset: 0 });
  return (
    <>
      <header className="page-header">
        <div>
          <div className="project-title">
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
      <div className="toolbar">
        <Input
          label="Search tickets"
          type="search"
          placeholder="Title, description, or key"
          value={search.q ?? ""}
          onChange={(event) => filter({ q: event.target.value })}
        />
        <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
          <PopoverTrigger render={<Button variant="outline" />}>
            <SlidersHorizontal />
            Filters{activeFilters ? ` (${activeFilters})` : ""}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80">
            <h3>Filters</h3>
            <div className="filter-fields">
              <Select
                label="Status"
                value={search.status ?? ""}
                onValueChange={(value) =>
                  filter({
                    status: (value ?? "") ? z.enum(states).parse(value ?? "") : undefined,
                  })
                }
              >
                <SelectItem value="">All statuses</SelectItem>
                {states.map((status) => (
                  <SelectItem key={status} value={status}>
                    {stateLabels[status]}
                  </SelectItem>
                ))}
              </Select>
              <Select
                label="Priority"
                value={search.priority ?? ""}
                onValueChange={(value) =>
                  filter({
                    priority: (value ?? "") ? z.enum(priorities).parse(value ?? "") : undefined,
                  })
                }
              >
                <SelectItem value="">All priorities</SelectItem>
                {priorities.map((priority) => (
                  <SelectItem key={priority} value={priority}>
                    {priorityLabels[priority]}
                  </SelectItem>
                ))}
              </Select>
              <Select
                label="Sort"
                value={search.sort}
                onValueChange={(value) =>
                  filter({ sort: ticketFilter.shape.sort.parse(value ?? "") })
                }
              >
                <SelectItem value="priority">Priority</SelectItem>
                <SelectItem value="updated">Updated</SelectItem>
                <SelectItem value="created">Created</SelectItem>
                <SelectItem value="title">Title</SelectItem>
              </Select>
              <Select
                label="Archived"
                value={search.archived}
                onValueChange={(value) =>
                  filter({ archived: ticketFilter.shape.archived.parse(value ?? "") })
                }
              >
                <SelectItem value="exclude">Hide archived</SelectItem>
                <SelectItem value="include">Include archived</SelectItem>
                <SelectItem value="only">Archived only</SelectItem>
              </Select>
            </div>
            <Button
              variant="ghost"
              onClick={() => {
                onSearch(searchSchema.parse({}));
                setFiltersOpen(false);
              }}
            >
              Reset filters
            </Button>
          </PopoverContent>
        </Popover>
      </div>
      <div className="views">
        <Tabs value="tickets">
          <TabsList variant="line">
            <TabsTrigger value="tickets" onClick={() => onSearch(searchSchema.parse({}))}>
              All tickets
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {views.data?.map((view) => (
          <span className="view" key={view.id}>
            <Button onClick={() => onSearch({ ...view.filters, offset: 0 })}>{view.name}</Button>
            <IconButton
              label={`Delete view ${view.name}`}
              onClick={() => deleteView.mutate({ projectId: project.id, viewId: view.id })}
            >
              <X />
            </IconButton>
          </span>
        ))}
        <Modal
          title="Save view"
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
              saveView.mutate({
                projectId: project.id,
                name: viewName,
                filters: ticketFilter.parse(
                  Object.fromEntries(Object.entries(search).filter(([key]) => key !== "offset")),
                ),
              });
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
            {saveView.isSuccess && <p role="status">View saved</p>}
          </form>
        </Modal>
      </div>
      <ErrorNotice error={tickets.error ?? bulk.error ?? deleteView.error} />
      {selected.length > 0 && (
        <div className="bulk">
          <strong>{selected.length} selected</strong>
          <Select
            label="New status"
            value={bulkStatus}
            onValueChange={(value) => setBulkStatus(z.enum(states).parse(value ?? ""))}
          >
            {states.map((status) => (
              <SelectItem key={status} value={status}>
                {stateLabels[status]}
              </SelectItem>
            ))}
          </Select>
          <Button
            disabled={bulk.isPending}
            onClick={() => {
              void bulk
                .mutateAsync({
                  projectId: project.id,
                  tickets: selected.map((ticket) => ({
                    ticketId: ticket.id,
                    expectedVersion: ticket.version,
                  })),
                  changes: { status: bulkStatus },
                })
                .then(() => table.resetRowSelection())
                .catch(() => {});
            }}
          >
            Apply status
          </Button>
          <Confirm
            label="Archive selected"
            description={`Archive ${selected.length} selected tickets?`}
            onConfirm={() =>
              bulk
                .mutateAsync({
                  projectId: project.id,
                  tickets: selected.map((ticket) => ({
                    ticketId: ticket.id,
                    expectedVersion: ticket.version,
                  })),
                  changes: { archived: true },
                })
                .then(() => table.resetRowSelection())
            }
          />
          <Button onClick={() => table.resetRowSelection()}>Clear selection</Button>
        </div>
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
                    {row.getAllCells().map((cell) => (
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
          {tickets.data?.total === 0 && <EmptyState title="No matching tickets" />}
        </div>
      )}
      <footer className="pagination">
        <span>
          {tickets.data?.total ?? 0} tickets · {tickets.data?.total ? search.offset + 1 : 0}–
          {search.offset + (tickets.data?.items.length ?? 0)}
        </span>
        <Button
          disabled={search.offset === 0}
          onClick={() => onSearch({ ...search, offset: Math.max(0, search.offset - 50) })}
        >
          <ArrowLeft />
          Previous
        </Button>
        <Button
          disabled={search.offset + 50 >= (tickets.data?.total ?? 0)}
          onClick={() => onSearch({ ...search, offset: search.offset + 50 })}
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
