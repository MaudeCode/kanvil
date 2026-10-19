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
  Link2,
  Pencil,
} from "lucide-react";
import { formText } from "./forms.ts";
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  formatEvent,
  attachmentLimit,
  attachmentPath,
  evidenceFields,
  remoteKindLabel,
  resourceHost,
  type Output,
  type Ticket,
  evidenceKindLabels,
  evidenceOutcomeLabels,
} from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
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
  IconButton,
  fileSize,
} from "./ui.tsx";
import { cn } from "@/lib/utils";
import type { InlineUpload } from "./components/markdown-field.tsx";

// One row for every ticket resource, so files, evidence, and links share layout and link styling.
// Downloads stay in the tab; everything else opens externally.
function ResourceRow({
  icon,
  href,
  label,
  download = false,
  compact = false,
  badges,
  details,
  meta,
  metaId,
  actions,
}: {
  icon: ReactNode;
  href: string;
  label: string;
  download?: boolean;
  compact?: boolean;
  badges?: ReactNode;
  details?: ReactNode;
  meta?: ReactNode;
  metaId?: string;
  actions?: ReactNode;
}) {
  return (
    <Item
      role="listitem"
      size={compact ? "xs" : "default"}
      className={cn(
        "rounded-none border-x-0 border-t-0 border-b-border px-0 animate-in fade-in-0 duration-200 last:border-b-0",
        !compact && "items-start py-4",
      )}
    >
      <ItemMedia variant={compact ? "default" : "icon"}>{icon}</ItemMedia>
      <ItemContent className={cn("min-w-0", compact ? "gap-0" : "gap-1.5")}>
        <ItemTitle
          className={cn(
            "line-clamp-none max-w-full wrap-anywhere",
            compact && "text-xs font-normal",
          )}
        >
          <a
            href={href}
            aria-describedby={metaId}
            {...(download
              ? { download: true, className: "hover:text-primary" }
              : {
                  target: "_blank",
                  rel: "noreferrer",
                  className: "inline-flex items-center gap-1 text-primary hover:underline",
                })}
          >
            {label}
            {!download && <ExternalLink className="size-3 shrink-0" aria-hidden="true" />}
          </a>
          {badges}
        </ItemTitle>
        {details}
        {meta && (
          <ItemDescription id={metaId} className={cn("m-0", compact ? "text-[11px]" : "text-xs")}>
            {meta}
          </ItemDescription>
        )}
      </ItemContent>
      {actions && <ItemActions>{actions}</ItemActions>}
    </Item>
  );
}
function checkFileSize(file: File) {
  if (file.size > attachmentLimit) throw new Error(t("detail.attachment.tooLarge"));
}
const fileFields = async (file: File) => ({
  name: file.name,
  contentType: file.type || "application/octet-stream",
  data: await blobToBase64(file),
});
// Uploads a file a Markdown field embeds. On an existing ticket it becomes an attachment at once;
// before the ticket exists it is staged, `onStaged` records it, and creating the ticket claims it.
export function useInlineUpload(
  projectId: string,
  target: { ticketId: string } | { onStaged: (uploadId: string) => void },
): InlineUpload {
  const upload = useOperation("upload_attachment"),
    stage = useOperation("stage_upload");
  return async (file) => {
    checkFileSize(file);
    const fields = await fileFields(file);
    const row =
      "ticketId" in target
        ? await upload.mutateAsync({ projectId, ticketId: target.ticketId, ...fields })
        : await stage.mutateAsync({ projectId, ...fields });
    if ("onStaged" in target) target.onStaged(row.id);
    return { url: attachmentPath(projectId, row.id), name: row.name, contentType: row.contentType };
  };
}
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
      files.forEach(checkFileSize);
      for (const item of files)
        await upload.mutateAsync({
          projectId: ticket.projectId,
          ticketId: ticket.id,
          ...(await fileFields(item)),
        });
      toast.success(t("detail.attachment.attached", { count: files.length }));
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
        title={t("detail.attachment.heading")}
        action={
          access.canWrite && (
            <IconButton
              label={uploading ? t("detail.resource.uploading") : t("detail.attachment.attach")}
              size="icon-sm"
              disabled={uploading}
              onClick={() => file.current?.click()}
            >
              {uploading ? <Spinner /> : <Upload />}
            </IconButton>
          )
        }
      />
      {!items.isPending && !items.data?.length && (
        <p className="mb-0 text-xs text-muted-foreground">
          {access.canWrite ? t("detail.attachment.emptyWritable") : t("detail.attachment.empty")}
        </p>
      )}
      <ItemGroup className="gap-0">
        {items.data?.map((item) => (
          <ResourceRow
            compact
            download
            key={item.id}
            icon={<FileText className="size-4 text-muted-foreground" />}
            href={attachmentPath(ticket.projectId, item.id)}
            label={item.name}
            meta={fileSize(item.size)}
            metaId={`attachment-size-${item.id}`}
            actions={
              access.canWrite && (
                <Confirm
                  label={t("detail.attachment.remove")}
                  icon={<Trash2 />}
                  description={t("detail.resource.removeConfirm", { name: item.name })}
                  onConfirm={() =>
                    remove.mutateAsync({ projectId: ticket.projectId, attachmentId: item.id })
                  }
                />
              )
            }
          />
        ))}
      </ItemGroup>
      <FileInput
        ref={file}
        type="file"
        multiple
        className="hidden"
        aria-label={t("detail.attachment.fileInput")}
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
        title={t("detail.section.evidence")}
        description={t("detail.evidence.description")}
        action={
          access.canWrite && (
            <IconButton
              label={t("detail.evidence.add")}
              onClick={() => {
                add.reset();
                setValidationError(undefined);
                setOpen(true);
              }}
            >
              <Plus />
            </IconButton>
          )
        }
      />
      {!items.isPending && !items.data?.length && (
        <p className="text-sm text-muted-foreground">{t("detail.evidence.empty")}</p>
      )}
      <ItemGroup className="gap-0">
        {items.data?.map((item) => {
          const Icon = outcomeIcons[item.outcome] ?? CircleDashed;
          return (
            <ResourceRow
              key={item.id}
              icon={
                <Icon
                  className={cn(
                    item.outcome === "passed" && "text-[var(--success)]",
                    item.outcome === "failed" && "text-destructive",
                  )}
                />
              }
              href={item.url}
              label={item.title}
              badges={
                <>
                  <Badge variant="outline" className="ml-2">
                    {evidenceKindLabels[item.kind]}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      "ml-1",
                      item.outcome === "passed" && "text-[var(--success)]",
                      item.outcome === "failed" && "text-destructive",
                    )}
                    data-outcome={item.outcome}
                  >
                    {evidenceOutcomeLabels[item.outcome]}
                  </Badge>
                </>
              }
              details={
                <>
                  {item.commit && (
                    <code className="w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] break-all">
                      {item.commit}
                    </code>
                  )}
                  {item.note && <Markdown>{item.note}</Markdown>}
                </>
              }
              meta={
                <>
                  <ActorName projectId={ticket.projectId} actorId={item.actorId} /> ·{" "}
                  <RelativeTime value={item.createdAt} />
                </>
              }
            />
          );
        })}
      </ItemGroup>
      <Modal
        title={t("detail.evidence.add")}
        open={open}
        onOpenChange={setOpen}
        busy={add.isPending}
      >
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
                toast.success(t("detail.evidence.added"));
              })
              .catch(setValidationError);
          }}
        >
          <Input label={t("detail.field.title")} name="title" required maxLength={200} />
          <Input label={t("detail.field.url")} name="url" type="url" required />
          <div className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
            <Select label={t("detail.evidence.kindLabel")} name="kind">
              {evidenceFields.shape.kind.options.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {evidenceKindLabels[kind]}
                </SelectItem>
              ))}
            </Select>
            <Select label={t("detail.evidence.outcomeLabel")} name="outcome">
              {evidenceFields.shape.outcome.unwrap().options.map((outcome) => (
                <SelectItem key={outcome} value={outcome}>
                  {evidenceOutcomeLabels[outcome]}
                </SelectItem>
              ))}
            </Select>
          </div>
          <Input label={t("detail.evidence.commit")} name="commit" pattern="[a-fA-F0-9]{40,64}" />
          <Textarea label={t("detail.evidence.note")} name="note" maxLength={20000} />
          <FormActions
            error={validationError ?? add.error}
            pending={add.isPending}
            submitLabel={t("detail.evidence.add")}
            onCancel={() => setOpen(false)}
          />
        </form>
      </Modal>
      <ErrorNotice error={items.error} />
    </section>
  );
}
type Resource = Output<"list_resources">[number];
// What a connection verified, such as "Pull request · Merged"; unknown without one.
const remoteStates = ["open", "closed", "merged", "draft", "active", "deleted"] as const;
function remoteLabel({ remoteKind, remoteState, provider }: Resource) {
  if (!remoteState) return t("detail.link.stateUnknown");
  // A state this release has no wording for shows as the host reported it.
  const known = remoteStates.find((value) => value === remoteState),
    state = known
      ? t(`detail.link.remoteState.${known}`)
      : remoteState.charAt(0).toUpperCase() + remoteState.slice(1);
  return remoteKind
    ? t("detail.link.remote", { kind: remoteKindLabel(remoteKind, provider), state })
    : state;
}
export function Links({ ticket }: { ticket: Ticket }) {
  const access = useProjectAccess(ticket.projectId),
    items = useQuery(
      api.query("list_resources", { projectId: ticket.projectId, ticketId: ticket.id }),
    ),
    add = useOperation("add_resource"),
    update = useOperation("update_resource"),
    remove = useOperation("delete_resource");
  // The target outlives `open` so the dialog keeps its title and values while it closes.
  const [editing, setEditing] = useState<Resource>(),
    [open, setOpen] = useState(false),
    [error, setError] = useState<unknown>(),
    pending = add.isPending || update.isPending;
  const edit = (target?: Resource) => {
    setError(undefined);
    setEditing(target);
    setOpen(true);
  };
  return (
    <section aria-label={t("detail.link.heading")}>
      <SectionHeading
        compact
        title={t("detail.link.heading")}
        action={
          access.canWrite && (
            <IconButton label={t("detail.link.add")} size="icon-sm" onClick={() => edit()}>
              <Plus />
            </IconButton>
          )
        }
      />
      {!items.isPending && !items.data?.length && (
        <p className="mb-0 text-xs text-muted-foreground">{t("detail.link.empty")}</p>
      )}
      <ItemGroup className="gap-0">
        {items.data?.map((item) => (
          <ResourceRow
            compact
            key={item.id}
            icon={<Link2 className="size-4 text-muted-foreground" />}
            href={item.url}
            label={item.title || item.url}
            meta={
              item.provider ? (
                <span className="inline-flex flex-wrap gap-1">
                  <Badge variant="outline">{item.provider}</Badge>
                  <Badge
                    variant="outline"
                    className={item.remoteState ? undefined : "text-muted-foreground"}
                  >
                    {remoteLabel(item)}
                  </Badge>
                </span>
              ) : (
                item.title && resourceHost(item.url)
              )
            }
            actions={
              access.canWrite && (
                <>
                  <IconButton
                    size="icon-sm"
                    label={t("detail.link.edit")}
                    onClick={() => edit(item)}
                  >
                    <Pencil />
                  </IconButton>
                  <Confirm
                    label={t("detail.link.remove")}
                    icon={<Trash2 />}
                    description={t("detail.resource.removeConfirm", {
                      name: item.title || item.url,
                    })}
                    onConfirm={() =>
                      remove.mutateAsync({
                        projectId: ticket.projectId,
                        resourceId: item.id,
                        expectedVersion: item.version,
                      })
                    }
                  />
                </>
              )
            }
          />
        ))}
      </ItemGroup>
      <Modal
        title={editing ? t("detail.link.edit") : t("detail.link.add")}
        open={open}
        onOpenChange={setOpen}
        busy={pending}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget),
              fields = { url: formText(form, "url"), title: formText(form, "title") };
            setError(undefined);
            void (
              editing
                ? update.mutateAsync({
                    projectId: ticket.projectId,
                    resourceId: editing.id,
                    expectedVersion: editing.version,
                    ...fields,
                  })
                : add.mutateAsync({ projectId: ticket.projectId, ticketId: ticket.id, ...fields })
            )
              .then(() => setOpen(false))
              .catch(setError);
          }}
        >
          <Input
            label={t("detail.field.url")}
            name="url"
            type="url"
            required
            autoFocus
            defaultValue={editing?.url}
          />
          <Input
            label={t("detail.field.title")}
            name="title"
            maxLength={200}
            defaultValue={editing?.title}
          />
          <FormActions
            error={error}
            pending={pending}
            submitLabel={editing ? t("detail.link.save") : t("detail.link.add")}
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
      <h2>{t("detail.section.activity")}</h2>
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
            {t("detail.activity.previous")}
          </Button>
          <Button
            size="sm"
            disabled={offset + 50 >= (activity.data?.total ?? 0)}
            onClick={() => setOffset(offset + 50)}
          >
            {t("detail.activity.next")}
          </Button>
        </ButtonGroup>
      )}
    </section>
  );
}
