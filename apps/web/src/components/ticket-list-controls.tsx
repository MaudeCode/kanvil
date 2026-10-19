import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDown, Columns3, SlidersHorizontal, X } from "lucide-react";
import {
  ticketFilter,
  states,
  priorities,
  stateLabels,
  priorityLabels,
  dueFilterLabels,
  sortLabels,
  defaultOrder,
  filterFieldLabels,
  filterKey,
  filterList,
  ticketPredicates,
  type FilterField,
  type FilterOperator,
} from "@kanvil/contracts";
import { api, ActorName, useIdentity } from "../data.tsx";
import {
  Button,
  Check,
  ErrorNotice,
  Select,
  SelectItem,
  SearchField,
  fieldClass,
  IconButton,
} from "../ui.tsx";
import {
  searchSchema,
  ticketColumnLabels,
  ticketDensitySchema,
  ticketLabelDisplaySchema,
  ticketGroupingSchema,
  workGroupingSchema,
  type TicketSearch,
} from "../search.ts";
import { preferences, usePreference } from "../hooks/use-preference.ts";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TicketTag } from "./ticket-tags.tsx";
import { PropertyValue, difficultyLabels, kindLabels } from "./ticket-property.tsx";
import { cn } from "@/lib/utils";

// Extends the list's existing filter popover with personal display preferences.
export function TicketListControls({
  projectId,
  search,
  onSearch,
  onReset,
  view,
  actions,
}: {
  // Without a project (My work), the project-scoped filters are hidden.
  projectId: string | undefined;
  search: TicketSearch;
  onSearch: (search: TicketSearch) => void;
  onReset: () => void;
  view: ReactNode;
  actions: ReactNode;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const identity = useIdentity();
  const members = useQuery({
    ...api.query("list_members", { projectId: projectId ?? "" }),
    enabled: !!projectId,
  });
  const labels = useQuery({
    ...api.query("list_ticket_labels", { projectId: projectId ?? "", archived: search.archived }),
    enabled: filtersOpen && !!projectId,
  });
  const predicates = ticketPredicates(search);
  const activeFilters =
    predicates.length + [search.due, search.archived !== "exclude"].filter(Boolean).length;
  const filter = (patch: Partial<TicketSearch>) => onSearch({ ...search, ...patch, offset: 0 });
  // Replaces one field's predicate; both operators clear first so a value is never in both.
  const setPredicate = (field: FilterField, operator: FilterOperator, values: string[]) =>
    onSearch(
      searchSchema.parse({
        ...search,
        [field]: undefined,
        [filterKey(field, "none")]: undefined,
        ...(values.length ? { [filterKey(field, operator)]: values } : {}),
        offset: 0,
      }),
    );
  const projectKey = projectId ?? "";
  const choices: Record<"status" | "priority" | "label" | "assigneeId", FilterChoice[]> = {
    status: states.map((status) => ({
      value: status,
      text: stateLabels[status],
      node: <PropertyValue property="status" value={status} projectId={projectKey} />,
    })),
    priority: priorities.map((priority) => ({
      value: priority,
      text: priorityLabels[priority],
      node: <PropertyValue property="priority" value={priority} projectId={projectKey} />,
    })),
    label: (labels.data ?? []).map((label) => ({
      value: label.name,
      text: label.name,
      node: <TicketTag tag={label.name} className="h-auto max-w-full" />,
      count: label.count,
    })),
    assigneeId: [
      { value: identity.id, text: "Me" },
      { value: "none", text: "Unassigned" },
      ...(members.data ?? [])
        .filter((member) => member.userId !== identity.id)
        .map((member) => ({ value: member.userId, text: member.name, keywords: [member.email] })),
    ],
  };
  // Kind and difficulty have no picker here, but links and the API can still set them.
  const valueNames: Record<FilterField, Record<string, string>> = {
    status: stateLabels,
    priority: priorityLabels,
    kind: kindLabels,
    difficulty: difficultyLabels,
    label: {},
    assigneeId: Object.fromEntries(choices.assigneeId.map((choice) => [choice.value, choice.text])),
  };
  const chipValue = (field: FilterField, value: string) =>
    field === "label" ? (
      <TicketTag tag={value} />
    ) : field === "assigneeId" && !valueNames.assigneeId[value] ? (
      <ActorName projectId={projectKey} actorId={value} />
    ) : (
      (valueNames[field][value] ?? value)
    );
  return (
    <>
      <div className="ticket-list-controls mb-0 flex min-h-12 min-w-0 items-center gap-1 border-b py-1 @max-[850px]:[&>[data-slot]]:px-2">
        <div className="mr-auto min-w-0 flex-1">{view}</div>
        <SearchField
          label="Search tickets"
          placeholder="Search tickets…"
          shortcut="/"
          value={search.q ?? ""}
          onChange={(value) => filter({ q: value })}
          className={cn("shrink-0", search.q && "[&_[data-slot=button]]:text-primary")}
        />
        {projectId && (
          <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
            <PopoverTrigger
              render={
                <IconButton
                  label={`Filters${activeFilters ? ` (${activeFilters})` : ""}`}
                  className={cn("relative", activeFilters > 0 && "text-primary")}
                />
              }
            >
              <SlidersHorizontal />
              {activeFilters > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none text-primary-foreground tabular-nums"
                >
                  {activeFilters}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(20rem,calc(100vw-2rem))] p-4">
              <PopoverTitle>Filters</PopoverTitle>
              <div className="grid grid-cols-1">
                {(["status", "priority", "label"] as const).map((field) => (
                  <FilterPicker
                    key={field}
                    field={field}
                    search={search}
                    choices={choices[field]}
                    onChange={setPredicate}
                    loading={field === "label" && labels.isPending}
                    error={field === "label" ? labels.error : null}
                  />
                ))}
                <Select
                  label="Due"
                  value={search.due ?? ""}
                  onValueChange={(value) =>
                    filter({
                      due: value ? ticketFilter.shape.due.unwrap().parse(value) : undefined,
                    })
                  }
                >
                  <SelectItem value="">Any due date</SelectItem>
                  {Object.entries(dueFilterLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </Select>
                <FilterPicker
                  field="assigneeId"
                  search={search}
                  choices={choices.assigneeId}
                  onChange={setPredicate}
                />
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
        )}
        <Popover>
          <PopoverTrigger render={<IconButton label="Display" />}>
            <Columns3 />
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
            <TicketDisplayPreferences work={!projectId} />
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
          {predicates.map(({ field, operator, values }) => (
            <Button
              key={filterKey(field, operator)}
              variant="secondary"
              size="sm"
              onClick={() => setPredicate(field, operator, [])}
            >
              {filterFieldLabels[field]}
              {operator === "none" ? " is not" : ""}:{" "}
              {values.map((value, index) => (
                <span key={value} className="inline-flex items-center">
                  {chipValue(field, value)}
                  {/* Label tags are separate shapes; text values need a comma. */}
                  {field !== "label" && index < values.length - 1 && ","}
                </span>
              ))}
              <X className="size-3" />
            </Button>
          ))}
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

type FilterChoice = {
  value: string;
  text: string;
  node?: ReactNode;
  keywords?: string[];
  count?: number;
};
// The clearing choice and the search box name for each field.
const fieldText: Record<FilterField, { any: string; search: string }> = {
  status: { any: "All statuses", search: "Search statuses" },
  priority: { any: "All priorities", search: "Search priorities" },
  kind: { any: "All kinds", search: "Search kinds" },
  difficulty: { any: "All difficulties", search: "Search difficulties" },
  label: { any: "All labels", search: "Search labels" },
  assigneeId: { any: "Anyone", search: "Search people" },
};
// A searchable multi-select for one filter field. "Is" keeps tickets with any chosen value;
// "Is not" keeps tickets with none of them.
function FilterPicker({
  field,
  search,
  choices,
  onChange,
  loading = false,
  error = null,
}: {
  field: FilterField;
  search: TicketSearch;
  choices: FilterChoice[];
  onChange: (field: FilterField, operator: FilterOperator, values: string[]) => void;
  loading?: boolean;
  error?: unknown;
}) {
  const [open, setOpen] = useState(false),
    // The chosen operator before any value is picked; once values exist the URL decides.
    [mode, setMode] = useState<FilterOperator>("any");
  const label = filterFieldLabels[field];
  const excluded = filterList(search[filterKey(field, "none")]),
    included = filterList(search[field]);
  const operator: FilterOperator = excluded.length ? "none" : included.length ? "any" : mode;
  const selected: string[] = operator === "none" ? excluded : included;
  const names = selected.map(
    (value) => choices.find((choice) => choice.value === value)?.text ?? value,
  );
  return (
    <Field className={fieldClass}>
      <FieldLabel>{label}</FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              role="combobox"
              aria-label={label}
              aria-expanded={open}
              className="h-8 w-full justify-between font-normal"
            />
          }
        >
          <span className="truncate">
            {names.length
              ? `${operator === "none" ? "Not " : ""}${names.join(", ")}`
              : fieldText[field].any}
          </span>
          <ChevronsUpDown className="shrink-0" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(20rem,calc(100vw-3rem))] p-0">
          <ToggleGroup
            aria-label={`${label} match`}
            value={[operator]}
            onValueChange={(next) => {
              const chosen = next[0];
              if (chosen !== "any" && chosen !== "none") return;
              setMode(chosen);
              if (selected.length) onChange(field, chosen, selected);
            }}
            variant="outline"
            size="sm"
            spacing={0}
            className="w-full p-2 pb-0 *:flex-1"
          >
            <ToggleGroupItem value="any">Is</ToggleGroupItem>
            <ToggleGroupItem value="none">Is not</ToggleGroupItem>
          </ToggleGroup>
          <Command>
            <CommandInput
              aria-label={fieldText[field].search}
              placeholder={`${fieldText[field].search}…`}
            />
            <CommandList>
              <CommandItem
                value={fieldText[field].any}
                data-checked={!selected.length}
                aria-checked={!selected.length}
                onSelect={() => {
                  onChange(field, operator, []);
                  setOpen(false);
                }}
              >
                {fieldText[field].any}
              </CommandItem>
              {choices.map((choice) => {
                const checked = selected.includes(choice.value);
                return (
                  <CommandItem
                    key={choice.value}
                    value={`${field}:${choice.value}`}
                    keywords={[choice.text, ...(choice.keywords ?? [])]}
                    data-checked={checked}
                    aria-checked={checked}
                    aria-label={choice.text}
                    onSelect={() =>
                      onChange(
                        field,
                        operator,
                        checked
                          ? selected.filter((value) => value !== choice.value)
                          : [...selected, choice.value],
                      )
                    }
                  >
                    {choice.node ?? <span className="truncate">{choice.text}</span>}
                    {choice.count !== undefined && (
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                        {choice.count}
                      </span>
                    )}
                  </CommandItem>
                );
              })}
              <CommandEmpty>{loading ? "Loading…" : "No matches"}</CommandEmpty>
            </CommandList>
          </Command>
          <ErrorNotice error={error} />
        </PopoverContent>
      </Popover>
    </Field>
  );
}

// The personal list preferences, shared by the Display popover and Settings. My work (`work`)
// has its own grouping choices.
export function TicketDisplayPreferences({ work = false }: { work?: boolean }) {
  const [grouping, setGrouping] = usePreference(preferences.grouping),
    [workGrouping, setWorkGrouping] = usePreference(preferences.workGrouping),
    [density, setDensity] = usePreference(preferences.density),
    [labelDisplay, setLabelDisplay] = usePreference(preferences.labelDisplay),
    [columns, setColumns] = usePreference(preferences.columns);
  return (
    <>
      {work ? (
        <DisplayToggle
          label="Group by"
          value={workGrouping}
          onChange={(value) => setWorkGrouping(workGroupingSchema.parse(value))}
          options={[
            ["due", "Due date"],
            ["project", "Project"],
            ["none", "None"],
          ]}
        />
      ) : (
        <DisplayToggle
          label="Group by"
          value={grouping}
          onChange={(value) => setGrouping(ticketGroupingSchema.parse(value))}
          options={[
            ["status", "Status"],
            ["none", "None"],
          ]}
        />
      )}
      <Separator />
      <DisplayToggle
        label="Row spacing"
        value={density}
        onChange={(value) => setDensity(ticketDensitySchema.parse(value))}
        options={[
          ["compact", "Compact"],
          ["comfortable", "Comfortable"],
        ]}
      />
      <DisplayToggle
        label="Label display"
        value={labelDisplay}
        onChange={(value) => setLabelDisplay(ticketLabelDisplaySchema.parse(value))}
        options={[
          ["compact", "Compact preview"],
          ["all", "All labels"],
        ]}
      />
      <fieldset>
        <legend className="mb-2 text-xs font-medium text-muted-foreground">Properties</legend>
        <div className="grid grid-cols-2 gap-x-3">
          {Object.entries(ticketColumnLabels).map(([id, label]) => (
            <Check
              key={id}
              label={label}
              checked={columns[id] ?? true}
              onCheckedChange={(checked) => setColumns({ ...columns, [id]: checked })}
            />
          ))}
        </div>
      </fieldset>
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
