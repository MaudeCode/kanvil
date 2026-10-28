import { Pencil, Trash2, Send } from "lucide-react";
import { MarkdownField } from "./components/markdown-field.tsx";
import { useInlineUpload } from "./ticket-resources.tsx";
import { submitOnModEnter } from "./forms.ts";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Output, Ticket } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { api, ActorName, useIdentity, useOperation, useProjectAccess } from "./data.tsx";
import {
  Button,
  IconButton,
  Confirm,
  ErrorNotice,
  Markdown,
  RelativeTime,
  EmptyState,
} from "./ui.tsx";
import { Spinner } from "@/components/ui/spinner";
import { Kbd } from "@/components/ui/kbd";
import { ButtonGroup } from "@/components/ui/button-group";
import { MessageSquare } from "lucide-react";

// `anchor` is the URL hash, which names a comment when a search result links one.
export function Discussion({ ticket, anchor: hash }: { ticket: Ticket; anchor: string }) {
  const [offset, setOffset] = useState(0),
    [body, setBody] = useState("");
  const comments = useQuery(
    api.query("list_comments", { projectId: ticket.projectId, ticketId: ticket.id, offset }),
  );
  // A search result links a comment by anchor. Page forward until it loads, once per anchor;
  // paging after that stays with the reader.
  const anchored = hash.startsWith("comment-") ? hash.slice("comment-".length) : null;
  const [anchor, setAnchor] = useState(anchored),
    [seeking, setSeeking] = useState(anchored !== null);
  if (anchored !== anchor) {
    setAnchor(anchored);
    setSeeking(anchored !== null);
  }
  if (seeking && comments.data) {
    if (comments.data.items.some((item) => item.id === anchored)) setSeeking(false);
    else if (offset + 50 < comments.data.total) setOffset(offset + 50);
    else setSeeking(false);
  }
  const inlineUpload = useInlineUpload(ticket.projectId, { ticketId: ticket.id });
  const add = useOperation("add_comment"),
    access = useProjectAccess(ticket.projectId);
  return (
    <section>
      <ErrorNotice error={comments.error ?? add.error} />
      {comments.data?.total === 0 && (
        <EmptyState title={t("detail.discussion.empty")} icon={MessageSquare} className="py-8" />
      )}
      <div className="divide-y">
        {comments.data?.items.map((comment) => (
          <Comment key={comment.id} comment={comment} linked={comment.id === anchored} />
        ))}
      </div>
      {((comments.data?.total ?? 0) > 50 || offset > 0) && (
        <ButtonGroup className="mt-5 justify-end">
          <Button size="sm" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>
            {t("detail.discussion.previous")}
          </Button>
          <Button
            size="sm"
            disabled={offset + 50 >= (comments.data?.total ?? 0)}
            onClick={() => setOffset(offset + 50)}
          >
            {t("detail.discussion.next")}
          </Button>
        </ButtonGroup>
      )}
      {access.canWrite && (
        <form
          onKeyDown={submitOnModEnter}
          className="mt-6"
          onSubmit={(event) => {
            event.preventDefault();
            void add
              .mutateAsync({ projectId: ticket.projectId, ticketId: ticket.id, body })
              .then(() => setBody((current) => (current === body ? "" : current)))
              .catch(() => {});
          }}
        >
          <MarkdownField
            label={t("detail.discussion.comment")}
            value={body}
            onChange={setBody}
            rows={3}
            required
            maxLength={50000}
            mentions={ticket.projectId}
            onUpload={inlineUpload}
            placeholder={t("detail.discussion.placeholder")}
            footer={
              <Button type="submit" variant="default" disabled={add.isPending || !body.trim()}>
                {add.isPending ? <Spinner /> : <Send />}
                {add.isPending ? t("detail.discussion.posting") : t("detail.discussion.comment")}
                <Kbd
                  aria-hidden="true"
                  className="ml-1 hidden border-transparent bg-primary-foreground/20 text-primary-foreground shadow-none sm:inline-flex"
                >
                  ⌘↵
                </Kbd>
              </Button>
            }
          />
        </form>
      )}
    </section>
  );
}
function Comment({
  comment,
  linked,
}: {
  comment: Output<"list_comments">["items"][number];
  linked: boolean;
}) {
  const identity = useIdentity(),
    access = useProjectAccess(comment.projectId),
    update = useOperation("update_comment"),
    inlineUpload = useInlineUpload(comment.projectId, { ticketId: comment.ticketId }),
    remove = useOperation("delete_comment");
  const [editing, setEditing] = useState(false),
    [body, setBody] = useState(comment.body),
    [editingVersion, setEditingVersion] = useState(comment.version);
  const own = comment.actorId === identity.id;
  // Bring the linked comment into view and mark it.
  const article = useRef<HTMLElement>(null);
  useEffect(() => {
    if (linked) article.current?.scrollIntoView({ block: "center" });
  }, [linked]);
  return (
    <article
      ref={article}
      id={`comment-${comment.id}`}
      data-linked={linked}
      className="group/comment relative scroll-mt-16 py-4 animate-in fade-in-0 duration-200 data-[linked=true]:animate-row-in data-[linked=true]:shadow-[inset_2px_0_0_var(--primary)] data-[linked=true]:pl-3"
    >
      <div className="mb-3 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 pr-20 text-xs text-muted-foreground">
        <strong className="text-foreground">
          <ActorName projectId={comment.projectId} actorId={comment.actorId} avatar />
        </strong>
        <RelativeTime value={comment.createdAt} />
        {comment.updatedAt !== comment.createdAt && <span>{t("detail.discussion.edited")}</span>}
      </div>
      {editing ? (
        <form
          onKeyDown={submitOnModEnter}
          onSubmit={(event) => {
            event.preventDefault();
            void update
              .mutateAsync({
                projectId: comment.projectId,
                commentId: comment.id,
                expectedVersion: editingVersion,
                body,
              })
              .then(() => setEditing(false))
              .catch(() => {});
          }}
        >
          <MarkdownField
            label={t("detail.discussion.edit")}
            value={body}
            onChange={setBody}
            rows={4}
            required
            maxLength={50000}
            mentions={comment.projectId}
            onUpload={inlineUpload}
            footer={
              <>
                <Button size="sm" disabled={update.isPending} onClick={() => setEditing(false)}>
                  {t("common.action.cancel")}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  variant="default"
                  disabled={update.isPending || !body.trim()}
                >
                  {update.isPending ? <Spinner /> : null}
                  {t("common.action.save")}
                </Button>
              </>
            }
          />
        </form>
      ) : (
        <Markdown>{comment.body}</Markdown>
      )}
      {!editing && access.canWrite && (own || identity.admin) && (
        <div className="absolute top-3 right-0 flex items-center gap-1 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100 max-md:opacity-100">
          <IconButton
            label={t("detail.discussion.edit")}
            size="icon-sm"
            onClick={() => {
              setBody(comment.body);
              setEditingVersion(comment.version);
              setEditing(true);
            }}
          >
            <Pencil />
          </IconButton>
          <Confirm
            label={t("detail.discussion.delete")}
            icon={<Trash2 />}
            danger
            description={t("detail.discussion.deleteConfirm")}
            onConfirm={() =>
              remove.mutateAsync({
                projectId: comment.projectId,
                commentId: comment.id,
                expectedVersion: comment.version,
              })
            }
          />
        </div>
      )}
      <ErrorNotice error={update.error} />
    </article>
  );
}
