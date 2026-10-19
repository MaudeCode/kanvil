import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Bug,
  CalendarDays,
  Hash,
  ListChecks,
  Square,
  SquareCheck,
  CircleChevronDown,
  Type,
  ChartNoAxesColumnIncreasing,
  Check,
  CircleDot,
  CircleUserRound,
  Flag,
  FlaskConical,
  Shapes,
  Sparkles,
  Tag,
  UserRound,
  Wrench,
} from "lucide-react";
import {
  difficulties,
  formatCustomFieldValue,
  kinds,
  priorities,
  priorityLabels,
  stateLabels,
  states,
  type CustomField,
  type CustomFieldType,
  type CustomFieldValue as StoredValue,
  type Ticket,
  type Output,
  type WorkflowState,
} from "@kanvil/contracts";
import { format, parseISO } from "date-fns";
import { api, useIdentity, useOperation, useProjectAccess, useProjects } from "../data.tsx";
import { Input, TicketIndicator, reportError } from "../ui.tsx";
import { UserAvatar } from "./user-avatar.tsx";
import { TicketTag } from "./ticket-tags.tsx";
import { TagInput } from "./tag-input.tsx";
import { ProjectIcon } from "./project-icon.tsx";
import { DatePicker } from "./date-picker.tsx";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

// A status value: a canonical category alone, for filters and drafts without a state, or with the
// workflow state it names, so the category still renders before the project's workflow loads.
export type StatusValue = Ticket["status"] | `${Ticket["status"]}:${string}`;
export const statusValue = (ticket: Pick<Ticket, "status" | "stateId">): StatusValue =>
  ticket.stateId ? `${ticket.status}:${ticket.stateId}` : ticket.status;
export const stateValue = (state: Pick<WorkflowState, "category" | "id">) =>
  statusValue({ status: state.category, stateId: state.id });
export function parseStatus(value: StatusValue) {
  const [category, stateId] = value.split(":");
  return { status: states.find((state) => state === category) ?? "todo", stateId: stateId ?? null };
}
// The project's workflow states in display order.
export const useWorkflow = (projectId: string, enabled = true) =>
  useQuery({
    ...api.query("list_workflow_states", { projectId }),
    enabled: enabled && !!projectId,
  });
