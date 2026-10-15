import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  createTicketDraft,
  ticketDraftSchema,
  ticketDefaults,
  splitTags,
} from "@kanvil/contracts/drafts";
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
  ErrorNotice,
  Input,
  Markdown,
  Select,
  SelectItem,
  Textarea,
} from "./ui.tsx";

export function TicketEditor({
  projectId,
  ticket,
  onSaved,
}: {
  projectId: string;
  ticket?: Ticket;
  onSaved: (ticket: Ticket) => void;
}) {
  const identity = useIdentity();
  const draftKey = `kanvil:${identity.id}:draft:${projectId}:${ticket?.id ?? "new"}`;
  const [draft, setDraft] = useState(() => {
    try {
      const saved = ticketDraftSchema.safeParse(
        JSON.parse(localStorage.getItem(draftKey) ?? "null"),
      );
      if (saved.success) return saved.data;
    } catch {
      /* A damaged draft must not block the editor. */
    }
    return createTicketDraft(ticket);
  });
  const [validationError, setValidationError] = useState<unknown>();
  const [labels, setLabels] = useState(draft.fields.labels.join(", ")),
    [scopesText, setScopesText] = useState(draft.fields.scopes.join(", "));
  const [preview, setPreview] = useState(false),
    [storageError, setStorageError] = useState<unknown>();
  const create = useOperation("create_ticket"),
    update = useOperation("update_ticket");
  const members = useQuery(api.query("list_members", { projectId }));
  const set = <K extends keyof typeof ticketDefaults>(key: K, value: (typeof ticketDefaults)[K]) =>
    changeDraft({ ...draft, fields: { ...draft.fields, [key]: value } });
  function changeDraft(next: typeof draft) {
    setDraft(next);
    try {
      localStorage.setItem(draftKey, JSON.stringify(next));
      setStorageError(undefined);
    } catch {
      setStorageError(
        new Error("This browser cannot save your draft. Keep the editor open until you save."),
      );
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = ticketFields.parse({
      ...draft.fields,
      labels: splitTags(labels),
      scopes: splitTags(scopesText),
    });
    const result = ticket
      ? await update.mutateAsync({
          projectId,
          ticketId: ticket.id,
          expectedVersion: draft.version ?? ticket.version,
          changes: fields,
        })
      : await create.mutateAsync({ projectId, ...fields });

    localStorage.removeItem(draftKey);
    onSaved(result);
  }
  const fields = draft.fields,
    stale = ticket && draft.version !== ticket.version;
  return (
    <form
      onSubmit={(event) => {
        setValidationError(undefined);
        void submit(event).catch(setValidationError);
      }}
      className="editor"
    >
      {stale && (
        <div role="alert" className="conflict">
          <p>
            This ticket changed. Your draft still uses version {draft.version}; saving will require
            the current version.
          </p>
          <Button
            onClick={() => {
              changeDraft(createTicketDraft(ticket));
              setLabels(ticket.labels.join(", "));
              setScopesText(ticket.scopes.join(", "));
            }}
          >
            Discard draft and reload
          </Button>
        </div>
      )}
      <ErrorNotice error={validationError ?? create.error ?? update.error ?? storageError} />
      <Textarea
        label="Title"
        rows={2}
        value={fields.title}
        onChange={(event) => set("title", event.target.value)}
        required
        maxLength={500}
        autoFocus
      />
      <div className="form-grid">
        <Select
          label="Status"
          value={fields.status}
          onValueChange={(value) => set("status", z.enum(states).parse(value ?? ""))}
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
          onValueChange={(value) => set("priority", z.enum(priorities).parse(value ?? ""))}
        >
          {priorities.map((priority) => (
            <SelectItem key={priority} value={priority}>
              {priorityLabels[priority]}
            </SelectItem>
          ))}
        </Select>
        <Select
          label="Kind"
          value={fields.kind}
          onValueChange={(value) => set("kind", z.enum(kinds).parse(value ?? ""))}
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
            set("difficulty", (value ?? "") ? z.enum(difficulties).parse(value ?? "") : null)
          }
        >
          <SelectItem value="">Unspecified</SelectItem>
          {difficulties.map((difficulty) => (
            <SelectItem key={difficulty} value={difficulty}>
              {difficulty}
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
        <Input
          label="Parent ticket ID"
          value={fields.parentId ?? ""}
          onChange={(event) => set("parentId", event.target.value || null)}
          placeholder="UUID"
        />
        <Input
          label="Labels (comma separated)"
          value={labels}
          onChange={(event) => {
            setLabels(event.target.value);
            set("labels", splitTags(event.target.value));
          }}
        />
        <Input
          label="Scopes (comma separated)"
          value={scopesText}
          onChange={(event) => {
            setScopesText(event.target.value);
            set("scopes", splitTags(event.target.value));
          }}
        />
      </div>
      <Tabs
        value={preview ? "preview" : "write"}
        onValueChange={(value) => setPreview(value === "preview")}
        className="mb-5"
      >
        <TabsList>
          <TabsTrigger value="write">Write</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>
        <TabsContent value="preview" className="py-3">
          <h3>Description</h3>
          <Markdown>{fields.description || "_No description_"}</Markdown>
          <h3>Acceptance criteria</h3>
          <Markdown>{fields.acceptanceCriteria || "_No acceptance criteria_"}</Markdown>
        </TabsContent>
        <TabsContent value="write" className="pt-3">
          <Textarea
            label="Description (Markdown)"
            rows={7}
            maxLength={100000}
            value={fields.description}
            onChange={(event) => set("description", event.target.value)}
          />
          <Textarea
            label="Acceptance criteria (Markdown)"
            rows={5}
            maxLength={50000}
            value={fields.acceptanceCriteria}
            onChange={(event) => set("acceptanceCriteria", event.target.value)}
          />
        </TabsContent>
      </Tabs>
      <Check
        label="Ready for agents when requirements and dependencies permit"
        checked={fields.automationReady}
        onCheckedChange={(checked) => set("automationReady", checked)}
      />
      <Input
        label="Hold reason"
        value={fields.holdReason ?? ""}
        maxLength={2000}
        onChange={(event) => set("holdReason", event.target.value || null)}
      />
      <div className="actions">
        <small className="muted">Draft saved on this device</small>
        <Button
          type="submit"
          variant="default"
          disabled={create.isPending || update.isPending || !!stale}
        >
          Save ticket
        </Button>
      </div>
    </form>
  );
}
