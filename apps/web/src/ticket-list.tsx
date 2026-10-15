import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
  Check,
  Confirm,
  ErrorNotice,
  Input,
  Loading,
  Modal,
  Select,
  Status,
} from "./ui.tsx";
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
        onChange={table.getToggleAllRowsSelectedHandler()}
      />
    ),
    cell: ({ row }) => (
      <Check
        label={`Select ${row.original.key}`}
        className="sr-checkbox"
        checked={row.getIsSelected()}
        onChange={row.getToggleSelectedHandler()}
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
          <span className="eyebrow">{project.key}</span>
          <h1>{project.name}</h1>
        </div>
        <div className="actions">
          <Link to="/projects/$projectId/settings" params={{ projectId: project.id }}>
            Project settings
          </Link>
          <Button
            className="primary"
            disabled={!access.canWrite}
            onClick={() => setCreateOpen(true)}
          >
            New ticket
          </Button>
        </div>
      </header>
      <div className="toolbar">
        <Input
          label="Search tickets"
          placeholder="Title, description, or key"
          value={search.q ?? ""}
          onChange={(event) => filter({ q: event.target.value })}
        />
        <Select
          label="Status"
          value={search.status ?? ""}
          onChange={(event) =>
            filter({
              status: event.target.value ? z.enum(states).parse(event.target.value) : undefined,
            })
          }
        >
          <option value="">All statuses</option>
          {states.map((status) => (
            <option key={status} value={status}>
              {stateLabels[status]}
            </option>
          ))}
        </Select>
        <Select
          label="Priority"
          value={search.priority ?? ""}
          onChange={(event) =>
            filter({
              priority: event.target.value
                ? z.enum(priorities).parse(event.target.value)
                : undefined,
            })
          }
        >
          <option value="">All priorities</option>
          {priorities.map((priority) => (
            <option key={priority} value={priority}>
              {priorityLabels[priority]}
            </option>
          ))}
        </Select>
        <Select
          label="Sort"
          value={search.sort}
          onChange={(event) => filter({ sort: ticketFilter.shape.sort.parse(event.target.value) })}
        >
          <option value="priority">Priority</option>
          <option value="updated">Updated</option>
          <option value="created">Created</option>
          <option value="title">Title</option>
        </Select>
        <Select
          label="Archived"
          value={search.archived}
          onChange={(event) =>
            filter({ archived: ticketFilter.shape.archived.parse(event.target.value) })
          }
        >
          <option value="exclude">Hide archived</option>
          <option value="include">Include archived</option>
          <option value="only">Archived only</option>
        </Select>
      </div>
      <div className="views">
        <span className="muted">Views</span>
        <Button onClick={() => onSearch(searchSchema.parse({}))}>All tickets</Button>
        {views.data?.map((view) => (
          <span className="view" key={view.id}>
            <Button onClick={() => onSearch({ ...view.filters, offset: 0 })}>{view.name}</Button>
            <Button
              aria-label={`Delete view ${view.name}`}
              onClick={() => deleteView.mutate({ projectId: project.id, viewId: view.id })}
            >
              ×
            </Button>
          </span>
        ))}
        <Modal title="Save view" trigger="Save current view">
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
            onChange={(event) => setBulkStatus(z.enum(states).parse(event.target.value))}
          >
            {states.map((status) => (
              <option key={status} value={status}>
                {stateLabels[status]}
              </option>
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
          <table style={{ width: table.getTotalSize() }}>
            <thead>
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id}>
                  {group.headers.map((header) => (
                    <th key={header.id} scope="col" style={{ width: header.getSize() }}>
                      <table.FlexRender header={header} />
                      {header.column.getCanResize() && (
                        <button
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
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id} data-selected={row.getIsSelected()}>
                  {row.getAllCells().map((cell) => (
                    <td key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {tickets.data?.total === 0 && <p className="empty">No matching tickets</p>}
        </div>
      )}
      <footer className="pagination">
        <span>
          {tickets.data?.total ?? 0} tickets · {search.offset + 1}–
          {search.offset + (tickets.data?.items.length ?? 0)}
        </span>
        <Button
          disabled={search.offset === 0}
          onClick={() => onSearch({ ...search, offset: Math.max(0, search.offset - 50) })}
        >
          Previous
        </Button>
        <Button
          disabled={search.offset + 50 >= (tickets.data?.total ?? 0)}
          onClick={() => onSearch({ ...search, offset: search.offset + 50 })}
        >
          Next
        </Button>
      </footer>
      <Modal title="New ticket" open={createOpen} onOpenChange={setCreateOpen}>
        {createOpen && <TicketEditor projectId={project.id} onSaved={() => setCreateOpen(false)} />}
      </Modal>
    </>
  );
}