export type PropertyValues = {
  status: StatusValue;
  priority: Ticket["priority"];
  kind: Ticket["kind"];
  difficulty: Ticket["difficulty"];
  assignee: string | null;
};
export type PropertyName = keyof PropertyValues;
export const propertyLabels: Record<PropertyName, string> = {
  status: "Status",
  priority: "Priority",
  kind: "Kind",
  difficulty: "Difficulty",
  assignee: "Assignee",
};
// The order every property toolbar and menu lists them in.
export const propertyOrder = [
  "status",
  "priority",
  "assignee",
  "kind",
  "difficulty",
] as const satisfies PropertyName[];
export const propertyIcons: Record<PropertyName, typeof Bug> = {
  status: CircleDot,
  priority: Flag,
  kind: Shapes,
  difficulty: ChartNoAxesColumnIncreasing,
  assignee: UserRound,
};
const readers: { [P in PropertyName]: (ticket: Ticket) => PropertyValues[P] } = {
  status: statusValue,
  priority: (ticket) => ticket.priority,
  kind: (ticket) => ticket.kind,
  difficulty: (ticket) => ticket.difficulty,
  assignee: (ticket) => ticket.assigneeId,
};
export function propertyOf<P extends PropertyName>(ticket: Ticket, property: P) {
  return readers[property](ticket);
}
// A ticket edit as update_ticket takes it: a state is written by ID, never cleared.
// An edit as clients send it. Custom field changes name only some fields; null clears one.
export type TicketChange = Omit<Partial<Ticket>, "stateId" | "customFields"> & {
  stateId?: string;
  customFields?: Record<string, StoredValue | null>;
};
// The ticket change that sets a property; only the assignee is stored under another name.
const writers: {
  [P in PropertyName]: (value: PropertyValues[P]) => Omit<TicketChange, "customFields">;
} = {
  status: (value) => {
    const { status, stateId } = parseStatus(value);
    return stateId ? { status, stateId } : { status };
  },
  priority: (priority) => ({ priority }),
  kind: (kind) => ({ kind }),
  difficulty: (difficulty) => ({ difficulty }),
  assignee: (assigneeId) => ({ assigneeId }),
};
export function propertyChange<P extends PropertyName>(property: P, value: PropertyValues[P]) {
  return writers[property](value);
}
export const kindLabels: Record<Ticket["kind"], string> = {
  feature: "Feature",
  bug: "Bug",
  chore: "Chore",
  research: "Research",
  documentation: "Documentation",
};
const kindIcons: Record<Ticket["kind"], typeof Bug> = {
  feature: Sparkles,
  bug: Bug,
  chore: Wrench,
  research: FlaskConical,
  documentation: BookOpen,
};
export const difficultyLabels: Record<NonNullable<Ticket["difficulty"]>, string> = {
  low: "Low",
  med: "Medium",
  high: "High",
};
// Three bars filled to the level read at a glance, like Linear's estimate bars.
function DifficultyBars({ level, className }: { level: Ticket["difficulty"]; className?: string }) {
  const filled = level === "low" ? 1 : level === "med" ? 2 : level === "high" ? 3 : 0;
  return (
    <svg viewBox="0 0 16 16" className={cn("size-4 shrink-0", className)} aria-hidden="true">
      {[6, 10, 14].map((height, index) => (
        <rect
          key={height}
          x={1.5 + index * 5}
          y={15 - height}
          width={3.5}
          height={height}
          rx={1}
          fill="currentColor"
          opacity={index < filled ? 1 : 0.2}
        />
      ))}
    </svg>
  );
}

type PropertyProps = {
  [P in PropertyName]: { property: P; value: PropertyValues[P] };
}[PropertyName];
// One renderer for every ticket property value, so lists, menus, and details share icons and wording.
export function PropertyValue({
  projectId,
  iconOnly = false,
  ...props
}: PropertyProps & { projectId: string; iconOnly?: boolean }) {
  const identity = useIdentity();
  const members = useQuery({
    ...api.query("list_members", { projectId }),
    enabled: props.property === "assignee" && !!props.value,
  });
  const workflow =
    useWorkflow(projectId, props.property === "status" && props.value.includes(":")).data ?? [];
  switch (props.property) {
    case "status": {
      const { status, stateId } = parseStatus(props.value),
        state = stateId ? workflow.find((item) => item.id === stateId) : undefined;
      return (
        <TicketIndicator
          property="status"
          value={status}
          label={state?.name}
          color={state?.color}
          iconOnly={iconOnly}
        />
      );
    }
    case "priority":
      return <TicketIndicator property="priority" value={props.value} iconOnly={iconOnly} />;
    case "kind": {
      const Icon = kindIcons[props.value];
      return (
        <span className="inline-flex items-center gap-1.5">
          <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          {!iconOnly && kindLabels[props.value]}
        </span>
      );
    }
    case "difficulty": {
      const difficulty = props.value;
      return (
        <span
          className={cn("inline-flex items-center gap-1.5", !difficulty && "text-muted-foreground")}
        >
          <DifficultyBars level={difficulty} className={cn(difficulty && "text-foreground")} />
          {!iconOnly && (difficulty ? difficultyLabels[difficulty] : "No difficulty")}
        </span>
      );
    }
    default: {
      const id = props.value;
      if (!id)
        return (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <CircleUserRound className="size-3.5" aria-hidden="true" />
            {!iconOnly && "Unassigned"}
          </span>
        );
      const member = members.data?.find((person) => person.userId === id),
        name = id === identity.id ? identity.name : (member?.name ?? "Former member"),
        image = id === identity.id ? identity.image : member?.image;
      return (
        <span className="inline-flex min-w-0 items-center gap-1.5" title={name}>
          <UserAvatar name={name} image={image} className="size-4 text-[8px]" />
          {!iconOnly && (
            <span className="truncate">{id === identity.id ? `${name} (you)` : name}</span>
          )}
        </span>
      );
    }
  }
}

