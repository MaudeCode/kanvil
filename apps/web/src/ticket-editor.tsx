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
import { Button, Check, ErrorNotice, Input, Markdown, Select, Textarea } from "./ui.tsx";

const empty: z.output<typeof ticketFields> = {
  title: "",
  description: "",
  acceptanceCriteria: "",
  status: "todo",
  priority: "medium",
  kind: "feature",
  difficulty: null,
  labels: [],
  scopes: [],
  assigneeId: null,
  parentId: null,
  automationReady: false,
  holdReason: null,
  archived: false,
};
const draftSchema = z.object({
  fields: ticketFields.extend({ title: z.string() }),
  version: z.number().int().positive().optional(),
});
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
      const saved = draftSchema.safeParse(JSON.parse(localStorage.getItem(draftKey) ?? "null"));
      if (saved.success) return saved.data;
    } catch {
      /* A damaged draft must not block the editor. */
    }
    return {
      fields: ticket ? ticketFields.strip().parse(ticket) : empty,
      ...(ticket ? { version: ticket.version } : {}),
    };
  });
  const [validationError, setValidationError] = useState<unknown>();
  const [labels, setLabels] = useState(draft.fields.labels.join(", ")),
    [scopesText, setScopesText] = useState(draft.fields.scopes.join(", "));
  const [preview, setPreview] = useState(false),
    [storageError, setStorageError] = useState<unknown>();
  const create = useOperation("create_ticket"),
    update = useOperation("update_ticket");
  const members = useQuery(api.query("list_members", { projectId }));
  const set = <K extends keyof typeof empty>(key: K, value: (typeof empty)[K]) =>
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
      labels: labels
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      scopes: scopesText
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
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
              changeDraft({ fields: ticketFields.strip().parse(ticket), version: ticket.version });
              setLabels(ticket.labels.join(", "));
              setScopesText(ticket.scopes.join(", "));
            }}
          >
            Discard draft and reload
          </Button>
        </div>
      )}
      <ErrorNotice error={validationError ?? create.error ?? update.error ?? storageError} />
      <Input
        label="Title"
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
          onChange={(event) => set("status", z.enum(states).parse(event.target.value))}
        >
          {states.map((state) => (
            <option key={state} value={state}>
              {stateLabels[state]}
            </option>
          ))}
        </Select>
        <Select
          label="Priority"
          value={fields.priority}
          onChange={(event) => set("priority", z.enum(priorities).parse(event.target.value))}
        >
          {priorities.map((priority) => (
            <option key={priority} value={priority}>
              {priorityLabels[priority]}
            </option>
          ))}
        </Select>
        <Select
          label="Kind"
          value={fields.kind}
          onChange={(event) => set("kind", z.enum(kinds).parse(event.target.value))}
        >
          {kinds.map((kind) => (
            <option key={kind}>{kind}</option>
          ))}
        </Select>
        <Select
          label="Difficulty"
          value={fields.difficulty ?? ""}
          onChange={(event) =>
            set(
              "difficulty",
              event.target.value ? z.enum(difficulties).parse(event.target.value) : null,
            )
          }
        >
          <option value="">Unspecified</option>
          {difficulties.map((difficulty) => (
            <option key={difficulty}>{difficulty}</option>
          ))}
        </Select>
        <Select
          label="Assignee"
          value={fields.assigneeId ?? ""}
          onChange={(event) => set("assigneeId", event.target.value || null)}
        >
          <option value="">Unassigned</option>
          {members.data?.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name}
            </option>
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
            set(
              "labels",
              event.target.value
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            );
          }}
        />
        <Input
          label="Scopes (comma separated)"
          value={scopesText}
          onChange={(event) => {
            setScopesText(event.target.value);
            set(
              "scopes",
              event.target.value
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            );
          }}
        />
      </div>
      <div className="actions">
        <Button aria-pressed={preview} onClick={() => setPreview(!preview)}>
          {preview ? "Edit Markdown" : "Preview Markdown"}
        </Button>
      </div>
      {preview ? (
        <>
          <h3>Description</h3>
          <Markdown>{fields.description || "_No description_"}</Markdown>
          <h3>Acceptance criteria</h3>
          <Markdown>{fields.acceptanceCriteria || "_No acceptance criteria_"}</Markdown>
        </>
      ) : (
        <>
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
        </>
      )}
      <Check
        label="Ready for agents when requirements and dependencies permit"
        checked={fields.automationReady}
        onChange={(event) => set("automationReady", event.target.checked)}
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
          className="primary"
          disabled={create.isPending || update.isPending || !!stale}
        >
          Save ticket
        </Button>
      </div>
    </form>
  );
}
