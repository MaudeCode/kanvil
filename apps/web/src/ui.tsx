import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { errorMessage, stateLabels, stateTones, type Ticket } from "@kanvil/contracts";
import { brandMark } from "@kanvil/contracts/theme";

export function Brand() {
  return (
    <>
      <svg className="brand-mark" viewBox={brandMark.viewBox} aria-hidden="true">
        <path d={brandMark.path} fill="currentColor" />
      </svg>
      <span>Kanvil</span>
    </>
  );
}

export function Button({ className = "", ...props }: ComponentProps<"button">) {
  return <button type="button" className={`button ${className}`} {...props} />;
}

export function Input({ label, ...props }: ComponentProps<"input"> & { label: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input {...props} id={id} />
    </div>
  );
}
export function Textarea({ label, ...props }: ComponentProps<"textarea"> & { label: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea {...props} id={id} />
    </div>
  );
}
export function Select({
  label,
  children,
  ...props
}: ComponentProps<"select"> & { label: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select {...props} id={id}>
        {children}
      </select>
    </div>
  );
}
export function Check({ label, ...props }: ComponentProps<"input"> & { label: string }) {
  return (
    <label className="check">
      <input type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  );
}
export function ErrorNotice({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="error">
      {errorMessage(error)}
    </p>
  ) : null;
}
export function Loading() {
  return (
    <p className="muted" role="status">
      Loading…
    </p>
  );
}
export function Status({ value }: { value: Ticket["status"] }) {
  return (
    <span className="status" style={{ color: `var(--${stateTones[value]})` }}>
      <span aria-hidden="true">●</span>
      {stateLabels[value]}
    </span>
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
    <Dialog.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {trigger && <Dialog.Trigger className="button">{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop" />
        <Dialog.Popup className="dialog">
          <header>
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="button icon" aria-label="Close">
              <X size={20} />
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Confirm({
  label,
  description,
  onConfirm,
  danger = false,
}: {
  label: string;
  description: string;
  onConfirm: () => Promise<unknown>;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>();
  return (
    <>
      <Button className={danger ? "danger" : ""} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Modal title={label} open={open} onOpenChange={setOpen}>
        <p>{description}</p>
        <ErrorNotice error={error} />
        <div className="actions">
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            className={danger ? "danger" : "primary"}
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
          </Button>
        </div>
      </Modal>
    </>
  );
}
