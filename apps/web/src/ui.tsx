import {
  Children,
  createContext,
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
  ChevronDown,
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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  errorMessage,
  formatTimestamp,
  stateLabels,
  priorityLabels,
  type Ticket,
} from "@kanvil/contracts";
import { brandMark } from "@kanvil/contracts/theme";
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
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyHeader, EmptyTitle, EmptyMedia } from "@/components/ui/empty";

export { Button } from "@/components/ui/button";
export { SelectItem } from "@/components/ui/select";

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
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label={label} {...props} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
export function Input({ label, ...props }: ComponentProps<typeof TextInput> & { label: string }) {
  const id = useId(),
    [visible, setVisible] = useState(false);
  return (
    <Field className={fieldClass}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
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
  const items = Children.toArray(children).flatMap((child) =>
    isValidElement<{ value: string; children: ReactNode }>(child)
      ? [{ value: child.props.value, label: child.props.children }]
      : [],
  );
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
      <svg
        aria-hidden="true"
        viewBox={brandMark.viewBox}
        className="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-52 w-auto -translate-x-1/2 -translate-y-1/2 text-foreground/[0.07] dark:text-foreground/[0.09]"
      >
        <path d={brandMark.path} fill="none" stroke="currentColor" strokeWidth={5} />
      </svg>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
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
const priorityPresentation = {
  urgent: { icon: OctagonAlert, color: "text-destructive" },
  high: { icon: ArrowUp, color: "text-[var(--warning)]" },
  medium: { icon: Equal, color: "text-foreground" },
  low: { icon: ArrowDown, color: "text-primary" },
  none: { icon: Minus, color: "text-muted-foreground" },
};
export function TicketIndicator({
  property,
  value,
  iconOnly = false,
}: (
  | { property: "status"; value: Ticket["status"] }
  | { property: "priority"; value: Ticket["priority"] }
) & { iconOnly?: boolean }) {
  const {
    icon: Icon,
    color,
    label,
  } = property === "status"
    ? { ...statusPresentation[value], label: stateLabels[value] }
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
const markdownComponents = {
  a: ({ children, ...props }: ComponentProps<"a">) => (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {children}
      </ReactMarkdown>
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
// Every dialog form ends the same way: an error notice, Cancel, and the primary submit button.
export function FormActions({
  error,
  pending = false,
  submitLabel,
  pendingLabel,
  onCancel,
  cancelLabel = "Cancel",
  submitDisabled = false,
  children,
}: {
  error?: unknown;
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
      <ModalActions>
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
export function SearchField({
  label,
  value,
  onChange,
  placeholder = "Search…",
  shortcut,
  defaultOpen = false,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  shortcut?: string;
  defaultOpen?: boolean;
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
          expanded ? "w-full max-w-56 opacity-100" : "w-0 opacity-0",
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

export function Disclosure({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="border-t">
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            className="group w-full justify-between px-0 text-sm font-medium hover:bg-transparent"
          />
        }
      >
        {title}
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-aria-expanded:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3 pb-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}
