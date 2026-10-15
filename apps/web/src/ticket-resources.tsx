import { Input as FileInput } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { blobToBase64 } from "./lib/browser.ts";
import { Trash2, Upload, FileText, Plus } from "lucide-react";
import { formText } from "./forms.ts";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatEvent, attachmentLimit, evidenceFields, type Ticket } from "@kanvil/contracts";
import { api, date, ActorName, useOperation, useProjectAccess } from "./data.tsx";
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
  SectionHeading,
} from "./ui.tsx";

export function Attachments({ ticket }: { ticket: Ticket }) {
  const items = useQuery(
      api.query("list_attachments", { projectId: ticket.projectId, ticketId: ticket.id }),
    ),
    upload = useOperation("upload_attachment"),
    remove = useOperation("delete_attachment"),
    access = useProjectAccess(ticket.projectId),
    file = useRef<HTMLInputElement>(null),
    [error, setError] = useState<unknown>(),
    [uploading, setUploading] = useState(false);
  async function send(files: File[]) {
    if (!files.length) return;
    setError(undefined);
    setUploading(true);
    try {
      if (files.some((item) => item.size > attachmentLimit))
        throw new Error("Choose files no larger than 10 MB each.");
      for (const item of files)
        await upload.mutateAsync({
          projectId: ticket.projectId,
          ticketId: ticket.id,
          name: item.name,
          contentType: item.type || "application/octet-stream",
          data: await blobToBase64(item),
        });
    } catch (cause) {
      setError(cause);
    } finally {
      setUploading(false);
    }
  }
  return (
    <section>
      <SectionHeading
        title="Attachments"
        action={
          access.canWrite && (
            <Button
              variant="ghost"
              size="sm"
              disabled={uploading}
              onClick={() => file.current?.click()}
            >
              <Upload />
              {uploading ? "Uploading…" : "Attach file"}
            </Button>
          )
        }
      />
      {!items.isPending && !items.data?.length && (
        <p className="mb-0 text-xs text-muted-foreground">No attachments</p>
      )}
      {items.data?.map((item) => (
        <div className="attachment-row" key={item.id}>
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <a
            className="min-w-0 flex-1 break-words"
            href={`/api/v1/projects/${ticket.projectId}/attachments/${item.id}/content`}
            aria-label={item.name}
            aria-describedby={`attachment-size-${item.id}`}
            download
          >
            <span className="block">{item.name}</span>
            <small id={`attachment-size-${item.id}`}>
              {new Intl.NumberFormat(undefined, {
                style: "unit",
                unit: "kilobyte",
                maximumFractionDigits: 1,
              }).format(item.size / 1000)}
            </small>
          </a>
          {access.canWrite && (
            <Confirm
              label="Remove attachment"
              icon={<Trash2 />}
              description={`Remove ${item.name}?`}
              onConfirm={() =>
                remove.mutateAsync({ projectId: ticket.projectId, attachmentId: item.id })
              }
            />
          )}
        </div>
      ))}
      <FileInput
        ref={file}
        type="file"
        multiple
        className="hidden"
        aria-label="File (up to 10 MB)"
        disabled={uploading}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void send(files);
        }}
      />
      <ErrorNotice error={error ?? items.error ?? remove.error} />
    </section>
  );
}
export function Evidence({ ticket }: { ticket: Ticket }) {
  const access = useProjectAccess(ticket.projectId);
  const items = useQuery(
      api.query("list_evidence", { projectId: ticket.projectId, ticketId: ticket.id }),
    ),
    add = useOperation("add_evidence");
  const [open, setOpen] = useState(false),
    [validationError, setValidationError] = useState<unknown>();
  return (
    <section>
      <SectionHeading
        title="Evidence"
        description="Links and outcomes reported by the people and integrations working on this ticket."
        action={
          access.canWrite && (
            <Button
              onClick={() => {
                add.reset();
                setValidationError(undefined);
                setOpen(true);
              }}
            >
              <Plus />
              Add evidence
            </Button>
          )
        }
      />
      {!items.isPending && !items.data?.length && (
        <p className="text-sm text-muted-foreground">No evidence attached</p>
      )}
      {items.data?.map((item) => (
        <article className="comment" key={item.id}>
          <div className="resource-row">
            <a href={item.url} target="_blank" rel="noreferrer">
              {item.title}
            </a>
            <Badge variant="outline" className="evidence-outcome" data-outcome={item.outcome}>
              {item.outcome}
            </Badge>
          </div>
          {item.commit && <code>{item.commit}</code>}
          <Markdown>{item.note}</Markdown>
          <small className="muted">
            <ActorName projectId={ticket.projectId} actorId={item.actorId} /> ·{" "}
            {date(item.createdAt)}
          </small>
        </article>
      ))}
      <Modal title="Add evidence" open={open} onOpenChange={setOpen} busy={add.isPending}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void add
              .mutateAsync({
                projectId: ticket.projectId,
                ticketId: ticket.id,
                kind: evidenceFields.shape.kind.parse(form.get("kind")),
                title: formText(form, "title"),
                url: formText(form, "url"),
                commit: formText(form, "commit") || null,
                outcome: evidenceFields.shape.outcome.parse(form.get("outcome")),
                note: formText(form, "note"),
              })
              .then(() => {
                setOpen(false);
                toast.success("Evidence added");
              })
              .catch(setValidationError);
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
          <ErrorNotice error={validationError ?? add.error} />
          <Button type="submit" disabled={add.isPending}>
            Add evidence
          </Button>
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
      {((activity.data?.total ?? 0) > 50 || offset > 0) && (
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
      )}
    </section>
  );
}
