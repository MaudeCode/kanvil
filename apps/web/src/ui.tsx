import {
  Children,
  createContext,
  lazy,
  Suspense,
  useContext,
  isValidElement,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  CalendarClock,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  Clock,
  Copy,
  Eye,
  EyeOff,
  Check as CheckIcon,
  XCircle,
  ArrowDown,
  Equal,
  ArrowUp,
  OctagonAlert,
  Minus,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNowStrict, isPast } from "date-fns";
import { copyText } from "./lib/browser.ts";
import { useShortcut } from "./hooks/use-shortcut.ts";
import { toggleTask } from "./lib/markdown.ts";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  errorMessage,
  formatTimestamp,
  mentionScheme,
  stateLabels,
  priorityLabels,
  type LabelColor,
  type Ticket,
} from "@kanvil/contracts";
import { brandMark } from "@kanvil/contracts/theme";
import { accentColor } from "./lib/accent-colors.ts";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Input as TextInput } from "@/components/ui/input";
import { Textarea as TextareaInput } from "@/components/ui/textarea";
import { Field, FieldLabel, FieldContent, FieldDescription } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Select as SelectRoot,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyHeader, EmptyTitle, EmptyMedia } from "@/components/ui/empty";

export { Button } from "@/components/ui/button";
export { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";

export function Brand() {
  return (
    <>
      <svg
        className="brand-mark h-5 w-7 shrink-0 text-primary"
        viewBox={brandMark.viewBox}
        aria-hidden="true"
      >
        <path d={brandMark.path} fill="currentColor" />
      </svg>
      <span className="brand-word text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
        Kanvil
      </span>
    </>
  );
}

export const fieldClass =
  "relative mb-4 min-w-0 [&>[data-slot=field-label]]:text-xs [&>[data-slot=field-label]]:font-medium [&>[data-slot=field-label]]:text-muted-foreground";
// One place decides how a failed write is surfaced to the user.
export const reportError = (error: unknown) => toast.error(errorMessage(error));
export function IconButton({
  label,
  shortcut,
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string; shortcut?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label={label} {...props} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && (
          <KbdGroup>
            {shortcut.split(" ").map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </KbdGroup>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
export function Input({
  label,
  labelHidden = false,
  ...props
}: ComponentProps<typeof TextInput> & { label: string; labelHidden?: boolean }) {
  const id = useId(),
    [visible, setVisible] = useState(false);
  return (
    <Field className={cn(fieldClass, labelHidden && "mb-0")}>
      <FieldLabel htmlFor={id} className={cn(labelHidden && "sr-only")}>
        {label}
      </FieldLabel>
      {props.type === "password" ? (
        <InputGroup>
          <InputGroupInput {...props} id={id} type={visible ? "text" : "password"} />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-sm"
              aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
              title={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
              disabled={props.disabled}
              onClick={() => setVisible((current) => !current)}
            >
              {visible ? <EyeOff /> : <Eye />}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      ) : (
        <TextInput {...props} id={id} />
      )}
    </Field>
  );
}
export function Textarea({
  label,
  ...props
}: ComponentProps<typeof TextareaInput> & { label: string }) {
  const id = useId();
  return (
    <Field className={fieldClass}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <TextareaInput {...props} id={id} />
    </Field>
  );
}
// Options may sit inside `SelectGroup`s; the value-to-label map still needs every one of them.
function selectItems(children: ReactNode): { value: string; label: ReactNode }[] {
  return Children.toArray(children).flatMap((child) =>
    isValidElement<{ value?: string; children: ReactNode }>(child)
      ? child.props.value === undefined
        ? selectItems(child.props.children)
        : [{ value: child.props.value, label: child.props.children }]
      : [],
  );
}
export function Select({
  label,
  children,
  className,
  layout = "field",
  labelHidden = false,
  ...props
}: Omit<ComponentProps<typeof SelectRoot<string>>, "children" | "items"> & {
  label: string;
  children: ReactNode;
  className?: string;
  layout?: "field" | "property";
  labelHidden?: boolean;
}) {
  const id = useId();
  const items = selectItems(children);
  return (
    <Field
      className={cn(
        fieldClass,
        layout === "property" && "mb-0 grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2",
        className,
      )}
    >
      <FieldLabel
        htmlFor={id}
        className={cn(
          layout === "property" && "text-xs font-normal text-muted-foreground",
          labelHidden && "sr-only",
        )}
      >
        {label}
      </FieldLabel>
      <SelectRoot items={items} defaultValue={items[0]?.value ?? ""} {...props}>
        <SelectTrigger
          id={id}
          className={cn(
            "w-full",
            layout === "property" &&
              "h-auto min-h-8 border-transparent bg-transparent shadow-none hover:bg-muted dark:bg-transparent",
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>{children}</SelectContent>
      </SelectRoot>
    </Field>
  );
}
export function Check({
  label,
  description,
  className,
  ...props
}: ComponentProps<typeof Checkbox> & { label: string; description?: ReactNode }) {
  const id = useId();
  const compact = className === "sr-checkbox";
  return (
    <Field
      orientation="horizontal"
      className={cn("my-2 min-h-7 w-auto", compact && "my-0 min-h-4 justify-center")}
    >
      <Checkbox
        {...props}
        id={id}
        aria-describedby={
          description
            ? [props["aria-describedby"], `${id}-description`].filter(Boolean).join(" ")
            : props["aria-describedby"]
        }
      />
      {description ? (
        <FieldContent>
          <FieldLabel htmlFor={id} className={cn("font-normal", compact && "sr-only")}>
            {label}
          </FieldLabel>
          <FieldDescription id={`${id}-description`} className="text-xs">
            {description}
          </FieldDescription>
        </FieldContent>
      ) : (
        <FieldLabel htmlFor={id} className={cn("font-normal", compact && "sr-only")}>
          {label}
        </FieldLabel>
      )}
    </Field>
  );
}
export function ErrorNotice({ error }: { error: unknown }) {
  return error ? (
    <Alert variant="destructive" className="my-3">
      <AlertCircle />
      <AlertDescription>{errorMessage(error)}</AlertDescription>
    </Alert>
  ) : null;
}
// Offset pagination for server-paged admin directories; hidden while everything fits on one page.
export function Pager({
  noun,
  offset,
  total,
  size,
  onChange,
}: {
  noun: string;
  offset: number;
  total: number;
  size: number;
  onChange: (offset: number) => void;
}) {
  if (total <= size && !offset) return null;
  return (
    <footer className="mt-5 flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground [&>span]:mr-auto">
      <Button disabled={!offset} onClick={() => onChange(Math.max(0, offset - size))}>
        Previous {noun}
      </Button>
      <span>
        {offset + 1}–{Math.min(offset + size, total)} of {total}
      </span>
      <Button disabled={offset + size >= total} onClick={() => onChange(offset + size)}>
        Next {noun}
      </Button>
    </footer>
  );
}
export function Loading() {
  return (
    <div role="status" className="space-y-4 py-5">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-3/4" />
    </div>
  );
}
export function EmptyState({
  title,
  icon: Icon = CircleDashed,
  children,
  className,
}: {
  title: string;
  icon?: typeof CircleDashed;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn("relative isolate overflow-hidden py-20", className)}>
      <EmptyHeader className="w-full">
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle className="relative w-full">
          {/* Anchor the narrow body at (558, 681) in the approved viewBox, rather than its box center. */}
          <svg
            aria-hidden="true"
            viewBox={brandMark.viewBox}
            className="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-auto w-full -translate-x-[44.2%] -translate-y-[59.2%] text-foreground/[0.07] dark:text-foreground/[0.09]"
          >
            <path d={brandMark.path} fill="none" stroke="currentColor" strokeWidth={5} />
          </svg>
          {title}
        </EmptyTitle>
      </EmptyHeader>
      {children}
    </Empty>
  );
}
const statusPresentation = {
  backlog: { icon: CircleDashed, color: "text-muted-foreground" },
  todo: { icon: Circle, color: "text-muted-foreground" },
  in_progress: { icon: CircleDot, color: "text-primary" },
  in_review: { icon: Clock, color: "text-[var(--warning)]" },
  done: { icon: CircleCheck, color: "text-[var(--success)]" },
  cancelled: { icon: XCircle, color: "text-muted-foreground" },
};
// The tint a status uses on pills, calendar entries, and timeline bars.
export const statusColor = (status: Ticket["status"]) => statusPresentation[status].color;
const priorityPresentation = {
  urgent: { icon: OctagonAlert, color: "text-destructive" },
  high: { icon: ArrowUp, color: "text-[var(--warning)]" },
  medium: { icon: Equal, color: "text-foreground" },
  low: { icon: ArrowDown, color: "text-primary" },
  none: { icon: Minus, color: "text-muted-foreground" },
};
// A status shows its category's icon; a workflow state can rename it and tint it.
export function TicketIndicator({
  property,
  value,
  iconOnly = false,
  label: name,
  color: tint,
}: (
  | { property: "status"; value: Ticket["status"] }
  | { property: "priority"; value: Ticket["priority"] }
) & { iconOnly?: boolean; label?: string | undefined; color?: LabelColor | undefined }) {
  const custom =
    property === "status" && tint && tint !== "default" ? accentColor(tint) : undefined;
  const {
    icon: Icon,
    color,
    label,
  } = property === "status"
    ? {
        ...statusPresentation[value],
        color: custom ? custom.className : statusPresentation[value].color,
        label: name ?? stateLabels[value],
      }
    : { ...priorityPresentation[value], label: priorityLabels[value] };
  const accessibleLabel = property === "priority" && value !== "none" ? `${label} priority` : label;
  return (
    <Badge
      variant="outline"
      className={cn(
        property === "status"
          ? "status rounded-full bg-current/8 px-2 text-xs whitespace-nowrap"
          : "h-6 border-transparent bg-transparent px-0 text-xs",
        "gap-1.5 border-transparent font-normal",
        color,
      )}
      style={custom?.style}
      data-priority={property === "priority" ? value : undefined}
      role={iconOnly ? "img" : undefined}
      aria-label={iconOnly ? accessibleLabel : undefined}
      title={iconOnly ? accessibleLabel : undefined}
    >
      <Icon
        className={property === "status" ? "size-3.5" : "size-4.5"}
        strokeWidth={property === "status" ? 2 : 2.5}
        aria-hidden="true"
      />
      {!iconOnly && label}
    </Badge>
  );
}
type MarkdownNode = NonNullable<ExtraProps["node"]>;
const nodeText = (node: MarkdownNode | MarkdownNode["children"][number]): string =>
  node.type === "text"
    ? node.value
    : node.type === "element" && !["ul", "ol"].includes(node.tagName)
      ? node.children.map(nodeText).join("")
      : "";
// Highlighted code and Mermaid diagrams load on demand; until then a block renders as plain code.
const MarkdownBlock = lazy(() => import("./components/markdown-blocks.tsx"));
// The language a fenced block names, from the class its `code` element carries.
function fenceLanguage(node: MarkdownNode | undefined) {
  const code = node?.children[0];
  if (code?.type !== "element" || code.tagName !== "code") return undefined;
  const classes = code.properties.className;
  return (Array.isArray(classes) ? classes : [])
    .map(String)
    .find((name) => name.startsWith("language-"))
    ?.slice("language-".length);
}
// The rendered source and its writer, plus the checklist item each checkbox belongs to.
const MarkdownSource = createContext<{ source: string; onChange?: (next: string) => void }>({
  source: "",
});
const MarkdownTask = createContext<{ offset: number | undefined; label: string } | null>(null);
function MarkdownCheckbox({ checked }: { checked: boolean }) {
  const { source, onChange } = useContext(MarkdownSource),
    task = useContext(MarkdownTask),
    offset = task?.offset;
  return (
    <Checkbox
      checked={checked}
      aria-label={task?.label}
      disabled={!onChange || offset === undefined}
      onCheckedChange={(next) => {
        if (onChange && offset !== undefined) onChange(toggleTask(source, offset, next));
      }}
      className="relative top-0.5 -ml-6 mr-2 inline-flex"
    />
  );
}
const markdownComponents: Components = {
  pre: ({ children, node, ...props }) => {
    const language = fenceLanguage(node),
      plain = <pre {...props}>{children}</pre>;
    return language && node ? (
      <Suspense fallback={plain}>
        <MarkdownBlock language={language} code={nodeText(node).replace(/\n$/, "")} />
      </Suspense>
    ) : (
      plain
    );
  },
  img: ({ node: _node, ...props }) => (
    <img {...props} loading="lazy" className="my-2 rounded-md border" />
  ),
  a: ({ children, node: _node, ...props }) =>
    props.href?.startsWith(mentionScheme) ? (
      <span className="rounded-sm bg-primary/10 px-0.5 font-medium text-primary">{children}</span>
    ) : (
      <a {...props} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
  li: ({ children, node, className, ...props }) =>
    className?.includes("task-list-item") && node ? (
      <li {...props} className={cn(className, "list-none")}>
        <MarkdownTask value={{ offset: node.position?.start.offset, label: nodeText(node).trim() }}>
          {children}
        </MarkdownTask>
      </li>
    ) : (
      <li {...props} className={className}>
        {children}
      </li>
    ),
  input: ({ node: _node, ...props }) =>
    props.type === "checkbox" ? (
      <MarkdownCheckbox checked={!!props.checked} />
    ) : (
      <input {...props} />
    ),
};
// `onChange` makes checklist items toggleable; without it the rendering stays read-only.
export function Markdown({
  children,
  onChange,
}: {
  children: string;
  onChange?: (next: string) => void;
}) {
  return (
    <div className="markdown">
      <MarkdownSource value={{ source: children, ...(onChange ? { onChange } : {}) }}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={markdownComponents}
          urlTransform={(url) => (url.startsWith(mentionScheme) ? url : defaultUrlTransform(url))}
        >
          {children}
        </ReactMarkdown>
      </MarkdownSource>
    </div>
  );
}
const ModalBusyContext = createContext<((busy: boolean) => void) | null>(null);
export const useModalBusy = () => useContext(ModalBusyContext);
const modalSizes = {
  default: "max-h-[90dvh] overflow-y-auto p-6 sm:max-w-2xl",
  composer:
    "flex max-h-[calc(100dvh-2rem)] w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl has-[[data-expanded=true]]:h-[calc(100dvh-1rem)] has-[[data-expanded=true]]:w-[calc(100%-1rem)] has-[[data-expanded=true]]:sm:max-w-[calc(100%-1rem)] max-sm:h-dvh max-sm:w-full max-sm:max-w-none max-sm:rounded-none",
};
export function Modal({
  title,
  description,
  trigger,
  children,
  open,
  onOpenChange,
  busy = false,
  size = "default",
}: {
  title: string;
  description?: ReactNode;
  trigger?: ReactNode;
  busy?: boolean;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  size?: keyof typeof modalSizes;
}) {
  const [childBusy, setChildBusy] = useState(false),
    isBusy = busy || childBusy;
  return (
    <ModalBusyContext value={setChildBusy}>
      <Dialog
        {...(open === undefined ? {} : { open })}
        onOpenChange={(next, details) => {
          if (!next && isBusy) details.cancel();
          else onOpenChange?.(next);
        }}
      >
        {trigger && <DialogTrigger render={<Button variant="outline" />}>{trigger}</DialogTrigger>}
        <DialogContent
          showCloseButton={!isBusy}
          className={modalSizes[size]}
          aria-describedby={undefined}
        >
          <DialogHeader
            className={cn("mb-2", size === "composer" && "m-0 shrink-0 border-b px-5 py-3 pr-24")}
          >
            <DialogTitle className={cn("mb-0", size === "composer" ? "text-sm" : "text-lg")}>
              {title}
            </DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
        </DialogContent>
      </Dialog>
    </ModalBusyContext>
  );
}
// Shared error and submit actions for dialog and inline forms.
export function FormActions({
  error,
  layout = "dialog",
  pending = false,
  submitLabel,
  pendingLabel,
  onCancel,
  cancelLabel = "Cancel",
  submitDisabled = false,
  children,
}: {
  error?: unknown;
  layout?: "dialog" | "inline";
  pending?: boolean;
  submitLabel: ReactNode;
  pendingLabel?: ReactNode;
  onCancel?: (() => void) | undefined;
  cancelLabel?: string;
  submitDisabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      <ErrorNotice error={error} />
      <ModalActions
        className={layout === "inline" ? "mx-0 mb-0 rounded-none border-0 bg-transparent px-0" : ""}
      >
        {children}
        {onCancel && (
          <Button disabled={pending} onClick={onCancel}>
            {cancelLabel}
          </Button>
        )}
        <Button type="submit" variant="default" disabled={pending || submitDisabled}>
          {pending && <Spinner />}
          {pending && pendingLabel ? pendingLabel : submitLabel}
        </Button>
      </ModalActions>
    </>
  );
}
// Standard dialog footer: actions right-aligned over a muted strip.
export function ModalActions({ children, className }: { children: ReactNode; className?: string }) {
  return <DialogFooter className={cn("mt-4", className)}>{children}</DialogFooter>;
}
export function Confirm({
  label,
  description,
  onConfirm,
  danger = false,
  icon,
  disabled = false,
  open: controlledOpen,
  onOpenChange,
  trigger = true,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: boolean;
  label: string;
  description: string;
  onConfirm: () => Promise<unknown>;
  danger?: boolean;
  icon?: ReactNode;
  disabled?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen,
    setOpen = onOpenChange ?? setInternalOpen;
  const [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>();
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {trigger && (
        <AlertDialogTrigger
          render={
            icon ? (
              <IconButton label={label} disabled={disabled} />
            ) : (
              <Button variant={danger ? "destructive" : "outline"} disabled={disabled} />
            )
          }
        >
          {icon ?? label}
        </AlertDialogTrigger>
      )}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{label}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorNotice error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={danger ? "destructive" : "default"}
            disabled={pending}
            onClick={() => {
              setPending(true);
              setError(undefined);
              void onConfirm()
                .then(() => setOpen(false))
                .catch(setError)
                .finally(() => setPending(false));
            }}
          >
            {pending ? "Working…" : label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function RelativeTime({ value, className }: { value: string; className?: string }) {
  const parsed = new Date(value);
  return (
    <time dateTime={value} title={formatTimestamp(value)} className={className}>
      {formatDistanceToNowStrict(parsed, { addSuffix: true })}
    </time>
  );
}

// A due date reads as "in 3 days" or "2 days ago", red once it has passed on an open ticket.
export function DueDate({
  value,
  open = true,
  className,
}: {
  value: string | null;
  open?: boolean;
  className?: string;
}) {
  if (!value) return null;
  const overdue = open && isPast(new Date(value));
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        overdue ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      <CalendarClock className="size-3.5 shrink-0" aria-hidden="true" />
      <RelativeTime value={value} />
    </span>
  );
}
// A ticket page's title, shared by the member and public views.
export const ticketTitleClass =
  "mt-4 mb-6 max-w-4xl text-2xl leading-snug font-semibold tracking-tight";
export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-4 flex min-h-8 flex-wrap items-center justify-between gap-3">
      {typeof title === "string" ? <h1 className="m-0 text-base">{title}</h1> : title}
      {children}
    </header>
  );
}
export function SectionHeading({
  title,
  description,
  action,
  compact = false,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <header
      className={cn(
        "mb-4 flex flex-wrap items-start justify-between gap-3",
        compact &&
          "mb-3 items-center gap-2 [&_[data-slot=button]]:h-7 [&_[data-slot=button]]:text-xs",
      )}
    >
      <div>
        <h2
          className={cn(
            "mb-0 text-sm",
            compact && "text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase",
          )}
        >
          {title}
        </h2>
        {description && (
          <p className="mt-1.5 mb-0 max-w-xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </header>
  );
}
// A magnifying glass that opens into an underlined field, focused and ready to type. Leaving it
// empty folds it back; `shortcut` opens it from the keyboard and `defaultOpen` starts it open.
// `wide` lets the field fill its row, for a page whose main control is the search.
export function SearchField({
  label,
  value,
  onChange,
  placeholder = "Search…",
  shortcut,
  defaultOpen = false,
  wide = false,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  shortcut?: string;
  defaultOpen?: boolean;
  wide?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(() => defaultOpen || value.length > 0),
    input = useRef<HTMLInputElement>(null);
  const expanded = open || value.length > 0;
  const close = () => {
    onChange("");
    setOpen(defaultOpen);
  };
  useShortcut(
    shortcut ?? "",
    () => {
      setOpen(true);
      input.current?.focus();
    },
    { enabled: !!shortcut },
  );
  return (
    <div
      role="search"
      data-expanded={expanded}
      className={cn("group/search flex min-w-0 items-center", expanded && "flex-1", className)}
    >
      <IconButton
        label={label}
        size="icon-sm"
        aria-expanded={expanded}
        title={shortcut ? `${label} (${shortcut})` : undefined}
        className={cn("transition-colors", expanded && "text-foreground")}
        onClick={() => {
          setOpen(true);
          input.current?.focus();
        }}
      >
        <Search />
      </IconButton>
      <div
        className={cn(
          "flex items-center overflow-hidden transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none",
          expanded ? cn("w-full opacity-100", !wide && "max-w-56") : "w-0 opacity-0",
        )}
      >
        <input
          ref={input}
          type="search"
          aria-label={label}
          placeholder={placeholder}
          value={value}
          tabIndex={expanded ? 0 : -1}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => {
            if (!value) setOpen(defaultOpen);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          className="h-8 min-w-0 flex-1 border-0 border-b border-border bg-transparent px-1 text-sm transition-colors outline-none placeholder:text-muted-foreground focus:border-foreground [&::-webkit-search-cancel-button]:hidden"
        />
        {value && (
          <IconButton label={`Clear ${label.toLowerCase()}`} size="icon-xs" onClick={close}>
            <X />
          </IconButton>
        )}
      </div>
    </div>
  );
}
// The one copy-to-clipboard action: copies, toasts, and shows a check briefly.
export function CopyButton({
  label,
  value,
  size = "icon",
  className,
}: {
  label: string;
  value: string;
  size?: "icon" | "icon-sm" | "icon-xs";
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={label}
      size={size}
      className={cn("text-muted-foreground hover:text-foreground", className)}
      onClick={() => {
        void copyText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
            toast.success(`${value} copied`);
          })
          .catch(reportError);
      }}
    >
      {copied ? <CheckIcon className="text-(--success)" /> : <Copy />}
    </IconButton>
  );
}
// A labelled value with a copy action; `inline` drops the label block for use inside a row.
export function CopyValue({
  label,
  value,
  inline = false,
}: {
  label: string;
  value: string;
  inline?: boolean;
}) {
  const id = useId();
  const body = (
    <div
      role="group"
      aria-label={inline ? label : undefined}
      aria-labelledby={inline ? undefined : id}
      className={cn("flex min-w-0 items-center gap-3", !inline && "justify-between")}
    >
      <code className="min-w-0 text-xs break-all">{value}</code>
      <CopyButton
        label={`Copy ${label.toLowerCase()}`}
        value={value}
        size={inline ? "icon-sm" : "icon"}
      />
    </div>
  );
  if (inline) return body;
  return (
    <div className="mb-4 min-w-0">
      <span id={id} className="mb-1 block text-xs text-muted-foreground">
        {label}
      </span>
      {body}
    </div>
  );
}
