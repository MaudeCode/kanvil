import { Trash2, Upload } from "lucide-react";
import { formText } from "./forms.ts";
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatEvent, attachmentLimit, evidenceFields, type Ticket } from "@kanvil/contracts";
import { api, date, ActorName, useOperation } from "./data.tsx";
import {
  Button,
  Confirm,
  ErrorNotice,
  Input,
  Markdown,
  Modal,
  Select,
  SelectItem,
  Textarea,
} from "./ui.tsx";

export function Attachments({ ticket }: { ticket: Ticket }) {
  const items = useQuery(
      api.query("list_attachments", { projectId: ticket.projectId, ticketId: ticket.id }),
    ),
    upload = useOperation("upload_attachment"),
    remove = useOperation("delete_attachment");
  const [error, setError] = useState<unknown>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      file = new FormData(form).get("file");
    if (!(file instanceof File) || !file.size) return;
    if (file.size > attachmentLimit) throw new Error("Choose a file no larger than 10 MB.");
    const encoded = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("error", () => reject(new Error("The file could not be read")), {
        once: true,
      });
      reader.addEventListener(
        "load",
        () =>
          typeof reader.result === "string"
            ? resolve(reader.result.slice(reader.result.indexOf(",") + 1))
            : reject(new Error("The file could not be encoded")),
        { once: true },
      );
      reader.readAsDataURL(file);
    });
    await upload.mutateAsync({
      projectId: ticket.projectId,
      ticketId: ticket.id,
      name: file.name,
      contentType: file.type || "application/octet-stream",
      data: encoded,
    });
    form.reset();
  }
  return (
    <section>
      <h2>Attachments</h2>
      {items.data?.map((item) => (
        <div className="resource-row" key={item.id}>
          <a href={`/api/v1/projects/${ticket.projectId}/attachments/${item.id}/content`} download>
            {item.name}
          </a>
          <span className="muted">
            {new Intl.NumberFormat(undefined, {
              style: "unit",
              unit: "kilobyte",
              maximumFractionDigits: 1,
            }).format(item.size / 1000)}
          </span>
          <Confirm
            label="Remove attachment"
            icon={<Trash2 />}
            description={`Remove ${item.name}?`}
            onConfirm={() =>
              remove.mutateAsync({ projectId: ticket.projectId, attachmentId: item.id })
            }
          />
        </div>
      ))}
      <form
        className="inline-form"
        onSubmit={(event) => {
          setError(undefined);
          void submit(event).catch(setError);
        }}
      >
        <Input label="File (up to 10 MB)" name="file" type="file" required />
        <Button type="submit" disabled={upload.isPending}>
          <Upload />
          Upload
        </Button>
      </form>
      <ErrorNotice error={error ?? items.error ?? remove.error} />
    </section>
  );
}
export function Evidence({ ticket }: { ticket: Ticket }) {
  const items = useQuery(
      api.query("list_evidence", { projectId: ticket.projectId, ticketId: ticket.id }),
    ),
    add = useOperation("add_evidence");
  return (
    <section>
      <h2>Evidence</h2>
      <p className="muted">Outcomes are reported by their submitting accounts.</p>
      {items.data?.map((item) => (
        <article className="comment" key={item.id}>
          <div className="resource-row">
            <a href={item.url} target="_blank" rel="noreferrer">
              {item.title}
            </a>
            <span>
              {item.kind} · {item.outcome}
            </span>
          </div>
          {item.commit && <code>{item.commit}</code>}
          <Markdown>{item.note}</Markdown>
          <small className="muted">
            <ActorName projectId={ticket.projectId} actorId={item.actorId} /> ·{" "}
            {date(item.createdAt)}
          </small>
        </article>
      ))}
      <Modal title="Add evidence" trigger="Add evidence">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            add.mutate({
              projectId: ticket.projectId,
              ticketId: ticket.id,
              kind: evidenceFields.shape.kind.parse(form.get("kind")),
              title: formText(form, "title"),
              url: formText(form, "url"),
              commit: formText(form, "commit") || null,
              outcome: evidenceFields.shape.outcome.parse(form.get("outcome")),
              note: formText(form, "note"),
            });
          }}
        >
          <Input label="Title" name="title" required maxLength={200} />
          <Input label="URL" name="url" type="url" required />
          <Select label="Kind" name="kind">
            {evidenceFields.shape.kind.options.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {kind}
              </SelectItem>
            ))}
          </Select>
          <Select label="Reported outcome" name="outcome">
            {["reported", "pending", "passed", "failed"].map((outcome) => (
              <SelectItem key={outcome} value={outcome}>
                {outcome}
              </SelectItem>
            ))}
          </Select>
          <Input label="Commit (full hash)" name="commit" pattern="[a-fA-F0-9]{40,64}" />
          <Textarea label="Note" name="note" maxLength={20000} />
          <ErrorNotice error={add.error} />
          <Button type="submit" disabled={add.isPending}>
            Add evidence
          </Button>
          {add.isSuccess && <p role="status">Evidence added</p>}
        </form>
      </Modal>
      <ErrorNotice error={items.error} />
    </section>
  );
}
export function Activity({ ticket }: { ticket: Ticket }) {
  const [offset, setOffset] = useState(0);
  const activity = useQuery(
    api.query("list_activity", { projectId: ticket.projectId, ticketId: ticket.id, offset }),
  );
  return (
    <section>
      <h2>Activity</h2>
      <ErrorNotice error={activity.error} />
      <ol className="activity">
        {activity.data?.items.map((event) => (
          <li key={event.id}>
            <span>{formatEvent(event)}</span>
            <span className="muted">
              <ActorName projectId={ticket.projectId} actorId={event.actorId} /> ·{" "}
              {date(event.createdAt)}
            </span>
          </li>
        ))}
      </ol>
      <div className="pagination">
        <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>
          Previous activity
        </Button>
        <Button
          disabled={offset + 50 >= (activity.data?.total ?? 0)}
          onClick={() => setOffset(offset + 50)}
        >
          Next activity
        </Button>
      </div>
    </section>
  );
}
