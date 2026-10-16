import { Input as FileInput } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { toast } from "sonner";
import { blobToBase64 } from "./lib/browser.ts";
import {
  Trash2,
  Upload,
  FileText,
  Plus,
  ExternalLink,
  CircleCheck,
  CircleX,
  CircleDashed,
  Clock,
} from "lucide-react";
import { formText } from "./forms.ts";
import { useRef, useState, type DragEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatEvent, attachmentLimit, evidenceFields, type Ticket } from "@kanvil/contracts";
import { api, ActorName, useOperation, useProjectAccess } from "./data.tsx";
import {
  Button,
  Confirm,
  ErrorNotice,
  Input,
  Markdown,
  Modal,
  RelativeTime,
  Select,
  SelectItem,
  Textarea,
  SectionHeading,
  FormActions,
} from "./ui.tsx";
import { cn } from "@/lib/utils";

const sizeFormat = new Intl.NumberFormat(undefined, {
  style: "unit",
  unit: "kilobyte",
  maximumFractionDigits: 1,
});
export function Attachments({ ticket }: { ticket: Ticket }) {
  const items = useQuery(
      api.query("list_attachments", { projectId: ticket.projectId, ticketId: ticket.id }),
    ),
    upload = useOperation("upload_attachment"),
    remove = useOperation("delete_attachment"),
    access = useProjectAccess(ticket.projectId),
    file = useRef<HTMLInputElement>(null),
    [error, setError] = useState<unknown>(),
    [dragging, setDragging] = useState(false),
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
      toast.success(files.length === 1 ? "File attached" : `${files.length} files attached`);
    } catch (cause) {
      setError(cause);
    } finally {
      setUploading(false);
    }
  }
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (access.canWrite) void send(Array.from(event.dataTransfer.files));
  };
  return (
    <section
      onDragOver={(event) => {
        if (!access.canWrite) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
      className={cn(
        "rounded-lg transition-colors",
        dragging && "bg-primary/5 ring-2 ring-primary/40 ring-offset-4 ring-offset-background",
      )}
    >
      <SectionHeading
        compact
        title="Attachments"
        action={
          access.canWrite && (
            <Button
              variant="ghost"
              size="sm"
              disabled={uploading}
              onClick={() => file.current?.click()}
            >
              {uploading ? <Spinner /> : <Upload />}
              {uploading ? "Uploading…" : "Attach file"}
            </Button>
          )
        }
      />
      {!items.isPending && !items.data?.length && (
        <p className="mb-0 text-xs text-muted-foreground">
          {access.canWrite ? "No attachments. Drop files here." : "No attachments"}
        </p>
      )}
      <ItemGroup className="gap-0">
        {items.data?.map((item) => (
          <Item
            size="xs"
            key={item.id}
            className="rounded-none border-x-0 border-t-0 border-b-border px-0 animate-in fade-in-0 duration-200"
          >
            <ItemMedia>
              <FileText className="size-4 text-muted-foreground" />
            </ItemMedia>
            <ItemContent className="min-w-0 gap-0">
              <ItemTitle className="line-clamp-none max-w-full text-xs font-normal wrap-anywhere">
                <a
                  className="hover:text-primary"
                  href={`/api/v1/projects/${ticket.projectId}/attachments/${item.id}/content`}
                  aria-label={item.name}
                  aria-describedby={`attachment-size-${item.id}`}
                  download
                >
                  {item.name}
                </a>
              </ItemTitle>
              <ItemDescription id={`attachment-size-${item.id}`} className="m-0 text-[11px]">
                {sizeFormat.format(item.size / 1000)}
              </ItemDescription>
            </ItemContent>
            {access.canWrite && (
              <ItemActions>
                <Confirm
                  label="Remove attachment"
                  icon={<Trash2 />}
                  description={`Remove ${item.name}?`}
                  onConfirm={() =>
                    remove.mutateAsync({ projectId: ticket.projectId, attachmentId: item.id })
                  }
                />
              </ItemActions>
            )}
          </Item>
        ))}
      </ItemGroup>
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
const outcomeIcons: Record<string, typeof CircleCheck> = {
  passed: CircleCheck,
  failed: CircleX,
  pending: Clock,
  reported: CircleDashed,
};
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
      <ItemGroup className="gap-0 divide-y">
        {items.data?.map((item) => {
          const Icon = outcomeIcons[item.outcome] ?? CircleDashed;
          return (
            <Item key={item.id} className="items-start rounded-none px-0 py-4">
              <ItemMedia variant="icon">
                <Icon
                  className={cn(
                    item.outcome === "passed" && "text-[var(--success)]",
                    item.outcome === "failed" && "text-destructive",
                  )}
                />
              </ItemMedia>
              <ItemContent className="min-w-0 gap-1.5">
                <ItemTitle className="line-clamp-none max-w-full wrap-anywhere">
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    {item.title}
                    <ExternalLink className="size-3" aria-hidden="true" />
                  </a>
                  <Badge variant="outline" className="ml-2 capitalize">
                    {item.kind}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      "ml-1 capitalize",
                      item.outcome === "passed" && "text-[var(--success)]",
                      item.outcome === "failed" && "text-destructive",
                    )}
                    data-outcome={item.outcome}
                  >
                    {item.outcome}
                  </Badge>
                </ItemTitle>
                {item.commit && (
                  <code className="w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] break-all">
                    {item.commit}
                  </code>
                )}
                {item.note && <Markdown>{item.note}</Markdown>}
                <ItemDescription className="m-0 text-xs">
                  <ActorName projectId={ticket.projectId} actorId={item.actorId} /> ·{" "}
                  <RelativeTime value={item.createdAt} />
                </ItemDescription>
              </ItemContent>
            </Item>
          );
        })}
      </ItemGroup>
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
          <div className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
            <Select label="Kind" name="kind">
              {evidenceFields.shape.kind.options.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  <span className="capitalize">{kind}</span>
                </SelectItem>
              ))}
            </Select>
            <Select label="Reported outcome" name="outcome">
              {["reported", "pending", "passed", "failed"].map((outcome) => (
                <SelectItem key={outcome} value={outcome}>
                  <span className="capitalize">{outcome}</span>
                </SelectItem>
              ))}
            </Select>
          </div>
          <Input label="Commit (full hash)" name="commit" pattern="[a-fA-F0-9]{40,64}" />
          <Textarea label="Note" name="note" maxLength={20000} />
          <FormActions
            error={validationError ?? add.error}
            pending={add.isPending}
            submitLabel="Add evidence"
            onCancel={() => setOpen(false)}
          />
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
      <ol className="m-0 list-none p-0">
        {activity.data?.items.map((event) => (
          <li
            key={event.id}
            className="relative flex flex-col gap-0.5 border-l py-2.5 pl-5 text-xs before:absolute before:top-4 before:-left-[3px] before:size-[5px] before:rounded-full before:bg-muted-foreground/50"
          >
            <span>{formatEvent(event)}</span>
            <span className="text-muted-foreground">
              <ActorName projectId={ticket.projectId} actorId={event.actorId} /> ·{" "}
              <RelativeTime value={event.createdAt} />
            </span>
          </li>
        ))}
      </ol>
      {((activity.data?.total ?? 0) > 50 || offset > 0) && (
        <ButtonGroup className="mt-5 justify-end">
          <Button size="sm" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>
            Previous activity
          </Button>
          <Button
            size="sm"
            disabled={offset + 50 >= (activity.data?.total ?? 0)}
            onClick={() => setOffset(offset + 50)}
          >
            Next activity
          </Button>
        </ButtonGroup>
      )}
    </section>
  );
}
