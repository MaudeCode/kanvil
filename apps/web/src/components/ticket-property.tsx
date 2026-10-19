import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Bug,
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
  kinds,
  priorities,
  priorityLabels,
  stateLabels,
  states,
  type Ticket,
  type Output,
} from "@kanvil/contracts";
import { api, useIdentity, useOperation, useProjectAccess, useProjects } from "../data.tsx";
import { TicketIndicator, reportError } from "../ui.tsx";
import { UserAvatar } from "./user-avatar.tsx";
import { TicketTag } from "./ticket-tags.tsx";
import { TagInput } from "./tag-input.tsx";
import { ProjectIcon } from "./project-icon.tsx";
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

export type PropertyValues = {
  status: Ticket["status"];
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
  status: (ticket) => ticket.status,
  priority: (ticket) => ticket.priority,
  kind: (ticket) => ticket.kind,
  difficulty: (ticket) => ticket.difficulty,
  assignee: (ticket) => ticket.assigneeId,
};
export function propertyOf<P extends PropertyName>(ticket: Ticket, property: P) {
  return readers[property](ticket);
}
// The ticket change that sets a property; only the assignee is stored under another name.
const writers: { [P in PropertyName]: (value: PropertyValues[P]) => Partial<Ticket> } = {
  status: (status) => ({ status }),
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
  switch (props.property) {
    case "status":
      return <TicketIndicator property="status" value={props.value} iconOnly={iconOnly} />;
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
const optionsFor: { [P in PropertyName]: (members: Member[]) => Option<PropertyValues[P]>[] } = {
  status: () => states.map((status) => ({ value: status, label: stateLabels[status] })),
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
  return optionsFor[property](members.data ?? []);
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
function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
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
        <Command>
          <CommandInput
            placeholder={`${property === "assignee" ? "Assign to" : `Set ${label.toLowerCase()}`}…`}
            aria-label={`Search ${label.toLowerCase()}`}
            autoFocus
            onKeyDown={(event) => {
              const option = /^[1-9]$/.test(event.key) ? options[Number(event.key) - 1] : undefined;
              if (!option || event.currentTarget.value || options.length > 9) return;
              event.preventDefault();
              setOpen(false);
              if (mixed || option.value !== value) onChange(option.value);
            }}
          />
          <CommandList>
            {options.map((option, index) => (
              <CommandItem
                key={String(option.value)}
                value={option.label}
                keywords={option.keywords ?? []}
                onSelect={() => {
                  setOpen(false);
                  if (mixed || option.value !== value) onChange(option.value);
                }}
              >
                <PropertyValue {...pair(property, option.value)} projectId={projectId} />
                {options.length <= 9 && (
                  <kbd className="ml-auto text-[10px] text-muted-foreground" aria-hidden="true">
                    {index + 1}
                  </kbd>
                )}
                {!mixed && option.value === value && (
                  <Check className={options.length <= 9 ? "" : "ml-auto"} />
                )}
              </CommandItem>
            ))}
            <CommandEmpty>No matches</CommandEmpty>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Shared mutation wrapper so every inline edit reports failures the same way.
export function useTicketChange(ticket: Pick<Ticket, "id" | "projectId" | "version">) {
  const update = useOperation("update_ticket");
  const cache = useQueryClient();
  return {
    pending: update.isPending,
    change: (changes: Partial<PropertyValues> & Partial<Ticket>) => {
      const { assignee, ...rest } = changes;
      const patch = { ...rest, ...(assignee === undefined ? {} : { assigneeId: assignee }) };
      // Show the edit at once; the success invalidation or the failure refetch settles it.
      cache.setQueriesData<Output<"list_tickets">>(
        {
          queryKey: api.query("list_tickets", { projectId: ticket.projectId }).queryKey.slice(0, 3),
        },
        (page) =>
          page && {
            ...page,
            items: page.items.map((row) => (row.id === ticket.id ? { ...row, ...patch } : row)),
          },
      );
      cache.setQueriesData<Output<"get_ticket">>(
        {
          queryKey: api.query("get_ticket", { projectId: ticket.projectId, ticketId: ticket.id })
            .queryKey,
        },
        (data) => data && { ...data, ticket: { ...data.ticket, ...patch } },
      );
      return update
        .mutateAsync({
          projectId: ticket.projectId,
          ticketId: ticket.id,
          expectedVersion: ticket.version,
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

// Target project of a new ticket, chosen from the active workspace's projects the user can write
// to. Kept apart from TicketProperty because a project is not an editable ticket field: its values
// feed update_ticket patches through useTicketChange and the selection toolbar.
export function ProjectProperty({
  value,
  onChange,
  variant = "pill",
  disabled = false,
}: {
  value: string;
  onChange: (projectId: string) => void;
  variant?: "pill" | "row";
  disabled?: boolean;
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
          <CommandInput placeholder="Create in project…" aria-label="Search projects" autoFocus />
          <CommandList>
            {projects.data?.map((item) => (
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
