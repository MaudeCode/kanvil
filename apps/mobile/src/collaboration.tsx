import {
  formatTimestamp,
  relationReference,
  relationChoices,
  parseRelationChoice,
} from "@kanvil/contracts";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery } from "@tanstack/react-query";
import type { Ticket, Output } from "@kanvil/contracts";
import { useConnection, useIdentity, useOperation } from "./data.tsx";
import {
  Body,
  Button,
  Choice,
  ErrorNotice,
  Field,
  Markdown,
  Section,
  Sheet,
  Row,
  Status,
  styles,
} from "./ui.tsx";
import type { ScreenProps } from "./navigation.ts";

export function Relations({
  ticket,
  navigation,
}: {
  ticket: Ticket;
  navigation: ScreenProps<"Ticket">["navigation"];
}) {
  const { api } = useConnection(),
    [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [target, setTarget] = useState(""),
    [type, setType] = useState("blocks:outgoing");
  const [offset, setOffset] = useState(0);
  const parent = useQuery({
    ...api.query("get_ticket", {
      projectId: ticket.projectId,
      ticketId: ticket.parentId ?? ticket.id,
    }),
    enabled: !!ticket.parentId,
  });
  const children = useQuery(
    api.query("list_tickets", {
      projectId: ticket.projectId,
      parentId: ticket.id,
      archived: "include",
      limit: 20,
      offset,
    }),
  );
  const relations = useQuery(
      api.query("list_relations", { projectId: ticket.projectId, ticketId: ticket.id }),
    ),
    matches = useQuery(
      api.query("list_tickets", { projectId: ticket.projectId, q: query, limit: 30 }),
    );
  const add = useOperation("add_relation"),
    remove = useOperation("remove_relation");
  return (
    <Section title="Relationships">
      {ticket.parentId && (
        <Button
          title={
            parent.data
              ? `Parent · ${parent.data.ticket.key} · ${parent.data.ticket.title}`
              : "Open parent ticket"
          }
          onPress={() =>
            navigation.push("Ticket", { projectId: ticket.projectId, ticketId: ticket.parentId! })
          }
        />
      )}
      {children.data && (children.data.total > 0 || offset > 0) && (
        <>
          <Body>Child tickets</Body>
          {children.data.items.map((child) => (
            <Row
              key={child.id}
              title={`${child.key} · ${child.title}`}
              trailing={<Status value={child.status} />}
              onPress={() =>
                navigation.push("Ticket", { projectId: ticket.projectId, ticketId: child.id })
              }
            />
          ))}
          {(children.data.total > 20 || offset > 0) && (
            <View style={styles.actions}>
              <Button
                title="Previous children"
                disabled={!offset}
                onPress={() => setOffset(Math.max(0, offset - 20))}
              />
              <Button
                title="Next children"
                disabled={offset + 20 >= children.data.total}
                onPress={() => setOffset(offset + 20)}
              />
            </View>
          )}
        </>
      )}
      {relations.data?.map((relation) => {
        const reference = relationReference(relation, ticket.id);
        return (
          <View key={relation.id} style={{ gap: 8 }}>
            <Button
              title={`${reference.label} · ${reference.title}`}
              onPress={() =>
                navigation.push("Ticket", { projectId: ticket.projectId, ticketId: reference.id })
              }
            />
            <Button
              title="Remove relationship"
              onPress={() =>
                Alert.alert("Remove relationship?", "", [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Remove",
                    style: "destructive",
                    onPress: () =>
                      remove.mutate({ projectId: ticket.projectId, relationId: relation.id }),
                  },
                ])
              }
            />
          </View>
        );
      })}
      <Button title="Add relationship" onPress={() => setOpen(true)} />
      <ErrorNotice error={relations.error ?? remove.error ?? parent.error ?? children.error} />
      <Sheet title="Add relationship" open={open} onClose={() => setOpen(false)}>
        <Field label="Find ticket" value={query} onChangeText={setQuery} />
        <Choice label="Relationship" value={type} onChange={setType} options={relationChoices} />
        <Choice
          label="Ticket"
          value={target}
          onChange={setTarget}
          options={[
            { value: "", label: "Choose a ticket" },
            ...(matches.data?.items
              .filter((item) => item.id !== ticket.id)
              .map((item) => ({ value: item.id, label: `${item.key} · ${item.title}` })) ?? []),
          ]}
        />
        <ErrorNotice error={matches.error ?? add.error} />
        <Button
          title="Add"
          primary
          disabled={!target || add.isPending}
          onPress={() => {
            void add
              .mutateAsync({
                projectId: ticket.projectId,
                ticketId: ticket.id,
                targetId: target,
                ...parseRelationChoice(type),
              })
              .then(() => setOpen(false))
              .catch(() => {});
          }}
        />
      </Sheet>
    </Section>
  );
}
export function Discussion({ ticket }: { ticket: Ticket }) {
  const { api, prefix } = useConnection(),
    identity = useIdentity(),
    [offset, setOffset] = useState(0),
    [body, setBody] = useState(""),
    [error, setError] = useState<unknown>();
  const key = `${prefix}:${identity.id}:comment:${ticket.id}`;
  const comments = useQuery(
      api.query("list_comments", { projectId: ticket.projectId, ticketId: ticket.id, offset }),
    ),
    add = useOperation("add_comment");
  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(key)
      .then((value) => {
        if (active) setBody(value ?? "");
      })
      .catch(setError);
    return () => {
      active = false;
    };
  }, [key]);
  return (
    <Section title="Discussion">
      {comments.data?.items.map((comment) => (
        <Comment key={comment.id} comment={comment} />
      ))}
      <View style={styles.actions}>
        <Button
          title="Previous comments"
          disabled={!offset}
          onPress={() => setOffset(Math.max(0, offset - 50))}
        />
        <Button
          title="Next comments"
          disabled={offset + 50 >= (comments.data?.total ?? 0)}
          onPress={() => setOffset(offset + 50)}
        />
      </View>
      <Field
        label="Comment (Markdown)"
        value={body}
        onChangeText={(value) => {
          setBody(value);
          void AsyncStorage.setItem(key, value).catch(setError);
        }}
        multiline
        maxLength={50000}
      />
      <ErrorNotice error={error ?? comments.error ?? add.error} />
      <Button
        title="Comment"
        primary
        disabled={!body.trim() || add.isPending}
        onPress={() => {
          void add
            .mutateAsync({ projectId: ticket.projectId, ticketId: ticket.id, body })
            .then(async () => {
              setBody("");
              await AsyncStorage.removeItem(key);
            })
            .catch(setError);
        }}
      />
    </Section>
  );
}
function Comment({ comment }: { comment: Output<"list_comments">["items"][number] }) {
  const identity = useIdentity(),
    { api } = useConnection(),
    [open, setOpen] = useState(false),
    [body, setBody] = useState(comment.body),
    [editingVersion, setEditingVersion] = useState(comment.version);
  const members = useQuery(api.query("list_members", { projectId: comment.projectId })),
    update = useOperation("update_comment"),
    remove = useOperation("delete_comment");
  return (
    <View style={{ gap: 10, paddingVertical: 12 }}>
      <Body muted>
        {comment.actorId === identity.id
          ? "You"
          : (members.data?.find((member) => member.userId === comment.actorId)?.name ??
            "Former member")}{" "}
        · {formatTimestamp(comment.createdAt)}
      </Body>
      <Markdown>{comment.body}</Markdown>
      {(comment.actorId === identity.id || identity.admin) && (
        <View style={styles.actions}>
          <Button
            title="Edit comment"
            onPress={() => {
              setBody(comment.body);
              setEditingVersion(comment.version);
              setOpen(true);
            }}
          />
          <Button
            title="Delete comment"
            danger
            onPress={() =>
              Alert.alert("Delete comment?", "Permanently remove this comment?", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Delete",
                  style: "destructive",
                  onPress: () =>
                    remove.mutate({
                      projectId: comment.projectId,
                      commentId: comment.id,
                      expectedVersion: comment.version,
                    }),
                },
              ])
            }
          />
        </View>
      )}
      <ErrorNotice error={remove.error} />
      <Sheet title="Edit comment" open={open} onClose={() => setOpen(false)}>
        <Field label="Comment" multiline value={body} maxLength={50000} onChangeText={setBody} />
        <ErrorNotice error={update.error} />
        <Button
          title="Save comment"
          disabled={!body.trim() || update.isPending}
          primary
          onPress={() => {
            void update
              .mutateAsync({
                projectId: comment.projectId,
                commentId: comment.id,
                expectedVersion: editingVersion,
                body,
              })
              .then(() => setOpen(false))
              .catch(() => {});
          }}
        />
      </Sheet>
    </View>
  );
}
