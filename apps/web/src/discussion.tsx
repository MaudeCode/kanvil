import { Pencil, Trash2, Send } from "lucide-react";
import { MarkdownField } from "./components/markdown-field.tsx";
import { submitOnModEnter } from "./forms.ts";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Ticket } from "@kanvil/contracts";
import { api, date, ActorName, useIdentity, useOperation, useProjectAccess } from "./data.tsx";
import { Button, IconButton, Confirm, ErrorNotice, Markdown, Textarea } from "./ui.tsx";

export function Discussion({ ticket }: { ticket: Ticket }) {
  const [offset, setOffset] = useState(0),
    [body, setBody] = useState("");
  const comments = useQuery(
    api.query("list_comments", { projectId: ticket.projectId, ticketId: ticket.id, offset }),
  );
  const add = useOperation("add_comment"),
    access = useProjectAccess(ticket.projectId);
  return (
    <section>
      <ErrorNotice error={comments.error ?? add.error} />
      {comments.data?.items.map((comment) => (
        <Comment key={comment.id} comment={comment} />
      ))}
      {((comments.data?.total ?? 0) > 50 || offset > 0) && (
        <div className="pagination">
          <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>
            Previous comments
          </Button>
          <Button
            disabled={offset + 50 >= (comments.data?.total ?? 0)}
            onClick={() => setOffset(offset + 50)}
          >
            Next comments
          </Button>
        </div>
      )}
      {access.canWrite && (
        <form
          onKeyDown={submitOnModEnter}
          className="comment-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void add
              .mutateAsync({ projectId: ticket.projectId, ticketId: ticket.id, body })
              .then(() => setBody((current) => (current === body ? "" : current)))
              .catch(() => {});
          }}
        >
          <MarkdownField
            label="Comment"
            value={body}
            onChange={setBody}
            rows={3}
            required
            maxLength={50000}
            placeholder="Write a comment…"
            footer={
              <Button type="submit" variant="default" disabled={add.isPending || !body.trim()}>
                <Send />
                {add.isPending ? "Posting…" : "Comment"}
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
}: {
  comment: Awaited<ReturnType<typeof api.call<"list_comments">>>["items"][number];
}) {
  const identity = useIdentity(),
    access = useProjectAccess(comment.projectId),
    update = useOperation("update_comment"),
    remove = useOperation("delete_comment");
  const [editing, setEditing] = useState(false),
    [body, setBody] = useState(comment.body),
    [editingVersion, setEditingVersion] = useState(comment.version);
  return (
    <article className="comment relative">
      <div className="metadata">
        <strong>
          <ActorName projectId={comment.projectId} actorId={comment.actorId} avatar />
        </strong>
        <time dateTime={comment.createdAt}>{date(comment.createdAt)}</time>
        {comment.updatedAt !== comment.createdAt && <span>Edited</span>}
      </div>
      {editing ? (
        <form
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
          <Textarea
            label="Edit comment"
            disabled={update.isPending}
            value={body}
            required
            maxLength={50000}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="actions">
            <Button onClick={() => setEditing(false)}>Cancel</Button>
            <Button type="submit" disabled={update.isPending}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <Markdown>{comment.body}</Markdown>
      )}
      {!editing && access.canWrite && (comment.actorId === identity.id || identity.admin) && (
        <div className="actions">
          <IconButton
            label="Edit comment"
            onClick={() => {
              if (!editing) {
                setBody(comment.body);
                setEditingVersion(comment.version);
              }
              setEditing(!editing);
            }}
          >
            <Pencil />
          </IconButton>
          <Confirm
            label="Delete comment"
            icon={<Trash2 />}
            danger
            description="Permanently delete this comment?"
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
