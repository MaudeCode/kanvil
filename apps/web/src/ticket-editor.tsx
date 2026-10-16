import { createTicketDraft, ticketDraftSchema, ticketDefaults } from "@kanvil/contracts/drafts";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ticketFields, type Ticket } from "@kanvil/contracts";
import { useIdentity, useOperation } from "./data.tsx";
import { Button, ErrorNotice, Input, Textarea, useModalBusy } from "./ui.tsx";
import {
  Maximize2,
  Minimize2,
  RotateCcw,
  AlertTriangle,
  Bot,
  ListChecks,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { DialogClose } from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MarkdownField } from "./components/markdown-field.tsx";
import { TicketPicker } from "./components/ticket-picker.tsx";
import { DatePicker, endOfDay } from "./components/date-picker.tsx";
import { TagInput } from "./components/tag-input.tsx";
import { TagsProperty, TicketProperty } from "./components/ticket-property.tsx";
import { submitOnModEnter } from "./forms.ts";
import { cn } from "@/lib/utils";

type Fields = typeof ticketDefaults;
const pill =
  "h-7 max-w-64 min-w-0 border border-transparent px-2 font-normal hover:border-border aria-pressed:border-border aria-pressed:bg-muted";
export function TicketEditor({
  projectId,
  ticket,
  initial,
  onSaved,
}: {
  projectId: string;
  ticket?: Ticket;
  initial?: Partial<Fields>;
  onSaved: (ticket: Ticket) => void;
}) {
  const setModalBusy = useModalBusy();
  const identity = useIdentity(),
    draftKey = `kanvil:${identity.id}:draft:${projectId}:${ticket?.id ?? `new:${initial?.parentId ?? ""}`}`;
  const [base] = useState(() => {
    const draft = createTicketDraft(ticket);
    return initial ? { ...draft, fields: { ...draft.fields, ...initial } } : draft;
  });
  const [draft, setDraft] = useState(() => {
    try {
      const saved = ticketDraftSchema.safeParse(
        JSON.parse(localStorage.getItem(draftKey) ?? "null"),
      );
      if (saved.success) return saved.data;
    } catch {
      /* An unreadable local draft must not prevent editing. */
    }
    return base;
  });
  const expandedKey = "kanvil:composer-expanded";
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(expandedKey) === "1";
    } catch {
      return false;
    }
  });
  function toggleExpanded() {
    setExpanded((value) => {
      try {
        localStorage.setItem(expandedKey, value ? "0" : "1");
      } catch {
        /* The preference is optional. */
      }
      return !value;
    });
  }
  const [criteriaOpen, setCriteriaOpen] = useState(() => !!draft.fields.acceptanceCriteria);
  const [validationError, setValidationError] = useState<unknown>(),
    [storageError, setStorageError] = useState<unknown>(),
    [savedLocally, setSavedLocally] = useState(false);
  const create = useOperation("create_ticket"),
    update = useOperation("update_ticket");
  function changeDraft(next: typeof draft) {
    setDraft(next);
    try {
      localStorage.setItem(draftKey, JSON.stringify(next));
      setStorageError(undefined);
      setSavedLocally(true);
    } catch {
      setStorageError(
        new Error("This browser cannot save your draft. Keep the editor open until you save."),
      );
      setSavedLocally(false);
    }
  }
  function discardDraft() {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* Nothing to clear when storage is unavailable. */
    }
    setDraft(base);
    setSavedLocally(false);
  }
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) =>
    changeDraft({ ...draft, fields: { ...draft.fields, [key]: value } });
  const fields = draft.fields,
    stale = !!ticket && draft.version !== ticket.version,
    dirty = JSON.stringify(draft.fields) !== JSON.stringify(base.fields),
    pending = create.isPending || update.isPending,
    automation = fields.automationReady || fields.scopes.length > 0 || !!fields.holdReason;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stale || pending) return;
    const values = ticketFields.parse(fields);
    setModalBusy?.(true);
    try {
      const result = ticket
        ? await update.mutateAsync({
            projectId,
            ticketId: ticket.id,
            expectedVersion: draft.version ?? ticket.version,
            changes: values,
          })
        : await create.mutateAsync({ projectId, ...values });
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* A completed write must not be repeated because local storage is unavailable. */
      }
      toast.success(ticket ? `${result.key} saved` : `${result.key} created`);
      onSaved(result);
    } finally {
      setModalBusy?.(false);
    }
  }
  const pills = (
    <div className="-mt-3 flex flex-wrap items-center gap-1" aria-label="Ticket properties">
      <TicketProperty
        property="status"
        projectId={projectId}
        value={fields.status}
        onChange={(status) => set("status", status)}
      />
      <TicketProperty
        property="priority"
        projectId={projectId}
        value={fields.priority}
        onChange={(priority) => set("priority", priority)}
      />
      <TicketProperty
        property="assignee"
        projectId={projectId}
        value={fields.assigneeId}
        onChange={(assignee) => set("assigneeId", assignee)}
      />
      <TicketProperty
        property="kind"
        projectId={projectId}
        value={fields.kind}
        onChange={(kind) => set("kind", kind)}
      />
      <TicketProperty
        property="difficulty"
        projectId={projectId}
        value={fields.difficulty}
        onChange={(difficulty) => set("difficulty", difficulty)}
      />
      <TagsProperty value={fields.labels} onChange={(value) => set("labels", value)} />
      <DatePicker
        variant="pill"
        label="Due date"
        placeholder="Due"
        value={fields.dueAt ? new Date(fields.dueAt) : null}
        onChange={(date) => set("dueAt", date ? endOfDay(date) : null)}
      />
      <TicketPicker
        variant="pill"
        label="Parent ticket"
        placeholder="Parent"
        projectId={projectId}
        value={fields.parentId}
        onChange={(value) => set("parentId", value)}
        exclude={ticket ? [ticket.id] : []}
      />
      <Toggle
        size="sm"
        className={cn(pill, "gap-1.5")}
        pressed={fields.automationReady}
        onPressedChange={(pressed) => set("automationReady", pressed)}
        aria-label="Ready for agents"
        title="Agents may claim this ticket once requirements, blockers, and ownership allow it"
      >
        <Bot className="size-3.5 text-muted-foreground" aria-hidden="true" />
        {fields.automationReady ? "Ready for agents" : "Agents"}
      </Toggle>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(
                "size-7 border border-transparent hover:border-border",
                automation && "text-primary",
              )}
              aria-label="More properties"
            />
          }
        >
          <SlidersHorizontal className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-4">
          <TagInput
            label="Scopes"
            kind="scope"
            value={fields.scopes}
            onChange={(value) => set("scopes", value)}
          />
          <Input
            label="Hold reason"
            value={fields.holdReason ?? ""}
            maxLength={2000}
            placeholder="Why should work wait?"
            onChange={(event) => set("holdReason", event.target.value || null)}
          />
          <p className="mb-0 text-xs text-muted-foreground">
            Claims still depend on requirements, blockers, and current ownership.
          </p>
        </PopoverContent>
      </Popover>
    </div>
  );
  return (
    <form
      onSubmit={(event) => {
        setValidationError(undefined);
        void submit(event).catch(setValidationError);
      }}
      onKeyDown={submitOnModEnter}
      className="ticket-composer flex min-h-0 flex-1 flex-col"
      data-expanded={expanded}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-2 right-11 hidden sm:inline-flex"
        aria-label={expanded ? "Restore composer size" : "Expand composer"}
        aria-pressed={expanded}
        disabled={pending}
        onClick={toggleExpanded}
      >
        {expanded ? <Minimize2 /> : <Maximize2 />}
      </Button>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain",
          expanded && "lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start",
        )}
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-5 py-5 sm:px-8">
          {stale && (
            <Alert className="w-auto">
              <AlertTriangle />
              <AlertTitle>This ticket changed.</AlertTitle>
              <AlertDescription>
                Your draft still uses version {draft.version}; saving will require the current
                version.
                <Button
                  size="sm"
                  className="mt-2"
                  onClick={() => changeDraft(createTicketDraft(ticket))}
                >
                  Discard draft and reload
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <ErrorNotice error={validationError ?? create.error ?? update.error ?? storageError} />
          <div className="[&_[data-slot=field-label]]:sr-only">
            <Textarea
              label="Title"
              rows={1}
              value={fields.title}
              onChange={(event) => set("title", event.target.value)}
              required
              maxLength={500}
              autoFocus
              placeholder="Ticket title"
              className="field-sizing-content min-h-10 resize-none border-0 bg-transparent px-0 py-1 text-xl! font-semibold leading-snug shadow-none caret-primary focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
          {!expanded && pills}
          <MarkdownField
            label="Description"
            value={fields.description}
            onChange={(value) => set("description", value)}
            rows={8}
            variant="document"
            placeholder="Add context, requirements, or a reproduction…"
          />
          {criteriaOpen ? (
            <div className="relative">
              <MarkdownField
                label="Acceptance criteria"
                value={fields.acceptanceCriteria}
                onChange={(value) => set("acceptanceCriteria", value)}
                rows={4}
                variant="document"
                maxLength={50000}
                placeholder="- [ ] What will show that this is complete?"
              />
              {!fields.acceptanceCriteria && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="absolute top-5 right-24 text-muted-foreground"
                  aria-label="Remove acceptance criteria"
                  onClick={() => setCriteriaOpen(false)}
                >
                  <X />
                </Button>
              )}
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="w-fit text-muted-foreground"
              onClick={() => setCriteriaOpen(true)}
            >
              <ListChecks />
              Add acceptance criteria
            </Button>
          )}
        </div>
        {expanded && (
          <aside
            className="border-t bg-muted/20 p-5 lg:sticky lg:top-0 lg:min-h-full lg:border-t-0 lg:border-l"
            aria-label="Ticket properties"
          >
            <div className="space-y-1">
              <TicketProperty
                variant="row"
                property="status"
                projectId={projectId}
                value={fields.status}
                onChange={(status) => set("status", status)}
              />
              <TicketProperty
                variant="row"
                property="priority"
                projectId={projectId}
                value={fields.priority}
                onChange={(priority) => set("priority", priority)}
              />
              <TicketProperty
                variant="row"
                property="assignee"
                projectId={projectId}
                value={fields.assigneeId}
                onChange={(assignee) => set("assigneeId", assignee)}
              />
              <TicketProperty
                variant="row"
                property="kind"
                projectId={projectId}
                value={fields.kind}
                onChange={(kind) => set("kind", kind)}
              />
              <TicketProperty
                variant="row"
                property="difficulty"
                projectId={projectId}
                value={fields.difficulty}
                onChange={(difficulty) => set("difficulty", difficulty)}
              />
              <DatePicker
                variant="row"
                label="Due date"
                placeholder="No due date"
                value={fields.dueAt ? new Date(fields.dueAt) : null}
                onChange={(date) => set("dueAt", date ? endOfDay(date) : null)}
              />
              <div className="grid grid-cols-[80px_minmax(0,1fr)] items-center gap-2">
                <span className="text-xs text-muted-foreground">Agents</span>
                <Toggle
                  size="sm"
                  className={cn(pill, "h-7 justify-start gap-1.5")}
                  pressed={fields.automationReady}
                  onPressedChange={(pressed) => set("automationReady", pressed)}
                  aria-label="Ready for agents"
                >
                  <Bot className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  {fields.automationReady ? "Ready for agents" : "Not ready"}
                </Toggle>
              </div>
            </div>
            <div className="mt-6 border-t pt-5">
              <TagInput
                label="Labels"
                value={fields.labels}
                onChange={(value) => set("labels", value)}
              />
              <TicketPicker
                label="Parent ticket"
                projectId={projectId}
                value={fields.parentId}
                onChange={(value) => set("parentId", value)}
                exclude={ticket ? [ticket.id] : []}
              />
              <TagInput
                label="Scopes"
                kind="scope"
                value={fields.scopes}
                onChange={(value) => set("scopes", value)}
              />
              <Input
                label="Hold reason"
                value={fields.holdReason ?? ""}
                maxLength={2000}
                placeholder="Why should work wait?"
                onChange={(event) => set("holdReason", event.target.value || null)}
              />
            </div>
          </aside>
        )}
      </div>
      <footer className="z-10 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t bg-muted/40 px-5 py-3">
        <span className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          {savedLocally
            ? "Draft saved on this device"
            : storageError
              ? "Draft could not be saved"
              : ""}
          {dirty && !stale && (
            <Button variant="ghost" size="xs" disabled={pending} onClick={discardDraft}>
              <RotateCcw />
              Discard draft
            </Button>
          )}
        </span>
        <div className="flex items-center gap-2">
          <DialogClose render={<Button disabled={pending} />}>Cancel</DialogClose>
          <Button type="submit" variant="default" disabled={pending || stale}>
            {pending ? <Spinner /> : null}
            {pending ? "Saving…" : ticket ? "Save ticket" : "Create ticket"}
            {!pending && (
              <Kbd
                aria-hidden="true"
                className="ml-1 hidden border-transparent bg-primary-foreground/20 text-primary-foreground shadow-none sm:inline-flex"
              >
                ⌘↵
              </Kbd>
            )}
          </Button>
        </div>
      </footer>
    </form>
  );
}
