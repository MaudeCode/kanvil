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
import {
  ticketFilter,
  states,
  priorities,
  stateLabels,
  dueFilterLabels,
  sortLabels,
  defaultOrder,
} from "@kanvil/contracts";
import { api, ActorName, useIdentity } from "../data.tsx";
import {
  Button,
  Check,
  ErrorNotice,
  Input,
  Select,
  SelectItem,
  TicketIndicator,
  fieldClass,
} from "../ui.tsx";
import {
  searchSchema,
  ticketDensitySchema,
  ticketLabelDisplaySchema,
  ticketGroupingSchema,
  type TicketGrouping,
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
import { Kbd } from "@/components/ui/kbd";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TicketTag } from "./ticket-tags.tsx";
import { useShortcut } from "../hooks/use-shortcut.ts";

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
  grouping,
  onGroupingChange,
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
  grouping: TicketGrouping;
  onGroupingChange: (grouping: TicketGrouping) => void;
  view: ReactNode;
  actions: ReactNode;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false),
    [searchOpen, setSearchOpen] = useState(false),
    [labelsOpen, setLabelsOpen] = useState(false);
  useShortcut("/", () => setSearchOpen(true), { enabled: !searchOpen });
  const identity = useIdentity();
  const members = useQuery(api.query("list_members", { projectId }));
  const labels = useQuery({
    ...api.query("list_ticket_labels", { projectId, archived: search.archived }),
    enabled: filtersOpen,
  });
  const activeFilters = [
    search.status,
    search.priority,
    search.assigneeId,
    search.label,
    search.due,
    search.archived !== "exclude",
  ].filter(Boolean).length;
  const filter = (patch: Partial<TicketSearch>) => onSearch({ ...search, ...patch, offset: 0 });
  return (
    <>
      <div className="ticket-list-controls mb-0 flex min-h-12 min-w-0 items-center gap-1 border-b py-1 @max-[850px]:[&>[data-slot]]:px-2">
        <div className="mr-auto min-w-0 flex-1">{view}</div>
        <Popover open={searchOpen} onOpenChange={setSearchOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Search tickets"
                title="Search tickets (/)"
                className={search.q ? "text-primary" : undefined}
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
              onKeyDown={(event) => {
                if (event.key === "Enter") setSearchOpen(false);
              }}
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
            <span className="@max-[850px]:hidden">Filters</span>
            {activeFilters > 0 && (
              <Kbd className="h-4 min-w-4 bg-primary/10 px-1 text-[10px] text-primary">
                {activeFilters}
              </Kbd>
            )}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(20rem,calc(100vw-2rem))] p-4">
            <PopoverTitle>Filters</PopoverTitle>
            <div className="grid grid-cols-1">
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
              <Field className={fieldClass}>
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
                            <TicketTag tag={label.name} className="h-auto max-w-full" />
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
                label="Due"
                value={search.due ?? ""}
                onValueChange={(value) =>
                  filter({ due: value ? ticketFilter.shape.due.unwrap().parse(value) : undefined })
                }
              >
                <SelectItem value="">Any due date</SelectItem>
                {Object.entries(dueFilterLabels).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </Select>
              <Select
                label="Assignee"
                value={search.assigneeId ?? "any"}
                onValueChange={(value) =>
                  filter({
                    assigneeId:
                      value === "any" ? undefined : ticketFilter.shape.assigneeId.parse(value),
                  })
                }
              >
                <SelectItem value="any">Anyone</SelectItem>
                <SelectItem value={identity.id}>Me</SelectItem>
                <SelectItem value="none">Unassigned</SelectItem>
                {(members.data ?? [])
                  .filter((member) => member.userId !== identity.id)
                  .map((member) => (
                    <SelectItem key={member.userId} value={member.userId}>
                      {member.name}
                    </SelectItem>
                  ))}
              </Select>
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
            <span className="@max-[850px]:hidden">Display</span>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(19rem,calc(100vw-2rem))] gap-3 p-4">
            <PopoverTitle>Display</PopoverTitle>
            <Select
              label="Order by"
              value={search.sort}
              onValueChange={(value) =>
                filter({ sort: ticketFilter.shape.sort.parse(value), order: undefined })
              }
            >
              {Object.entries(sortLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </Select>
            <DisplayToggle
              label="Direction"
              value={search.order ?? defaultOrder[search.sort]}
              onChange={(value) => filter({ order: ticketFilter.shape.order.parse(value) })}
              options={[
                ["asc", "Ascending"],
                ["desc", "Descending"],
              ]}
            />
            <DisplayToggle
              label="Group by"
              value={grouping}
              onChange={(value) => onGroupingChange(ticketGroupingSchema.parse(value))}
              options={[
                ["status", "Status"],
                ["none", "None"],
              ]}
            />
            <Separator />
            <DisplayToggle
              label="Row spacing"
              value={density}
              onChange={(value) => onDensityChange(ticketDensitySchema.parse(value))}
              options={[
                ["compact", "Compact"],
                ["comfortable", "Comfortable"],
              ]}
            />
            <DisplayToggle
              label="Label display"
              value={labelDisplay}
              onChange={(value) => onLabelDisplayChange(ticketLabelDisplaySchema.parse(value))}
              options={[
                ["compact", "Compact preview"],
                ["all", "All labels"],
              ]}
            />
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
        <div
          className="active-filters mb-4 flex flex-wrap items-center gap-2 animate-in fade-in-0 slide-in-from-top-1 duration-150 [&_[data-slot=button]]:h-7 [&_[data-slot=button]]:text-xs"
          aria-label="Active ticket filters"
        >
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
          {search.assigneeId && (
            <Button variant="secondary" size="sm" onClick={() => filter({ assigneeId: undefined })}>
              {search.assigneeId === "none" ? (
                "Unassigned"
              ) : search.assigneeId === identity.id ? (
                "Assigned to me"
              ) : (
                <>
                  Assignee: <ActorName projectId={projectId} actorId={search.assigneeId} />
                </>
              )}
              <X className="size-3" />
            </Button>
          )}
          {search.label && (
            <Button variant="secondary" size="sm" onClick={() => filter({ label: undefined })}>
              Label: <TicketTag tag={search.label} />
              <X className="size-3" />
            </Button>
          )}
          {search.due && (
            <Button variant="secondary" size="sm" onClick={() => filter({ due: undefined })}>
              {dueFilterLabels[search.due]}
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

function DisplayToggle({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <Field className={fieldClass}>
      <FieldLabel>{label}</FieldLabel>
      <ToggleGroup
        aria-label={label}
        value={[value]}
        onValueChange={(next) => {
          const chosen = next[0];
          if (typeof chosen === "string") onChange(chosen);
        }}
        variant="outline"
        size="sm"
        spacing={0}
        className="w-full *:flex-1"
      >
        {options.map(([option, text]) => (
          <ToggleGroupItem key={option} value={option} aria-label={text}>
            {text}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  );
}
