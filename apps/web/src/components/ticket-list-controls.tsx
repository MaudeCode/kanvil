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
  customFieldFilter,
  customFieldFilterChoice,
  customFieldFilterText,
  customFieldFilterTokens,
  difficultyLabels,
  filterFieldLabels,
  filterFieldNames,
  filterKey,
  filterList,
  kindLabels,
  ticketPredicates,
  type CustomField,
  type FilterField,
  type FilterOperator,
} from "@kanvil/contracts";
import { labelTable, t } from "@kanvil/contracts/i18n";
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
  ticketLayoutSchema,
  workGroupingSchema,
  customFieldColumn,
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
import { FieldValue, PropertyValue, useCustomFields } from "./ticket-property.tsx";
import { cn } from "@/lib/utils";

// Extends the list's existing filter popover with personal display preferences.
export function TicketListControls({
  projectId,
  search,
  onSearch,
  onReset,
  view,
  actions,
  archivedFilter = true,
}: {
  // Without a project (My work), the project-scoped filters are hidden.
  projectId: string | undefined;
  // Planning shows archived tickets as their own group, so it has no Archived filter.
  archivedFilter?: boolean;
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
    ...api.query("list_ticket_labels", {
      projectId: projectId ?? "",
      archived: archivedFilter ? search.archived : "include",
    }),
    enabled: filtersOpen && !!projectId,
  });
  const fields = useCustomFields(projectId);
  const predicates = ticketPredicates(search);
  const activeFilters =
    predicates.length +
    [search.due, archivedFilter && search.archived !== "exclude"].filter(Boolean).length;
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
  const choices: Record<
    "status" | "priority" | "label" | "assigneeId" | "customField",
    FilterChoice[]
  > = {
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
      { value: identity.id, text: t("ticket.filter.me") },
      { value: "none", text: t("common.state.unassigned") },
      ...(members.data ?? [])
        .filter((member) => member.userId !== identity.id)
        .map((member) => ({ value: member.userId, text: member.name, keywords: [member.email] })),
    ],
    customField: (fields.data ?? []).flatMap((field) =>
      customFieldTokens(field).map((token) => {
        const value = customFieldFilter(field.id, token);
        return {
          value,
          text: customFieldFilterText(field, token),
          node: (
            <span className="flex min-w-0 items-center gap-1.5">
              <span dir="auto" className="truncate text-muted-foreground">
                {field.name}
              </span>
              {field.options.some((option) => option.id === token) ? (
                <FieldValue field={field} value={token} />
              ) : (
                customFieldFilterChoice(field, token)
              )}
            </span>
          ),
        };
      }),
    ),
  };
  // Kind and difficulty have no picker here, but links and the API can still set them.
  const valueNames: Record<FilterField, Record<string, string>> = {
    status: stateLabels,
    priority: priorityLabels,
    kind: kindLabels,
    difficulty: difficultyLabels,
    label: {},
    assigneeId: Object.fromEntries(choices.assigneeId.map((choice) => [choice.value, choice.text])),
    customField: Object.fromEntries(
      choices.customField.map((choice) => [choice.value, choice.text]),
    ),
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
          label={t("ticket.filter.searchTickets")}
          placeholder={t("ticket.filter.searchTicketsPlaceholder")}
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
                  label={
                    activeFilters
                      ? t("ticket.filter.filtersActive", { active: activeFilters })
                      : t("ticket.filter.filters")
                  }
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
              <PopoverTitle>{t("ticket.filter.filters")}</PopoverTitle>
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
                  label={t("ticket.filter.due")}
                  value={search.due ?? ""}
                  onValueChange={(value) =>
                    filter({
                      due: value ? ticketFilter.shape.due.unwrap().parse(value) : undefined,
                    })
                  }
                >
                  <SelectItem value="">{t("ticket.filter.anyDue")}</SelectItem>
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
                {!!choices.customField.length && (
                  <FilterPicker
                    field="customField"
                    search={search}
                    choices={choices.customField}
                    onChange={setPredicate}
                  />
                )}
                {archivedFilter && (
                  <Select
                    label={t("ticket.filter.archived")}
                    value={search.archived}
                    onValueChange={(value) =>
                      filter({ archived: ticketFilter.shape.archived.parse(value) })
                    }
                  >
                    <SelectItem value="exclude">{t("ticket.filter.hideArchived")}</SelectItem>
                    <SelectItem value="include">{t("ticket.filter.includeArchived")}</SelectItem>
                    <SelectItem value="only">{t("ticket.filter.archivedOnly")}</SelectItem>
                  </Select>
                )}
              </div>
              <Button
                variant="ghost"
                onClick={() => {
                  onSearch(searchSchema.parse({ sort: search.sort }));
                  setFiltersOpen(false);
                }}
              >
                {t("ticket.filter.reset")}
              </Button>
            </PopoverContent>
          </Popover>
        )}
        <Popover>
          <PopoverTrigger render={<IconButton label={t("ticket.display.title")} />}>
            <Columns3 />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(19rem,calc(100vw-2rem))] gap-3 p-4">
            <PopoverTitle>{t("ticket.display.title")}</PopoverTitle>
            <Select
              label={t("ticket.display.orderBy")}
              value={search.sort}
              onValueChange={(value) =>
                filter({ sort: ticketFilter.shape.sort.parse(value), order: undefined })
              }
            >
              {Object.entries(sortLabels)
                // The manual order belongs to one project.
                .filter(([value]) => projectId || value !== "manual")
                .map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
            </Select>
            <DisplayToggle
              label={t("ticket.display.direction")}
              value={search.order ?? defaultOrder[search.sort]}
              onChange={(value) => filter({ order: ticketFilter.shape.order.parse(value) })}
              options={[
                ["asc", t("ticket.display.ascending")],
                ["desc", t("ticket.display.descending")],
              ]}
            />
            <TicketDisplayPreferences work={!projectId} fields={fields.data ?? []} />
            <Separator />
            <Button variant="ghost" onClick={onReset}>
              {t("ticket.display.reset")}
            </Button>
          </PopoverContent>
        </Popover>
        {actions}
      </div>
      {(search.q || activeFilters > 0) && (
        <div
          className="active-filters mb-4 flex flex-wrap items-center gap-2 animate-in fade-in-0 slide-in-from-top-1 duration-150 [&_[data-slot=button]]:h-7 [&_[data-slot=button]]:text-xs"
          aria-label={t("ticket.filter.active")}
        >
          {search.q && (
            <Button variant="secondary" size="sm" onClick={() => filter({ q: undefined })}>
              {t("ticket.filter.searchChip", { query: search.q })}
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
              {operator === "none"
                ? t("ticket.filter.chipNone", { field: filterFieldLabels[field] })
                : t("ticket.filter.chipAny", { field: filterFieldLabels[field] })}{" "}
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
          {archivedFilter && search.archived !== "exclude" && (
            <Button variant="secondary" size="sm" onClick={() => filter({ archived: "exclude" })}>
              {search.archived === "only"
                ? t("ticket.filter.archivedOnly")
                : t("ticket.filter.includingArchived")}
              <X className="size-3" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onSearch(searchSchema.parse({ sort: search.sort }))}
          >
            {t("ticket.filter.clear")}
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
const fieldText = labelTable(filterFieldNames, (field) => ({
  any: t(`ticket.filter.anyValue.${field}`),
  search: t(`ticket.filter.searchValues.${field}`),
}));
// The filterable values of a field: its options or a checked box, and no value.
function customFieldTokens(field: CustomField) {
  return [
    ...(field.type === "checkbox"
      ? [customFieldFilterTokens.checked]
      : field.options.map((option) => option.id)),
    customFieldFilterTokens.empty,
  ];
}
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
              ? operator === "none"
                ? t("ticket.filter.notValues", { values: names.join(", ") })
                : names.join(", ")
              : fieldText[field].any}
          </span>
          <ChevronsUpDown className="shrink-0" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(20rem,calc(100vw-3rem))] p-0">
          <ToggleGroup
            aria-label={t("ticket.filter.match", { label })}
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
            <ToggleGroupItem value="any">{t("ticket.filter.is")}</ToggleGroupItem>
            <ToggleGroupItem value="none">{t("ticket.filter.isNot")}</ToggleGroupItem>
          </ToggleGroup>
          <Command>
            <CommandInput
              aria-label={fieldText[field].search}
              placeholder={t("ticket.filter.searchPlaceholder", {
                search: fieldText[field].search,
              })}
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
              <CommandEmpty>
                {loading ? t("common.state.loading") : t("ticket.property.noMatches")}
              </CommandEmpty>
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
export function TicketDisplayPreferences({
  work = false,
  fields = [],
}: {
  work?: boolean;
  // The project's custom fields, which show as columns too.
  fields?: CustomField[];
}) {
  const [grouping, setGrouping] = usePreference(preferences.grouping),
    [layout, setLayout] = usePreference(preferences.layout),
    [backgrounds, setBackgrounds] = usePreference(preferences.backgrounds),
    [workGrouping, setWorkGrouping] = usePreference(preferences.workGrouping),
    [density, setDensity] = usePreference(preferences.density),
    [labelDisplay, setLabelDisplay] = usePreference(preferences.labelDisplay),
    [columns, setColumns] = usePreference(preferences.columns);
  return (
    <>
      {work ? (
        <DisplayToggle
          label={t("ticket.display.groupBy")}
          value={workGrouping}
          onChange={(value) => setWorkGrouping(workGroupingSchema.parse(value))}
          options={[
            ["due", t("ticket.display.dueDate")],
            ["project", t("ticket.project.label")],
            ["none", t("common.state.none")],
          ]}
        />
      ) : (
        <>
          <DisplayToggle
            label={t("ticket.display.layout")}
            value={layout}
            onChange={(value) => setLayout(ticketLayoutSchema.parse(value))}
            options={[
              ["list", t("ticket.display.list")],
              ["board", t("ticket.display.board")],
              ["calendar", t("ticket.schedule.calendar")],
              ["timeline", t("ticket.schedule.timeline")],
            ]}
          />
          {/* Only the list groups: the board has a lane per status, and the calendar and timeline
              place tickets by date. */}
          {layout === "list" && (
            <DisplayToggle
              label={t("ticket.display.groupBy")}
              value={grouping}
              onChange={(value) => setGrouping(ticketGroupingSchema.parse(value))}
              options={[
                ["status", t("ticket.property.status")],
                ["none", t("common.state.none")],
              ]}
            />
          )}
          <DisplayToggle
            label={t("ticket.display.backgrounds")}
            value={backgrounds}
            onChange={(value) => setBackgrounds(preferences.backgrounds.schema.parse(value))}
            options={[
              ["show", t("ticket.display.show")],
              ["hide", t("ticket.display.hide")],
            ]}
          />
        </>
      )}
      <Separator />
      <DisplayToggle
        label={t("ticket.display.rowSpacing")}
        value={density}
        onChange={(value) => setDensity(ticketDensitySchema.parse(value))}
        options={[
          ["compact", t("ticket.display.compact")],
          ["comfortable", t("ticket.display.comfortable")],
        ]}
      />
      <DisplayToggle
        label={t("ticket.display.labelDisplay")}
        value={labelDisplay}
        onChange={(value) => setLabelDisplay(ticketLabelDisplaySchema.parse(value))}
        options={[
          ["compact", t("ticket.display.compactPreview")],
          ["all", t("ticket.display.allLabels")],
        ]}
      />
      <fieldset>
        <legend className="mb-2 text-xs font-medium text-muted-foreground">
          {t("ticket.display.properties")}
        </legend>
        <div className="grid grid-cols-2 gap-x-3">
          {[
            ...Object.entries(ticketColumnLabels).map(([id, label]) => [id, label, true] as const),
            // Field columns start hidden, like the less common built-in ones.
            ...fields.map((field) => [customFieldColumn(field.id), field.name, false] as const),
          ].map(([id, label, shown]) => (
            <Check
              key={id}
              label={label}
              checked={columns[id] ?? shown}
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
