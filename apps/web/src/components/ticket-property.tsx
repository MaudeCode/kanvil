import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Bug,
  Check,
  CircleUserRound,
  FlaskConical,
  Sparkles,
  Tag,
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
import { api, useIdentity, useOperation } from "../data.tsx";
import { TicketIndicator, reportError } from "../ui.tsx";
import { UserAvatar } from "./user-avatar.tsx";
import { TicketTag } from "./ticket-tags.tsx";
import { TagInput } from "./tag-input.tsx";
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
function useOptions<P extends PropertyName>(
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
  className?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const options = useOptions(property, projectId, open || property !== "assignee");
  const label = propertyLabels[property];
  const trigger = (
    <PopoverTrigger
      disabled={disabled}
      render={
        <Button
          variant="ghost"
          size={variant === "cell" ? "xs" : "sm"}
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          className={cn(
            "max-w-full min-w-0 justify-start font-normal",
            variant === "cell" && "-mx-1.5 h-6 px-1.5",
            variant === "row" && "h-7 w-full px-2",
            variant === "pill" && "h-7 border border-transparent px-2 hover:border-border",
            className,
          )}
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
      {variant === "row" ? (
        <div className="grid grid-cols-[80px_minmax(0,1fr)] items-center gap-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          {trigger}
        </div>
      ) : (
        trigger
      )}
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
              if (option.value !== value) onChange(option.value);
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
                  if (option.value !== value) onChange(option.value);
                }}
              >
                <PropertyValue {...pair(property, option.value)} projectId={projectId} />
                {options.length <= 9 && (
                  <kbd className="ml-auto text-[10px] text-muted-foreground" aria-hidden="true">
                    {index + 1}
                  </kbd>
                )}
                {option.value === value && (
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
// opens in a popover.
export function TagsProperty({
  kind = "label",
  value,
  onChange,
  variant = "pill",
  disabled = false,
  className,
}: {
  kind?: "label" | "scope";
  value: string[];
  onChange: (tags: string[]) => void;
  variant?: "pill" | "row";
  disabled?: boolean;
  className?: string;
}) {
  const label = kind === "label" ? "Labels" : "Scopes",
    shown = variant === "pill" ? value.slice(0, 3) : value,
    hidden = value.length - shown.length;
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
            value.length
              ? `Edit ${label.toLowerCase()}: ${value.join(", ")}`
              : `Edit ${label.toLowerCase()}`
          }
        />
      }
    >
      {variant === "pill" && (
        <Tag className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      {value.length === 0 ? (
        <span className="text-muted-foreground">
          {variant === "pill" ? label : `No ${label.toLowerCase()}`}
        </span>
      ) : (
        <span className="flex min-w-0 flex-wrap items-center gap-1">
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
  return (
    <Popover>
      {variant === "row" ? (
        <div className="grid grid-cols-[80px_minmax(0,1fr)] items-start gap-2">
          <span className="pt-1.5 text-xs text-muted-foreground">{label}</span>
          {trigger}
        </div>
      ) : (
        trigger
      )}
      <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-3">
        <TagInput label={label} kind={kind} value={value} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}
