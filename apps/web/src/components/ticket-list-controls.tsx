import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Check as CheckIcon,
  ChevronsUpDown,
  Columns3,
  SlidersHorizontal,
  Search,
  X,
} from "lucide-react";
import { z } from "zod";
import { ticketFilter, states, priorities, stateLabels } from "@kanvil/contracts";
import { api } from "../data.tsx";
import { Button, Check, ErrorNotice, Input, Select, SelectItem, TicketIndicator } from "../ui.tsx";
import {
  searchSchema,
  ticketDensitySchema,
  ticketLabelDisplaySchema,
  type TicketSearch,
  type TicketDensity,
  type TicketLabelDisplay,
} from "../search.ts";
import { Popover, PopoverTrigger, PopoverContent, PopoverTitle } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
import { Field, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";

// Extends the list's existing filter popover with personal display preferences.
export function TicketListControls({
  projectId,
  search,
  onSearch,
  columns,
  onColumnChange,
  onReset,
  density,
  onDensityChange,
  labelDisplay,
  onLabelDisplayChange,
  view,
  actions,
}: {
  projectId: string;
  search: TicketSearch;
  onSearch: (search: TicketSearch) => void;
  columns: { id: string; label: string; visible: boolean }[];
  onColumnChange: (id: string, visible: boolean) => void;
  onReset: () => void;
  density: TicketDensity;
  onDensityChange: (density: TicketDensity) => void;
  labelDisplay: TicketLabelDisplay;
  onLabelDisplayChange: (display: TicketLabelDisplay) => void;
  view: ReactNode;
  actions: ReactNode;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false),
    [labelsOpen, setLabelsOpen] = useState(false);
  const labels = useQuery({
    ...api.query("list_ticket_labels", { projectId, archived: search.archived }),
    enabled: filtersOpen,
  });
  const activeFilters = [
    search.status,
    search.priority,
    search.label,
    search.archived !== "exclude",
  ].filter(Boolean).length;
  const filter = (patch: Partial<TicketSearch>) => onSearch({ ...search, ...patch, offset: 0 });
  return (
    <>
      <div className="ticket-list-controls">
        <div className="ticket-view-picker">{view}</div>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Search tickets"
                title="Search tickets"
              />
            }
          >
            <Search />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-3">
            <Input
              label="Search tickets"
              type="search"
              placeholder="Search tickets…"
              value={search.q ?? ""}
              onChange={(event) => filter({ q: event.target.value })}
              autoFocus
            />
          </PopoverContent>
        </Popover>
        <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                aria-label={`Filters${activeFilters ? ` (${activeFilters})` : ""}`}
                title="Filters"
              />
            }
          >
            <SlidersHorizontal />
            <span className="ticket-control-label">
              Filters{activeFilters ? ` (${activeFilters})` : ""}
            </span>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(20rem,calc(100vw-2rem))] p-4">
            <PopoverTitle>Filters</PopoverTitle>
            <div className="filter-fields">
              <Select
                label="Status"
                value={search.status ?? ""}
                onValueChange={(value) =>
                  filter({ status: value ? z.enum(states).parse(value) : undefined })
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
                  filter({ priority: value ? z.enum(priorities).parse(value) : undefined })
                }
              >
                <SelectItem value="">All priorities</SelectItem>
                {priorities.map((priority) => (
                  <SelectItem key={priority} value={priority}>
                    <TicketIndicator property="priority" value={priority} />
                  </SelectItem>
                ))}
              </Select>
              <Field className="field">
                <FieldLabel>Label</FieldLabel>
                <Popover open={labelsOpen} onOpenChange={setLabelsOpen}>
                  <PopoverTrigger
                    render={
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-label="Label"
                        aria-expanded={labelsOpen}
                        className="w-full justify-between"
                      />
                    }
                  >
                    <span className="truncate">{search.label ?? "All labels"}</span>
                    <ChevronsUpDown className="shrink-0" />
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-[min(20rem,calc(100vw-3rem))] p-0">
                    <Command>
                      <CommandInput aria-label="Search labels" placeholder="Search labels…" />
                      <CommandList>
                        <CommandItem
                          value="All labels"
                          onSelect={() => {
                            filter({ label: undefined });
                            setLabelsOpen(false);
                          }}
                        >
                          All labels{!search.label && <CheckIcon className="ml-auto" />}
                        </CommandItem>
                        {labels.data?.map((label) => (
                          <CommandItem
                            key={label.name}
                            value={`label:${label.name}`}
                            keywords={[label.name]}
                            onSelect={() => {
                              filter({ label: label.name });
                              setLabelsOpen(false);
                            }}
                          >
                            <span className="min-w-0 break-words">{label.name}</span>
                            <span className="ml-auto text-xs text-muted-foreground">
                              {label.count}
                            </span>
                            {search.label === label.name && <CheckIcon />}
                          </CommandItem>
                        ))}
                        <CommandEmpty>
                          {labels.isPending ? "Loading labels…" : "No matching labels"}
                        </CommandEmpty>
                      </CommandList>
                    </Command>
                    <ErrorNotice error={labels.error} />
                  </PopoverContent>
                </Popover>
              </Field>
              <Select
                label="Archived"
                value={search.archived}
                onValueChange={(value) =>
                  filter({ archived: ticketFilter.shape.archived.parse(value) })
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
                onSearch(searchSchema.parse({ sort: search.sort }));
                setFiltersOpen(false);
              }}
            >
              Reset filters
            </Button>
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger render={<Button variant="ghost" aria-label="Display" title="Display" />}>
            <Columns3 />
            <span className="ticket-control-label">Display</span>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(19rem,calc(100vw-2rem))] gap-3 p-4">
            <PopoverTitle>Display</PopoverTitle>
            <Select
              label="Order by"
              value={search.sort}
              onValueChange={(value) => filter({ sort: ticketFilter.shape.sort.parse(value) })}
            >
              <SelectItem value="priority">Priority</SelectItem>
              <SelectItem value="updated">Recently updated</SelectItem>
              <SelectItem value="created">Recently created</SelectItem>
              <SelectItem value="title">Title A–Z</SelectItem>
              <SelectItem value="labels">Labels A–Z</SelectItem>
            </Select>
            <Separator />
            <Select
              label="Row spacing"
              value={density}
              onValueChange={(value) => onDensityChange(ticketDensitySchema.parse(value))}
            >
              <SelectItem value="compact">Compact</SelectItem>
              <SelectItem value="comfortable">Comfortable</SelectItem>
            </Select>
            <Select
              label="Label display"
              value={labelDisplay}
              onValueChange={(value) => onLabelDisplayChange(ticketLabelDisplaySchema.parse(value))}
            >
              <SelectItem value="compact">Compact preview</SelectItem>
              <SelectItem value="all">All labels</SelectItem>
            </Select>
            <fieldset>
              <legend className="mb-2 text-xs font-medium text-muted-foreground">Properties</legend>
              <div className="grid grid-cols-2 gap-x-3">
                {columns.map((column) => (
                  <Check
                    key={column.id}
                    label={column.label}
                    checked={column.visible}
                    onCheckedChange={(checked) => onColumnChange(column.id, checked)}
                  />
                ))}
              </div>
            </fieldset>
            <Separator />
            <Button variant="ghost" onClick={onReset}>
              Reset display
            </Button>
          </PopoverContent>
        </Popover>
        {actions}
      </div>
      {(search.q || activeFilters > 0) && (
        <div className="active-filters" aria-label="Active ticket filters">
          {search.q && (
            <Button variant="secondary" size="sm" onClick={() => filter({ q: undefined })}>
              Search: {search.q}
              <X className="size-3" />
            </Button>
          )}
          {search.status && (
            <Button variant="secondary" size="sm" onClick={() => filter({ status: undefined })}>
              {stateLabels[search.status]}
              <X className="size-3" />
            </Button>
          )}
          {search.priority && (
            <Button variant="secondary" size="sm" onClick={() => filter({ priority: undefined })}>
              <TicketIndicator property="priority" value={search.priority} /> priority
              <X className="size-3" />
            </Button>
          )}
          {search.label && (
            <Button variant="secondary" size="sm" onClick={() => filter({ label: undefined })}>
              Label: {search.label}
              <X className="size-3" />
            </Button>
          )}
          {search.archived !== "exclude" && (
            <Button variant="secondary" size="sm" onClick={() => filter({ archived: "exclude" })}>
              {search.archived === "only" ? "Archived only" : "Including archived"}
              <X className="size-3" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onSearch(searchSchema.parse({ sort: search.sort }))}
          >
            Clear filters
          </Button>
        </div>
      )}
    </>
  );
}
