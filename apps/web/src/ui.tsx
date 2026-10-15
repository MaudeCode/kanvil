import {
  Children,
  createContext,
  useContext,
  isValidElement,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  AlertCircle,
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
} from "lucide-react";
import { toast } from "sonner";
import { copyText } from "./lib/browser.ts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { errorMessage, stateLabels, type Ticket } from "@kanvil/contracts";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyHeader, EmptyTitle, EmptyMedia } from "@/components/ui/empty";

export { Button } from "@/components/ui/button";
export { SelectItem } from "@/components/ui/select";

export function Brand() {
  return (
    <>
      <svg
        className="brand-mark h-6 w-9 shrink-0 text-primary"
        viewBox={brandMark.viewBox}
        aria-hidden="true"
      >
        <path d={brandMark.path} fill="currentColor" />
      </svg>
      <span className="brand-word text-lg font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
        Kanvil
      </span>
    </>
  );
}

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
    <Field className="field">
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
    <Field className="field">
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
  ...props
}: Omit<ComponentProps<typeof SelectRoot<string>>, "children" | "items"> & {
  label: string;
  children: ReactNode;
  className?: string;
  layout?: "field" | "property";
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
        "field",
        layout === "property" && "mb-0 grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2",
        className,
      )}
    >
      <FieldLabel
        htmlFor={id}
        className={layout === "property" ? "text-xs font-normal text-muted-foreground" : undefined}
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
    <Field orientation="horizontal" className={cn("check w-auto", compact && "justify-center")}>
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
    <Empty className={cn("py-20", className)}>
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
export function Status({ value }: { value: Ticket["status"] }) {
  const { icon: Icon, color } = statusPresentation[value];
  return (
    <Badge
      variant="outline"
      className={cn("status gap-1.5 border-transparent bg-transparent px-0 font-normal", color)}
    >
      <Icon className="size-3.5" />
      {stateLabels[value]}
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
export function Modal({
  title,
  trigger,
  children,
  open,
  onOpenChange,
  busy = false,
}: {
  title: string;
  trigger?: ReactNode;
  busy?: boolean;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
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
          className="max-h-[90dvh] overflow-y-auto p-6 sm:max-w-2xl has-[.ticket-composer]:flex has-[.ticket-composer]:h-[min(60rem,92dvh)] has-[.ticket-composer]:max-h-none has-[.ticket-composer]:w-full has-[.ticket-composer]:max-w-none has-[.ticket-composer]:flex-col has-[.ticket-composer]:gap-0 has-[.ticket-composer]:overflow-hidden has-[.ticket-composer]:p-0 has-[.ticket-composer]:max-sm:h-dvh has-[.ticket-composer]:max-sm:rounded-none has-[.ticket-composer]:sm:w-[min(80rem,calc(100%-3rem))] has-[.ticket-composer[data-expanded=true]]:sm:w-[calc(100%-1rem)] has-[.ticket-composer[data-expanded=true]]:sm:h-[calc(100dvh-1rem)]"
          aria-describedby={undefined}
        >
          <DialogHeader className="mb-2">
            <DialogTitle className="mb-0 text-lg">{title}</DialogTitle>
          </DialogHeader>
          {children}
        </DialogContent>
      </Dialog>
    </ModalBusyContext>
  );
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

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="section-heading">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {action}
    </header>
  );
}
export function CopyValue({ label, value }: { label: string; value: string }) {
  const id = useId(),
    [copied, setCopied] = useState(false);
  return (
    <div className="copy-value">
      <span id={id}>{label}</span>
      <div role="group" aria-labelledby={id}>
        <code>{value}</code>
        <IconButton
          label={`Copy ${label.toLowerCase()}`}
          onClick={() => {
            void copyText(value)
              .then(() => {
                setCopied(true);
                toast.success(`${label} copied`);
              })
              .catch((error) => toast.error(errorMessage(error)));
          }}
        >
          {copied ? <CheckIcon /> : <Copy />}
        </IconButton>
      </div>
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
    <Collapsible defaultOpen={defaultOpen} className="disclosure">
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
      <CollapsibleContent className="disclosure-body">{children}</CollapsibleContent>
    </Collapsible>
  );
}