type Option<V> = { value: V; label: string; keywords?: string[] };
type Member = { userId: string; name: string; email: string };
const optionsFor: {
  [P in PropertyName]: (
    members: Member[],
    workflow: Output<"list_workflow_states">,
  ) => Option<PropertyValues[P]>[];
} = {
  // A server without workflows offers the categories themselves.
  status: (_, workflow) =>
    workflow.length
      ? workflow.map((state) => ({
          value: stateValue(state),
          label: state.name,
          keywords: [stateLabels[state.category]],
        }))
      : states.map((status) => ({ value: status, label: stateLabels[status] })),
  priority: () =>
    priorities.map((priority) => ({ value: priority, label: priorityLabels[priority] })),
  kind: () => kinds.map((kind) => ({ value: kind, label: kindLabels[kind] })),
  difficulty: () => [
    { value: null, label: "No difficulty" },
    ...difficulties.map((difficulty) => ({
      value: difficulty,
      label: difficultyLabels[difficulty],
    })),
  ],
  assignee: (members) => [
    { value: null, label: "Unassigned" },
    ...members.map((member) => ({
      value: member.userId,
      label: member.name,
      keywords: [member.email],
    })),
  ],
};
export function usePropertyOptions<P extends PropertyName>(
  property: P,
  projectId: string,
  enabled: boolean,
): Option<PropertyValues[P]>[] {
  const members = useQuery({
    ...api.query("list_members", { projectId }),
    enabled: enabled && property === "assignee",
  });
  const workflow = useWorkflow(projectId, enabled && property === "status").data ?? [];
  return optionsFor[property](members.data ?? [], workflow);
}

