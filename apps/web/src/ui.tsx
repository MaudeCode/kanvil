import {
  Children,
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
  XCircle,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { errorMessage, stateLabels, type Ticket } from "@kanvil/contracts";
import { brandMark } from "@kanvil/contracts/theme";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input as TextInput } from "@/components/ui/input";
import { Textarea as TextareaInput } from "@/components/ui/textarea";
import { Field, FieldLabel } from "@/components/ui/field";
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
  const id = useId();
  return (
    <Field className="field">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <TextInput {...props} id={id} />
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
  ...props
}: Omit<ComponentProps<typeof SelectRoot<string>>, "children" | "items"> & {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const items = Children.toArray(children).flatMap((child) =>
    isValidElement<{ value: string; children: ReactNode }>(child)
      ? [{ value: child.props.value, label: child.props.children }]
      : [],
  );
  return (
    <Field className={cn("field", className)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <SelectRoot items={items} defaultValue={items[0]?.value ?? ""} {...props}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>{children}</SelectContent>
      </SelectRoot>
    </Field>
  );
}
export function Check({
  label,
  className,
  ...props
}: ComponentProps<typeof Checkbox> & { label: string }) {
  const id = useId();
  const compact = className === "sr-checkbox";
  return (
    <Field orientation="horizontal" className={cn("check w-auto", compact && "justify-center")}>
      <Checkbox {...props} id={id} />
      <FieldLabel htmlFor={id} className={cn("font-normal", compact && "sr-only")}>
        {label}
      </FieldLabel>
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
}: {
  title: string;
  icon?: typeof CircleDashed;
  children?: ReactNode;
}) {
  return (
    <Empty className="py-20">
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
export function Modal({
  title,
  trigger,
  children,
  open,
  onOpenChange,
}: {
  title: string;
  trigger?: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Dialog {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      {trigger && <DialogTrigger render={<Button variant="outline" />}>{trigger}</DialogTrigger>}
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto p-6 sm:max-w-2xl"
        aria-describedby={undefined}
      >
        <DialogHeader className="mb-2">
          <DialogTitle className="text-lg">{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function Confirm({
  label,
  description,
  onConfirm,
  danger = false,
  icon,
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
              <IconButton label={label} />
            ) : (
              <Button variant={danger ? "destructive" : "outline"} />
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
