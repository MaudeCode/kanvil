import {
  createTicketDraft,
  draftFields,
  ticketDraftSchema,
  ticketDefaults,
} from "@kanvil/contracts/drafts";
import { useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, type Ticket } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { z } from "zod";
import { api, useIdentity, useOperation } from "./data.tsx";
import { Button, ErrorNotice, Input, Textarea, reportError, useModalBusy } from "./ui.tsx";
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
import { Switch } from "@/components/ui/switch";
import { Toggle } from "@/components/ui/toggle";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MarkdownField } from "./components/markdown-field.tsx";
import { TicketPicker } from "./components/ticket-picker.tsx";
import { ScheduleDates } from "./components/date-picker.tsx";
import { TagInput } from "./components/tag-input.tsx";
import { ProjectLabelProvider } from "./components/project-label-provider.tsx";
import {
  CustomFieldProperties,
  ProjectProperty,
  TagsProperty,
  TicketProperty,
  parseStatus,
  statusValue,
} from "./components/ticket-property.tsx";
import { submitOnModEnter } from "./forms.ts";
import { useInlineUpload } from "./ticket-resources.tsx";
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
  const [base, setBase] = useState(() => {
    const draft = createTicketDraft(ticket);
    return initial ? { ...draft, fields: { ...draft.fields, ...initial } } : draft;
  });
  const [draft, setDraftState] = useState(() => {
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
  // The latest draft for handlers that finish after an await, such as a project change.
  const latest = useRef(draft);
  function setDraft(next: typeof draft) {
    latest.current = next;
    setDraftState(next);
  }
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
    [savedLocally, setSavedLocally] = useState(false),
    [createMore, setCreateMore] = useState(false),
    [created, setCreated] = useState<string>();
  const create = useOperation("create_ticket"),
    update = useOperation("update_ticket"),
    discard = useOperation("discard_upload"),
    cache = useQueryClient(),
    titleField = useRef<HTMLTextAreaElement>(null),
    submitting = useRef(false),
    switches = useRef(0),
    [switching, setSwitching] = useState(false);
  function changeDraft(next: typeof draft) {
    setDraft(next);
    setCreated(undefined);
    try {
      localStorage.setItem(draftKey, JSON.stringify(next));
      setStorageError(undefined);
      setSavedLocally(true);
    } catch {
      setStorageError(new Error(t("detail.editor.storageUnavailable")));
      setSavedLocally(false);
    }
  }
  function discardDraft() {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* Nothing to clear when storage is unavailable. */
    }
    discardUploads(latest.current.uploads);
    setDraft(base);
    setSavedLocally(false);
  }
  // Staged files the ticket will not claim. Unclaimed uploads also expire on the server, so a
  // failed discard needs no retry.
  function discardUploads(ids: string[]) {
    for (const uploadId of ids)
      discard.mutateAsync({ projectId: target, uploadId }).catch(() => {});
  }
  const setFields = (change: Partial<Fields>) =>
    changeDraft({ ...latest.current, fields: { ...latest.current.fields, ...change } });
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => setFields({ [key]: value });
  const setCustomField = (fieldId: string, value: Fields["customFields"][string]) =>
    set("customFields", { ...latest.current.fields.customFields, [fieldId]: value });
  // A new ticket may target another writable project; its parent and assignee must belong there.
  // The target applies at once, and submitting waits until the assignee is checked against the
  // latest choice, so a ticket never goes to the previous project or with a stale assignee.
  async function changeProject(next: string) {
    const switchId = ++switches.current;
    changeDraft({
      ...latest.current,
      projectId: next === projectId ? undefined : next,
      // A state and custom fields belong to one project; the status category carries over and the
      // new project's field defaults apply.
      fields: { ...latest.current.fields, parentId: null, stateId: null, customFields: {} },
    });
    setSwitching(true);
    let members: { userId: string }[] = [];
    try {
      members = await cache.ensureQueryData(api.query("list_members", { projectId: next }));
    } finally {
      if (switchId === switches.current) {
        const current = latest.current,
          { assigneeId } = current.fields;
        if (assigneeId && !members.some((member) => member.userId === assigneeId))
          changeDraft({ ...current, fields: { ...current.fields, assigneeId: null } });
        setSwitching(false);
      }
    }
  }
  const fields = draft.fields,
    target = draft.projectId ?? projectId,
    stale = !!ticket && draft.version !== ticket.version,
    dirty =
      JSON.stringify(draft.fields) !== JSON.stringify(base.fields) ||
      draft.projectId !== base.projectId,
    pending = create.isPending || update.isPending,
    blocked = pending || stale || switching,
    automation = fields.automationReady || fields.scopes.length > 0 || !!fields.holdReason;
  // Files embedded in a new ticket's text are staged in its project until it is created.
  const inlineUpload = useInlineUpload(
    target,
    ticket
      ? { ticketId: ticket.id }
      : {
          onStaged: (uploadId) =>
            changeDraft({ ...latest.current, uploads: [...latest.current.uploads, uploadId] }),
        },
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The ref also stops a second ⌘↵ that lands before the pending state renders.
    if (blocked || submitting.current) return;
    const values = draftFields(fields);
    // Only the staged files the text still embeds become attachments; removed ones are discarded.
    const claimed = draft.uploads.filter(
      (id) => fields.description.includes(id) || fields.acceptanceCriteria.includes(id),
    );
    submitting.current = true;
    setModalBusy?.(true);
    try {
      const result = ticket
        ? await update.mutateAsync({
            projectId,
            ticketId: ticket.id,
            expectedVersion: draft.version ?? ticket.version,
            changes: values,
          })
        : await create
            .mutateAsync({ projectId: target, ...values, uploads: claimed })
            .catch((error: unknown) => {
              forgetExpired(error);
              throw error;
            });
      if (!ticket) discardUploads(draft.uploads.filter((id) => !claimed.includes(id)));
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* A completed write must not be repeated because local storage is unavailable. */
      }
      if (ticket || !createMore) {
        toast.success(
          ticket
            ? t("detail.editor.saved", { key: result.key })
            : t("detail.editor.created", { key: result.key }),
        );
        return onSaved(result);
      }
      // Keep the project and reusable properties; the next ticket starts with a clean text. Text
      // already typed for it while this one saved stays and is saved as its draft. The footer
      // status announces the key, so no toast covers the footer on narrow screens.
      const current = latest.current.fields,
        typed = (key: "title" | "description" | "acceptanceCriteria") =>
          current[key] === fields[key] ? "" : current[key],
        next = {
          ...latest.current,
          uploads: latest.current.uploads.filter((id) => !draft.uploads.includes(id)),
          fields: {
            ...current,
            title: typed("title"),
            description: typed("description"),
            acceptanceCriteria: typed("acceptanceCriteria"),
          },
        };
      setBase({
        ...next,
        fields: { ...next.fields, title: "", description: "", acceptanceCriteria: "" },
      });
      if (next.fields.title || next.fields.description || next.fields.acceptanceCriteria)
        changeDraft(next);
      else {
        setDraft(next);
        setSavedLocally(false);
      }
      setCriteriaOpen(!!next.fields.acceptanceCriteria);
      setCreated(result.key);
      titleField.current?.focus();
    } finally {
      submitting.current = false;
      setModalBusy?.(false);
    }
  }
  // An upload that expired or was discarded elsewhere cannot be claimed; drop it from the draft so
  // the next attempt can create the ticket without it.
  function forgetExpired(error: unknown) {
    const missing =
      error instanceof ApiError &&
      z.object({ uploads: z.array(z.string()) }).safeParse(error.details).data?.uploads;
    if (missing)
      changeDraft({
        ...latest.current,
        uploads: latest.current.uploads.filter((id) => !missing.includes(id)),
      });
  }
  // Staged files belong to the target project, so it stays while the draft has any.
  const projectLocked = pending || draft.uploads.length > 0;
  const pills = (
    <div
      className="-mt-3 flex flex-wrap items-center gap-1"
      aria-label={t("detail.editor.properties")}
    >
      {!ticket && (
        <ProjectProperty
          value={target}
          disabled={projectLocked}
          onChange={(next) => void changeProject(next).catch(reportError)}
        />
      )}
      <TicketProperty
        property="status"
        projectId={target}
        value={statusValue(fields)}
        onChange={(value) => setFields(parseStatus(value))}
      />
      <TicketProperty
        property="priority"
        projectId={target}
        value={fields.priority}
        onChange={(priority) => set("priority", priority)}
      />
      <TicketProperty
        property="assignee"
        projectId={target}
        value={fields.assigneeId}
        onChange={(assignee) => set("assigneeId", assignee)}
      />
      <TicketProperty
        property="kind"
        projectId={target}
        value={fields.kind}
        onChange={(kind) => set("kind", kind)}
      />
      <TicketProperty
        property="difficulty"
        projectId={target}
        value={fields.difficulty}
        onChange={(difficulty) => set("difficulty", difficulty)}
      />
      <TagsProperty value={fields.labels} onChange={(value) => set("labels", value)} />
      <ScheduleDates variant="pill" value={fields} onChange={setFields} />
      <CustomFieldProperties
        variant="pill"
        projectId={target}
        values={fields.customFields}
        isNew={!ticket}
        onChange={setCustomField}
      />
      <TicketPicker
        variant="pill"
        label={t("detail.field.parentTicket")}
        placeholder={t("detail.field.parent")}
        projectId={target}
        value={fields.parentId}
        onChange={(value) => set("parentId", value)}
        exclude={ticket ? [ticket.id] : []}
      />
      <Toggle
        size="sm"
        className={cn(pill, "gap-1.5")}
        pressed={fields.automationReady}
        onPressedChange={(pressed) => set("automationReady", pressed)}
        aria-label={t("detail.editor.readyForAgents")}
        title={t("detail.editor.readyForAgentsHelp")}
      >
        <Bot className="size-3.5 text-muted-foreground" aria-hidden="true" />
        {fields.automationReady ? t("detail.editor.readyForAgents") : t("detail.editor.agents")}
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
              aria-label={t("detail.editor.moreProperties")}
            />
          }
        >
          <SlidersHorizontal className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-4">
          <TagInput
            label={t("detail.field.scopes")}
            kind="scope"
            value={fields.scopes}
            onChange={(value) => set("scopes", value)}
          />
          <Input
            label={t("detail.field.holdReason")}
            value={fields.holdReason ?? ""}
            maxLength={2000}
            placeholder={t("detail.editor.holdPlaceholder")}
            onChange={(event) => set("holdReason", event.target.value || null)}
          />
          <p className="mb-0 text-xs text-muted-foreground">{t("detail.editor.claimsNote")}</p>
        </PopoverContent>
      </Popover>
    </div>
  );
  const form = (
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
        aria-label={expanded ? t("detail.editor.restoreSize") : t("detail.editor.expand")}
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
              <AlertTitle>{t("detail.editor.staleTitle")}</AlertTitle>
              <AlertDescription>
                {t("detail.editor.staleDescription", { version: draft.version })}
                <Button
                  size="sm"
                  className="mt-2"
                  onClick={() => changeDraft(createTicketDraft(ticket))}
                >
                  {t("detail.editor.discardAndReload")}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <ErrorNotice error={validationError ?? create.error ?? update.error ?? storageError} />
          <div className="[&_[data-slot=field-label]]:sr-only">
            <Textarea
              label={t("detail.field.title")}
              rows={1}
              value={fields.title}
              onChange={(event) => set("title", event.target.value)}
              required
              maxLength={500}
              autoFocus
              ref={titleField}
              placeholder={t("detail.editor.titlePlaceholder")}
              className="field-sizing-content min-h-10 resize-none border-0 bg-transparent px-0 py-1 text-xl! font-semibold leading-snug shadow-none caret-primary focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
          {!expanded && pills}
          <MarkdownField
            label={t("detail.field.description")}
            value={fields.description}
            onChange={(value) => set("description", value)}
            rows={8}
            variant="document"
            placeholder={t("detail.editor.descriptionPlaceholder")}
            onUpload={inlineUpload}
          />
          {criteriaOpen ? (
            <div className="relative">
              <MarkdownField
                label={t("detail.field.acceptanceCriteria")}
                value={fields.acceptanceCriteria}
                onChange={(value) => set("acceptanceCriteria", value)}
                rows={4}
                variant="document"
                maxLength={50000}
                placeholder={t("detail.editor.criteriaPlaceholder")}
                onUpload={inlineUpload}
              />
              {!fields.acceptanceCriteria && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="absolute top-5 right-24 text-muted-foreground"
                  aria-label={t("detail.editor.removeCriteria")}
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
              {t("detail.editor.addCriteria")}
            </Button>
          )}
        </div>
        {expanded && (
          <aside
            className="border-t bg-muted/20 p-5 lg:sticky lg:top-0 lg:min-h-full lg:border-t-0 lg:border-l"
            aria-label={t("detail.editor.properties")}
          >
            <div className="space-y-1">
              {!ticket && (
                <ProjectProperty
                  variant="row"
                  value={target}
                  disabled={projectLocked}
                  onChange={(next) => void changeProject(next).catch(reportError)}
                />
              )}
              <TicketProperty
                variant="row"
                property="status"
                projectId={target}
                value={statusValue(fields)}
                onChange={(value) => setFields(parseStatus(value))}
              />
              <TicketProperty
                variant="row"
                property="priority"
                projectId={target}
                value={fields.priority}
                onChange={(priority) => set("priority", priority)}
              />
              <TicketProperty
                variant="row"
                property="assignee"
                projectId={target}
                value={fields.assigneeId}
                onChange={(assignee) => set("assigneeId", assignee)}
              />
              <TicketProperty
                variant="row"
                property="kind"
                projectId={target}
                value={fields.kind}
                onChange={(kind) => set("kind", kind)}
              />
              <TicketProperty
                variant="row"
                property="difficulty"
                projectId={target}
                value={fields.difficulty}
                onChange={(difficulty) => set("difficulty", difficulty)}
              />
              <ScheduleDates variant="row" value={fields} onChange={setFields} />
              <CustomFieldProperties
                variant="row"
                projectId={target}
                values={fields.customFields}
                isNew={!ticket}
                onChange={setCustomField}
              />
              <div className="grid grid-cols-[80px_minmax(0,1fr)] items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("detail.editor.agents")}</span>
                <Toggle
                  size="sm"
                  className={cn(pill, "h-7 justify-start gap-1.5")}
                  pressed={fields.automationReady}
                  onPressedChange={(pressed) => set("automationReady", pressed)}
                  aria-label={t("detail.editor.readyForAgents")}
                >
                  <Bot className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  {fields.automationReady
                    ? t("detail.editor.readyForAgents")
                    : t("detail.editor.notReady")}
                </Toggle>
              </div>
            </div>
            <div className="mt-6 border-t pt-5">
              <TagInput
                label={t("detail.field.labels")}
                value={fields.labels}
                onChange={(value) => set("labels", value)}
              />
              <TicketPicker
                label={t("detail.field.parentTicket")}
                projectId={target}
                value={fields.parentId}
                onChange={(value) => set("parentId", value)}
                exclude={ticket ? [ticket.id] : []}
              />
              <TagInput
                label={t("detail.field.scopes")}
                kind="scope"
                value={fields.scopes}
                onChange={(value) => set("scopes", value)}
              />
              <Input
                label={t("detail.field.holdReason")}
                value={fields.holdReason ?? ""}
                maxLength={2000}
                placeholder={t("detail.editor.holdPlaceholder")}
                onChange={(event) => set("holdReason", event.target.value || null)}
              />
            </div>
          </aside>
        )}
      </div>
      <footer className="z-10 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t bg-muted/40 px-5 py-3">
        <span className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          {created
            ? t("detail.editor.created", { key: created })
            : savedLocally
              ? t("detail.editor.savedLocally")
              : storageError
                ? t("detail.editor.notSavedLocally")
                : ""}
          {dirty && !stale && (
            <Button variant="ghost" size="xs" disabled={pending} onClick={discardDraft}>
              <RotateCcw />
              {t("detail.editor.discardDraft")}
            </Button>
          )}
        </span>
        <div className="flex items-center gap-2">
          {!ticket && (
            <label className="mr-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                size="sm"
                checked={createMore}
                disabled={pending}
                onCheckedChange={setCreateMore}
              />
              {t("detail.editor.createMore")}
            </label>
          )}
          <DialogClose render={<Button disabled={pending} />}>
            {t("common.action.cancel")}
          </DialogClose>
          <Button type="submit" variant="default" disabled={blocked}>
            {pending ? <Spinner /> : null}
            {pending
              ? t("common.state.saving")
              : ticket
                ? t("detail.editor.save")
                : t("detail.editor.create")}
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
  return <ProjectLabelProvider projectId={target}>{form}</ProjectLabelProvider>;
}