// Pairs a generic property with its value as the discriminated union PropertyValue renders.
export function pair<P extends PropertyName>(property: P, value: PropertyValues[P]): PropertyProps {
  const pairs: { [K in PropertyName]: (next: PropertyValues[K]) => PropertyProps } = {
    status: (next) => ({ property: "status", value: next }),
    priority: (next) => ({ property: "priority", value: next }),
    kind: (next) => ({ property: "kind", value: next }),
    difficulty: (next) => ({ property: "difficulty", value: next }),
    assignee: (next) => ({ property: "assignee", value: next }),
  };
  return pairs[property](value);
}
const triggerClass = {
  pill: "max-w-full min-w-0 justify-start font-normal h-7 border border-transparent px-2 hover:border-border",
  row: "max-w-full min-w-0 justify-start font-normal h-7 w-full px-2",
  cell: "max-w-full min-w-0 justify-start font-normal -mx-1.5 h-6 px-1.5",
};
export function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[80px_minmax(0,1fr)] items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
// Linear-style property picker: a trigger showing the current value and a searchable command list.
export function TicketProperty<P extends PropertyName>({
  property,
  value,
  onChange,
  projectId,
  disabled = false,
  variant = "pill",
  iconOnly = false,
  align = "start",
  ariaLabel,
  mixed = false,
  className,
  children,
}: {
  property: P;
  value: PropertyValues[P];
  onChange: (value: PropertyValues[P]) => void;
  projectId: string;
  disabled?: boolean;
  variant?: "pill" | "row" | "cell";
  iconOnly?: boolean;
  align?: "start" | "end";
  // Names the trigger when several pickers for the same property share a page.
  ariaLabel?: string;
  // The value differs across a selection: nothing is marked current and every choice applies.
  mixed?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const options = usePropertyOptions(property, projectId, open || property !== "assignee");
  const label = propertyLabels[property];
  const trigger = (
    <PopoverTrigger
      disabled={disabled}
      render={
        <Button
          variant="ghost"
          size={variant === "cell" ? "xs" : "sm"}
          role="combobox"
          aria-label={ariaLabel ?? label}
          aria-expanded={open}
          className={cn(triggerClass[variant], className)}
        />
      }
    >
      {children ?? (
        <PropertyValue {...pair(property, value)} projectId={projectId} iconOnly={iconOnly} />
      )}
    </PopoverTrigger>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {variant === "row" ? <PropertyRow label={label}>{trigger}</PropertyRow> : trigger}
      <PopoverContent align={align} className="w-60 p-0">
        <ChoiceList
          placeholder={`${property === "assignee" ? "Assign to" : `Set ${label.toLowerCase()}`}…`}
          searchLabel={`Search ${label.toLowerCase()}`}
          choices={options.map((option) => ({
            ...option,
            node: <PropertyValue {...pair(property, option.value)} projectId={projectId} />,
            checked: !mixed && option.value === value,
          }))}
          onPick={(next) => {
            setOpen(false);
            if (mixed || next !== value) onChange(next);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
// The searchable list inside every property popover. With nine choices or fewer, a digit picks one.
function ChoiceList<V>({
  choices,
  placeholder,
  searchLabel,
  onPick,
}: {
  choices: (Option<V> & { node: ReactNode; checked: boolean })[];
  placeholder: string;
  searchLabel: string;
  onPick: (value: V) => void;
}) {
  const numbered = choices.length <= 9;
  return (
    <Command>
      <CommandInput
        placeholder={placeholder}
        aria-label={searchLabel}
        autoFocus
        onKeyDown={(event) => {
          const choice = /^[1-9]$/.test(event.key) ? choices[Number(event.key) - 1] : undefined;
          if (!choice || event.currentTarget.value || !numbered) return;
          event.preventDefault();
          onPick(choice.value);
        }}
      />
      <CommandList>
        {choices.map((choice, index) => (
          <CommandItem
            key={String(choice.value)}
            value={choice.label}
            keywords={choice.keywords ?? []}
            onSelect={() => onPick(choice.value)}
          >
            {choice.node}
            {numbered && (
              <kbd className="ml-auto text-[10px] text-muted-foreground" aria-hidden="true">
                {index + 1}
              </kbd>
            )}
            {choice.checked && <Check className={numbered ? "" : "ml-auto"} />}
          </CommandItem>
        ))}
        <CommandEmpty>No matches</CommandEmpty>
      </CommandList>
    </Command>
  );
}

// Applies an edit to a cached ticket.
export function applyPatch<T extends Ticket>(row: T, { customFields, ...rest }: TicketChange): T {
  if (!customFields) return { ...row, ...rest };
  const values = { ...row.customFields };
  for (const [id, value] of Object.entries(customFields))
    if (value === null) delete values[id];
    else values[id] = value;
  return { ...row, ...rest, customFields: values };
}
// Shared mutation wrapper so every inline edit reports failures the same way.
// `target` edits another ticket than the hook's own, e.g. the one dropped on a board lane.
export function useTicketChange(ticket?: Pick<Ticket, "id" | "projectId" | "version">) {
  const update = useOperation("update_ticket");
  const cache = useQueryClient();
  return {
    pending: update.isPending,
    change: (
      changes: Partial<PropertyValues> & Omit<TicketChange, "status">,
      target: Pick<Ticket, "id" | "projectId" | "version"> | undefined = ticket,
    ) => {
      if (!target) return Promise.resolve();
      const { assignee, status, ...rest } = changes;
      const patch = {
        ...rest,
        ...(status === undefined ? {} : writers.status(status)),
        ...(assignee === undefined ? {} : { assigneeId: assignee }),
      };
      // Show the edit at once in project lists and My work; the success invalidation or the
      // failure refetch settles it.
      for (const queryKey of [
        api.query("list_tickets", { projectId: target.projectId }).queryKey.slice(0, 3),
        api.query("list_my_work", {}).queryKey.slice(0, 3),
      ])
        cache.setQueriesData<Pick<Output<"list_tickets">, "items">>(
          { queryKey },
          (page) =>
            page && {
              ...page,
              items: page.items.map((row) => (row.id === target.id ? applyPatch(row, patch) : row)),
            },
        );
      cache.setQueriesData<Output<"get_ticket">>(
        {
          queryKey: api.query("get_ticket", { projectId: target.projectId, ticketId: target.id })
            .queryKey,
        },
        (data) => data && { ...data, ticket: applyPatch(data.ticket, patch) },
      );
      return update
        .mutateAsync({
          projectId: target.projectId,
          ticketId: target.id,
          expectedVersion: target.version,
          changes: patch,
        })
        .catch((error: unknown) => {
          void cache.invalidateQueries({ queryKey: ["kanvil"] });
          reportError(error);
        });
    },
  };
}

// Labels or scopes as a composer pill or a sidebar row: the tags show on the trigger, the editor
// opens in a popover. `replace` drafts the set and applies it once, for editing a selection.
export function TagsProperty({
  kind = "label",
  value,
  onChange,
  variant = "pill",
  replace = false,
  mixed = false,
  disabled = false,
  className,
  textClassName,
}: {
  kind?: "label" | "scope";
  value: string[];
  onChange: (tags: string[]) => void;
  variant?: "pill" | "row";
  replace?: boolean;
  // The selection's tags differ: the trigger says so and the draft starts empty.
  mixed?: boolean;
  disabled?: boolean;
  className?: string;
  // Styles the trigger's text, e.g. to leave only the icon on narrow toolbars.
  textClassName?: string;
}) {
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState<string[]>([]);
  const label = kind === "label" ? "Labels" : "Scopes",
    current = mixed ? [] : value,
    shown = variant === "pill" ? current.slice(0, 3) : current,
    hidden = current.length - shown.length;
  const trigger = (
    <PopoverTrigger
      disabled={disabled}
      render={
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "max-w-full min-w-0 justify-start font-normal",
            variant === "pill" && "h-7 max-w-96 border border-transparent px-2 hover:border-border",
            variant === "row" && "h-auto min-h-7 w-full px-2 py-1",
            className,
          )}
          aria-label={
            mixed
              ? `Edit ${label.toLowerCase()}: mixed`
              : current.length
                ? `Edit ${label.toLowerCase()}: ${current.join(", ")}`
                : `Edit ${label.toLowerCase()}`
          }
        />
      }
    >
      {variant === "pill" && (
        <Tag className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      {current.length === 0 ? (
        <span className={cn("text-muted-foreground", textClassName)}>
          {mixed
            ? `Mixed ${label.toLowerCase()}`
            : variant === "pill"
              ? label
              : `No ${label.toLowerCase()}`}
        </span>
      ) : (
        <span className={cn("flex min-w-0 flex-wrap items-center gap-1", textClassName)}>
          {shown.map((tag) => (
            <TicketTag key={tag} tag={tag} kind={kind} className="max-w-28">
              <span className="truncate">{tag}</span>
            </TicketTag>
          ))}
          {hidden > 0 && <span className="text-xs text-muted-foreground">+{hidden}</span>}
        </span>
      )}
    </PopoverTrigger>
  );
  function apply(tags: string[]) {
    setOpen(false);
    onChange(tags);
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(current);
        setOpen(next);
      }}
    >
      {variant === "row" ? (
        <div className="grid grid-cols-[80px_minmax(0,1fr)] items-start gap-2">
          <span className="pt-1.5 text-xs text-muted-foreground">{label}</span>
          {trigger}
        </div>
      ) : (
        trigger
      )}
      <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-3">
        {replace ? (
          <>
            {mixed && (
              <p className="mb-2 text-xs text-muted-foreground">
                The selected tickets have different {label.toLowerCase()}.
              </p>
            )}
            <TagInput label={label} kind={kind} value={draft} onChange={setDraft} />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={!mixed && !value.length}
                onClick={() => apply([])}
              >
                Clear {label.toLowerCase()}
              </Button>
              <Button
                size="sm"
                disabled={!draft.length || (!mixed && draft.join("\n") === value.join("\n"))}
                onClick={() => apply(draft)}
              >
                Replace {label.toLowerCase()}
              </Button>
            </div>
          </>
        ) : (
          <TagInput label={label} kind={kind} value={value} onChange={onChange} />
        )}
      </PopoverContent>
    </Popover>
  );
}

export const customFieldIcons: Record<CustomFieldType, typeof Bug> = {
  text: Type,
  number: Hash,
  date: CalendarDays,
  checkbox: SquareCheck,
  select: CircleChevronDown,
  multiselect: ListChecks,
};
// One read of a project's field definitions; every view of its tickets shares the cached query.
export function useCustomFields(projectId: string | undefined) {
  return useQuery({
    ...api.query("list_custom_fields", { projectId: projectId ?? "" }),
    enabled: !!projectId,
  });
}
// One renderer for a custom field value: choices as colored tags, a checked box, or the shared
// text from the contracts package.
export function FieldValue({ field, value }: { field: CustomField; value: StoredValue }) {
  if (field.type === "select" || field.type === "multiselect")
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {(Array.isArray(value) ? value : [String(value)]).map((optionId) => {
          const option = field.options.find((choice) => choice.id === optionId),
            name = option?.name ?? "Removed option";
          return (
            <TicketTag
              key={optionId}
              tag={name}
              color={option?.color ?? "gray"}
              className="max-w-40"
            >
              <span className="truncate">{name}</span>
            </TicketTag>
          );
        })}
      </span>
    );
  if (field.type === "checkbox")
    return (
      <span className="inline-flex items-center gap-1.5">
        <SquareCheck className="size-3.5 text-primary" aria-hidden="true" />
        Yes
      </span>
    );
  // Wraps rather than truncates, so a trigger sized to its content keeps the text.
  return <span className="break-words">{formatCustomFieldValue(field, value)}</span>;
}
// Calendar days are stored as YYYY-MM-DD and picked in the local calendar.
const toDay = (value: StoredValue | null | undefined) =>
  typeof value === "string" && value ? parseISO(value) : null;
// A custom field as a composer pill, a sidebar row, or a list cell. Choices pick from a searchable
// list (a multi-select applies when its popover closes), text and numbers edit in a popover, dates
// reuse the date picker, and a checkbox toggles in place. `mixed` marks a selection's differing values.
export function CustomFieldProperty({
  field,
  value,
  onChange,
  variant = "pill",
  disabled = false,
  mixed = false,
  align = "start",
}: {
  field: CustomField;
  value: StoredValue | null | undefined;
  onChange: (value: StoredValue | null) => void;
  variant?: "pill" | "row" | "cell";
  disabled?: boolean;
  mixed?: boolean;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState<string[]>([]),
    [text, setText] = useState("");
  const Icon = customFieldIcons[field.type],
    current = mixed ? null : (value ?? null);
  // A pill names its field; a row has a label and a cell a column header. An empty list cell stays
  // out of sight until its row is hovered or the editor is focused, and narrow lists leave it out.
  const empty = current === null,
    quiet =
      variant === "cell" && empty && !mixed
        ? "opacity-0 focus-visible:opacity-100 data-[popup-open]:opacity-100 [.ticket-row:hover_&]:opacity-100 @max-[850px]:hidden"
        : "",
    checked = field.type === "checkbox" && current === true,
    ShownIcon = field.type === "checkbox" && !checked ? Square : Icon;
  const shown = (
    <span className={cn("inline-flex items-center gap-1.5", empty && "text-muted-foreground")}>
      {(variant !== "row" || field.type === "checkbox") && (
        <ShownIcon
          className={cn("size-3.5 shrink-0", checked ? "text-primary" : "text-muted-foreground")}
          aria-hidden="true"
        />
      )}
      {variant === "pill" && <span className="truncate">{field.name}</span>}
      {field.type === "checkbox" ? (
        variant === "row" && (mixed ? "Mixed" : checked ? "Yes" : "No")
      ) : empty ? (
        variant === "row" && (mixed ? "Mixed" : "No value")
      ) : (
        <FieldValue field={field} value={current} />
      )}
    </span>
  );
  const row = (control: ReactNode) =>
    variant === "row" ? <PropertyRow label={field.name}>{control}</PropertyRow> : control;
  if (field.type === "date")
    return (
      <DatePicker
        variant={variant === "row" ? "row" : "pill"}
        label={field.name}
        placeholder={
          variant === "row" ? (mixed ? "Mixed" : "No value") : variant === "pill" ? field.name : ""
        }
        value={toDay(current)}
        mixed={mixed}
        disabled={disabled}
        className={variant === "cell" ? cn(triggerClass.cell, quiet) : undefined}
        onChange={(date) => onChange(date ? format(date, "yyyy-MM-dd") : null)}
      />
    );
  if (field.type === "checkbox")
    return row(
      <Button
        variant="ghost"
        size={variant === "cell" ? "xs" : "sm"}
        role="checkbox"
        aria-checked={mixed ? "mixed" : checked}
        aria-label={field.name}
        disabled={disabled}
        className={cn(triggerClass[variant], quiet)}
        onClick={() => onChange(mixed || !checked ? true : null)}
      >
        {shown}
      </Button>,
    );
  const choices = field.type === "select" || field.type === "multiselect";
  const selected = Array.isArray(current) ? current : [];
  function toggle(next: boolean) {
    if (next) {
      setDraft(mixed ? [] : selected);
      setText(current === null ? "" : String(current));
    } else if (
      field.type === "multiselect" &&
      (mixed ? draft.length > 0 : JSON.stringify(draft) !== JSON.stringify(selected))
    )
      onChange(draft.length ? draft : null);
    setOpen(next);
  }
  function save() {
    const trimmed = text.trim();
    toggle(false);
    if (!trimmed) return onChange(null);
    onChange(field.type === "number" ? Number(trimmed) : trimmed);
  }
  return (
    <Popover open={open} onOpenChange={toggle}>
      {row(
        <PopoverTrigger
          disabled={disabled}
          render={
            <Button
              variant="ghost"
              size={variant === "cell" ? "xs" : "sm"}
              {...(choices ? { role: "combobox", "aria-expanded": open } : {})}
              aria-label={field.name}
              className={cn(
                triggerClass[variant],
                variant === "row" && "h-auto min-h-7 py-1",
                quiet,
              )}
            />
          }
        >
          {shown}
        </PopoverTrigger>,
      )}
      <PopoverContent
        align={align}
        className={choices ? "w-60 p-0" : "w-[min(18rem,calc(100vw-2rem))] p-3"}
      >
        {choices ? (
          <ChoiceList
            placeholder={`Set ${field.name.toLowerCase()}…`}
            searchLabel={`Search ${field.name.toLowerCase()}`}
            choices={[
              {
                value: "",
                label: "No value",
                node: <span className="text-muted-foreground">No value</span>,
                checked: !mixed && current === null,
              },
              ...field.options.map((option) => ({
                value: option.id,
                label: option.name,
                node: <FieldValue field={field} value={option.id} />,
                checked:
                  field.type === "multiselect" ? draft.includes(option.id) : current === option.id,
              })),
            ]}
            onPick={(optionId) => {
              if (field.type === "multiselect" && optionId) {
                setDraft(
                  draft.includes(optionId)
                    ? draft.filter((item) => item !== optionId)
                    : [...draft, optionId],
                );
                return;
              }
              setOpen(false);
              if (mixed || (optionId || null) !== current) onChange(optionId || null);
            }}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <Input
              label={field.name}
              labelHidden
              autoFocus
              type={field.type === "number" ? "number" : "text"}
              step={field.type === "number" ? "any" : undefined}
              maxLength={1000}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                // The popover renders outside the composer form, but React still bubbles to it.
                event.preventDefault();
                event.stopPropagation();
                save();
              }}
            />
            <div className="flex justify-end gap-2">
              {current !== null && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    toggle(false);
                    onChange(null);
                  }}
                >
                  Clear
                </Button>
              )}
              <Button size="sm" onClick={save}>
                Save
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
// A ticket's custom fields as composer pills or sidebar rows. A new ticket shows each field's
// default until the author sets or clears it; an existing ticket shows only stored values.
export function CustomFieldProperties({
  projectId,
  values,
  isNew = false,
  onChange,
  variant,
  disabled = false,
}: {
  projectId: string;
  values: Record<string, StoredValue | null>;
  isNew?: boolean;
  onChange: (fieldId: string, value: StoredValue | null) => void;
  variant: "pill" | "row";
  disabled?: boolean;
}) {
  const fields = useCustomFields(projectId);
  return fields.data?.map((field) => (
    <CustomFieldProperty
      key={field.id}
      field={field}
      variant={variant}
      disabled={disabled}
      value={isNew && !Object.hasOwn(values, field.id) ? field.defaultValue : values[field.id]}
      onChange={(value) => onChange(field.id, value)}
    />
  ));
}

// Target project of a new ticket, chosen from the active workspace's projects the user can write
// to. Kept apart from TicketProperty because a project is not an editable ticket field: its values
// feed update_ticket patches through useTicketChange and the selection toolbar.
export function ProjectProperty({
  value,
  onChange,
  variant = "pill",
  disabled = false,
  exclude,
  placeholder = "Create in project…",
}: {
  value: string;
  onChange: (projectId: string) => void;
  variant?: "pill" | "row";
  disabled?: boolean;
  // A project left out of the choices, such as the one a ticket is moving from.
  exclude?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const projects = useProjects(),
    project = projects.data?.find((item) => item.id === value);
  const trigger = (
    <PopoverTrigger
      disabled={disabled}
      render={
        <Button
          variant="ghost"
          size="sm"
          role="combobox"
          aria-label="Project"
          aria-expanded={open}
          className={triggerClass[variant]}
        />
      }
    >
      {project && <ProjectIcon project={project} className="size-4 rounded" />}
      <span className="truncate">{project?.name ?? "Project"}</span>
    </PopoverTrigger>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {variant === "row" ? <PropertyRow label="Project">{trigger}</PropertyRow> : trigger}
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={placeholder} aria-label="Search projects" autoFocus />
          <CommandList>
            {projects.data
              ?.filter((item) => item.id !== exclude)
              .map((item) => (
                <WritableProject
                  key={item.id}
                  project={item}
                  selected={item.id === value}
                  onSelect={() => {
                    setOpen(false);
                    if (item.id !== value) onChange(item.id);
                  }}
                />
              ))}
            <CommandEmpty>No matches</CommandEmpty>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
function WritableProject({
  project,
  selected,
  onSelect,
}: {
  project: Output<"list_projects">[number];
  selected: boolean;
  onSelect: () => void;
}) {
  if (!useProjectAccess(project.id).canWrite) return null;
  return (
    <CommandItem value={`${project.name} ${project.key}`} onSelect={onSelect}>
      <ProjectIcon project={project} className="size-4 rounded" />
      <span className="truncate">{project.name}</span>
      {selected && <Check className="ml-auto" />}
    </CommandItem>
  );
}
