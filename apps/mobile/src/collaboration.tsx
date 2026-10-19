import {
  formatTimestamp,
  relationReference,
  relationChoices,
  parseRelationChoice,
} from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery } from "@tanstack/react-query";
import { memberName, type Ticket, type Output } from "@kanvil/contracts";
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
    <Section title={t("native.relations.title")}>
      {ticket.parentId && (
        <Button
          title={
            parent.data
              ? t("native.relations.parent", {
                  key: parent.data.ticket.key,
                  title: parent.data.ticket.title,
                })
              : t("native.relations.openParent")
          }
          onPress={() =>
            navigation.push("Ticket", { projectId: ticket.projectId, ticketId: ticket.parentId! })
          }
        />
      )}
      {children.data && (children.data.total > 0 || offset > 0) && (
        <>
          <Body>{t("native.relations.children")}</Body>
          {children.data.items.map((child) => (
            <Row
              key={child.id}
              title={`${child.key} · ${child.title}`}
              trailing={<Status ticket={child} />}
              onPress={() =>
                navigation.push("Ticket", { projectId: ticket.projectId, ticketId: child.id })
              }
            />
          ))}
          {(children.data.total > 20 || offset > 0) && (
            <View style={styles.actions}>
              <Button
                title={t("native.relations.previousChildren")}
                disabled={!offset}
                onPress={() => setOffset(Math.max(0, offset - 20))}
              />
              <Button
                title={t("native.relations.nextChildren")}
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
              title={t("native.relations.remove")}
              onPress={() =>
                Alert.alert(t("native.relations.removeTitle"), "", [
                  { text: t("common.action.cancel"), style: "cancel" },
                  {
                    text: t("common.action.remove"),
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
      <Button title={t("native.relations.add")} onPress={() => setOpen(true)} />
      <ErrorNotice error={relations.error ?? remove.error ?? parent.error ?? children.error} />
      <Sheet title={t("native.relations.add")} open={open} onClose={() => setOpen(false)}>
        <Field label={t("native.relations.find")} value={query} onChangeText={setQuery} />
        <Choice
          label={t("native.relations.type")}
          value={type}
          onChange={setType}
          options={relationChoices}
        />
        <Choice
          label={t("native.relations.ticket")}
          value={target}
          onChange={setTarget}
          options={[
            { value: "", label: t("native.relations.choose") },
            ...(matches.data?.items
              .filter((item) => item.id !== ticket.id)
              .map((item) => ({ value: item.id, label: `${item.key} · ${item.title}` })) ?? []),
          ]}
        />
        <ErrorNotice error={matches.error ?? add.error} />
        <Button
          title={t("common.action.add")}
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
    <Section title={t("native.discussion.title")}>
      {comments.data?.items.map((comment) => (
        <Comment key={comment.id} comment={comment} />
      ))}
      <View style={styles.actions}>
        <Button
          title={t("native.discussion.previous")}
          disabled={!offset}
          onPress={() => setOffset(Math.max(0, offset - 50))}
        />
        <Button
          title={t("native.discussion.next")}
          disabled={offset + 50 >= (comments.data?.total ?? 0)}
          onPress={() => setOffset(offset + 50)}
        />
      </View>
      <Field
        label={t("native.discussion.field")}
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
        title={t("native.discussion.submit")}
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
    deleted = useQuery({
      ...api.query("list_deleted_accounts", {}),
      enabled: !!members.data && !members.data.some((member) => member.userId === comment.actorId),
    }),
    update = useOperation("update_comment"),
    remove = useOperation("delete_comment");
  return (
    <View style={{ gap: 10, paddingVertical: 12 }}>
      <Body muted>
        {comment.actorId === identity.id
          ? t("native.discussion.you")
          : memberName(members.data, deleted.data, comment.actorId)}{" "}
        · {formatTimestamp(comment.createdAt)}
      </Body>
      <Markdown>{comment.body}</Markdown>
      {(comment.actorId === identity.id || identity.admin) && (
        <View style={styles.actions}>
          <Button
            title={t("native.discussion.edit")}
            onPress={() => {
              setBody(comment.body);
              setEditingVersion(comment.version);
              setOpen(true);
            }}
          />
          <Button
            title={t("native.discussion.delete")}
            danger
            onPress={() =>
              Alert.alert(
                t("native.discussion.deleteTitle"),
                t("native.discussion.deleteMessage"),
                [
                  { text: t("common.action.cancel"), style: "cancel" },
                  {
                    text: t("common.action.delete"),
                    style: "destructive",
                    onPress: () =>
                      remove.mutate({
                        projectId: comment.projectId,
                        commentId: comment.id,
                        expectedVersion: comment.version,
                      }),
                  },
                ],
              )
            }
          />
        </View>
      )}
      <ErrorNotice error={remove.error} />
      <Sheet title={t("native.discussion.edit")} open={open} onClose={() => setOpen(false)}>
        <Field
          label={t("native.discussion.editField")}
          multiline
          value={body}
          maxLength={50000}
          onChangeText={setBody}
        />
        <ErrorNotice error={update.error} />
        <Button
          title={t("native.discussion.save")}
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
