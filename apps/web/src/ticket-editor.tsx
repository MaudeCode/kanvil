import { createTicketDraft, ticketDraftSchema, ticketDefaults } from "@kanvil/contracts/drafts";
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  ticketFields,
  states,
  priorities,
  kinds,
  difficulties,
  stateLabels,
  priorityLabels,
  type Ticket,
} from "@kanvil/contracts";
import { api, useIdentity, useOperation } from "./data.tsx";
import {
  Button,
  Check,
  Disclosure,
  ErrorNotice,
  Input,
  Select,
  SelectItem,
  Textarea,
  useModalBusy,
} from "./ui.tsx";
import { Maximize2, Minimize2 } from "lucide-react";
import { DialogClose } from "@/components/ui/dialog";
import { MarkdownField } from "./components/markdown-field.tsx";
import { TicketPicker } from "./components/ticket-picker.tsx";
import { TagInput } from "./components/tag-input.tsx";
import { submitOnModEnter } from "./forms.ts";
export function TicketEditor({
  projectId,
  ticket,
  onSaved,
}: {
  projectId: string;
  ticket?: Ticket;
  onSaved: (ticket: Ticket) => void;
}) {
  const setModalBusy = useModalBusy();
  const identity = useIdentity(),
    draftKey = `kanvil:${identity.id}:draft:${projectId}:${ticket?.id ?? "new"}`;
  const [draft, setDraft] = useState(() => {
    try {
      const saved = ticketDraftSchema.safeParse(
        JSON.parse(localStorage.getItem(draftKey) ?? "null"),
      );
      if (saved.success) return saved.data;
    } catch {
      /* An unreadable local draft must not prevent editing. */
    }
    return createTicketDraft(ticket);
  });
  const [expanded, setExpanded] = useState(false);
  const [validationError, setValidationError] = useState<unknown>(),
    [storageError, setStorageError] = useState<unknown>(),
    [savedLocally, setSavedLocally] = useState(false);
  const create = useOperation("create_ticket"),
    update = useOperation("update_ticket"),
    members = useQuery(api.query("list_members", { projectId }));
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
  const set = <K extends keyof typeof ticketDefaults>(key: K, value: (typeof ticketDefaults)[K]) =>
    changeDraft({ ...draft, fields: { ...draft.fields, [key]: value } });
  const fields = draft.fields,
    stale = !!ticket && draft.version !== ticket.version,
    pending = create.isPending || update.isPending;
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
      onSaved(result);
    } finally {
      setModalBusy?.(false);
    }
  }
  return (
    <form
      onSubmit={(event) => {
        setValidationError(undefined);
        void submit(event).catch(setValidationError);
      }}
      onKeyDown={submitOnModEnter}
      className="ticket-composer"
      data-expanded={expanded}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-2 right-16 hidden sm:inline-flex"
        aria-label={expanded ? "Restore composer size" : "Expand composer"}
        aria-pressed={expanded}
        disabled={pending}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <Minimize2 /> : <Maximize2 />}
      </Button>
      {stale && (
        <div role="alert" className="conflict mx-6 mt-5">
          <p>
            This ticket changed. Your draft still uses version {draft.version}; saving will require
            the current version.
          </p>
          <Button onClick={() => changeDraft(createTicketDraft(ticket))}>
            Discard draft and reload
          </Button>
        </div>
      )}
      <div className="px-6">
        <ErrorNotice error={validationError ?? create.error ?? update.error ?? storageError} />
      </div>
      <div className="composer-body">
        <div className="composer-writing">
          <Textarea
            label="Title"
            rows={2}
            value={fields.title}
            onChange={(event) => set("title", event.target.value)}
            required
            maxLength={500}
            autoFocus
            placeholder="What needs to happen?"
            className="composer-title min-h-14 resize-none border-0 bg-transparent px-1 py-1 text-2xl! font-semibold leading-snug shadow-none caret-primary focus-visible:ring-0 dark:bg-transparent"
          />
          <MarkdownField
            label="Description"
            value={fields.description}
            onChange={(value) => set("description", value)}
            rows={12}
            variant="document"
            placeholder="Add context, requirements, or a reproduction…"
          />
          <MarkdownField
            label="Acceptance criteria"
            value={fields.acceptanceCriteria}
            onChange={(value) => set("acceptanceCriteria", value)}
            rows={8}
            variant="document"
            maxLength={50000}
            placeholder="What will show that this is complete?"
          />
        </div>
        <aside className="composer-properties" aria-label="Ticket properties">
          <h3>Properties</h3>
          <Select
            label="Status"
            value={fields.status}
            onValueChange={(value) => set("status", z.enum(states).parse(value))}
          >
            {states.map((state) => (
              <SelectItem key={state} value={state}>
                {stateLabels[state]}
              </SelectItem>
            ))}
          </Select>
          <Select
            label="Priority"
            value={fields.priority}
            onValueChange={(value) => set("priority", z.enum(priorities).parse(value))}
          >
            {priorities.map((priority) => (
              <SelectItem key={priority} value={priority}>
                {priorityLabels[priority]}
              </SelectItem>
            ))}
          </Select>
          <Select
            label="Assignee"
            value={fields.assigneeId ?? ""}
            onValueChange={(value) => set("assigneeId", value || null)}
          >
            <SelectItem value="">Unassigned</SelectItem>
            {members.data?.map((member) => (
              <SelectItem key={member.userId} value={member.userId}>
                {member.name}
              </SelectItem>
            ))}
          </Select>
          <TagInput
            label="Labels"
            value={fields.labels}
            onChange={(value) => set("labels", value)}
          />
          <Disclosure
            title="More properties"
            defaultOpen={
              !!fields.difficulty || !!fields.parentId || fields.kind !== ticketDefaults.kind
            }
          >
            <Select
              label="Kind"
              value={fields.kind}
              onValueChange={(value) => set("kind", z.enum(kinds).parse(value))}
            >
              {kinds.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {kind}
                </SelectItem>
              ))}
            </Select>
            <Select
              label="Difficulty"
              value={fields.difficulty ?? ""}
              onValueChange={(value) =>
                set("difficulty", value ? z.enum(difficulties).parse(value) : null)
              }
            >
              <SelectItem value="">Unspecified</SelectItem>
              {difficulties.map((difficulty) => (
                <SelectItem key={difficulty} value={difficulty}>
                  {difficulty}
                </SelectItem>
              ))}
            </Select>
            <TicketPicker
              label="Parent ticket"
              projectId={projectId}
              value={fields.parentId}
              onChange={(value) => set("parentId", value)}
              exclude={ticket ? [ticket.id] : []}
            />
          </Disclosure>
          <Disclosure
            title="Automation"
            defaultOpen={fields.automationReady || !!fields.holdReason || fields.scopes.length > 0}
          >
            <Check
              label="Ready for agents"
              checked={fields.automationReady}
              onCheckedChange={(checked) => set("automationReady", checked)}
            />
            <p className="mb-4 text-xs text-muted-foreground">
              Claims still depend on requirements, blockers, and current ownership.
            </p>
            <TagInput
              label="Scopes"
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
          </Disclosure>
          <ErrorNotice error={members.error} />
        </aside>
      </div>
      <footer className="composer-footer">
        <span className="text-xs text-muted-foreground" role="status">
          {savedLocally
            ? "Draft saved on this device"
            : storageError
              ? "Draft could not be saved"
              : ""}
        </span>
        <div className="actions">
          <DialogClose render={<Button disabled={pending} />}>Cancel</DialogClose>
          <Button type="submit" variant="default" disabled={pending || stale}>
            {pending ? "Saving…" : "Save ticket"}
            <kbd aria-hidden="true" className="ml-2 hidden text-[10px] opacity-70 sm:inline">
              ⌘/Ctrl ↵
            </kbd>
          </Button>
        </div>
      </footer>
    </form>
  );
}
