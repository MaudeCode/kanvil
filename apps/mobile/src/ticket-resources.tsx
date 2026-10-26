import { formatEvent, formatTimestamp } from "@kanvil/contracts";
import { formatNumber, t } from "@kanvil/contracts/i18n";
import { useState } from "react";
import { Alert, Linking, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  attachmentLimit,
  evidenceFields,
  evidenceKindLabels,
  evidenceOutcomeLabels,
  resourceRemoteLabel,
  type Ticket,
  type Output,
} from "@kanvil/contracts";
import { useConnection, useOperation, useProjectAccess } from "./data.tsx";
import {
  Body,
  Button,
  Choice,
  ErrorNotice,
  Field,
  Markdown,
  Section,
  Sheet,
  styles,
  Row,
} from "./ui.tsx";

export function Attachments({ ticket }: { ticket: Ticket }) {
  const access = useProjectAccess(ticket.projectId);
  const connection = useConnection(),
    { api } = connection;
  const attachments = useQuery(
      api.query("list_attachments", { projectId: ticket.projectId, ticketId: ticket.id }),
    ),
    upload = useOperation("upload_attachment"),
    remove = useOperation("delete_attachment");
  const [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false);
  async function choose() {
    setError(undefined);
    setPending(true);
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      const asset = picked.canceled ? undefined : picked.assets[0];
      if (!asset) return;
      const file = new File(asset.uri);
      try {
        if (file.size > attachmentLimit) throw new Error(t("native.attachments.tooLarge"));
        await upload.mutateAsync({
          projectId: ticket.projectId,
          ticketId: ticket.id,
          name: asset.name,
          contentType: asset.mimeType ?? "application/octet-stream",
          data: await file.base64(),
        });
      } finally {
        try {
          file.delete();
        } catch (cause) {
          setError(cause);
        }
      }
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  async function open(item: Output<"list_attachments">[number]) {
    setError(undefined);
    setPending(true);
    const basename = item.name.split(/[\\/]/).at(-1) || "attachment";
    const target = new File(Paths.cache, `${item.id}-${basename}`);
    try {
      await File.downloadFileAsync(
        `${connection.baseUrl}/api/v1/projects/${ticket.projectId}/attachments/${item.id}/content`,
        target,
        { headers: await connection.headers(), idempotent: true },
      );
      if (!(await Sharing.isAvailableAsync()))
        throw new Error(t("native.attachments.sharingUnavailable"));
      await Sharing.shareAsync(target.uri, { mimeType: item.contentType, dialogTitle: item.name });
    } catch (cause) {
      setError(cause);
    } finally {
      try {
        if (target.exists) target.delete();
      } catch (cause) {
        setError(cause);
      }
      setPending(false);
    }
  }
  return (
    <Section title={t("native.attachments.title")}>
      {attachments.data?.map((item) => (
        <View key={item.id} style={{ gap: 8 }}>
          <Button
            title={t("native.attachments.item", {
              name: item.name,
              size: formatNumber(Math.max(1, Math.ceil(item.size / 1000))),
            })}
            disabled={pending}
            onPress={() => {
              void open(item);
            }}
          />
          {access.canWrite && (
            <Button
              title={t("native.attachments.remove", { name: item.name })}
              disabled={remove.isPending}
              onPress={() =>
                Alert.alert(t("native.attachments.removeTitle"), item.name, [
                  { text: t("common.action.cancel"), style: "cancel" },
                  {
                    text: t("common.action.remove"),
                    style: "destructive",
                    onPress: () =>
                      remove.mutate({ projectId: ticket.projectId, attachmentId: item.id }),
                  },
                ])
              }
            />
          )}
        </View>
      ))}
      <ErrorNotice error={error ?? attachments.error ?? remove.error} />
      {access.canWrite && (
        <Button
          title={pending ? t("native.attachments.working") : t("native.attachments.add")}
          disabled={pending}
          onPress={() => {
            void choose();
          }}
        />
      )}
    </Section>
  );
}
export function Evidence({ ticket }: { ticket: Ticket }) {
  const access = useProjectAccess(ticket.projectId);
  const { api } = useConnection(),
    [open, setOpen] = useState(false),
    [title, setTitle] = useState(""),
    [url, setUrl] = useState(""),
    [kind, setKind] = useState("test"),
    [outcome, setOutcome] = useState("reported"),
    [commit, setCommit] = useState(""),
    [note, setNote] = useState(""),
    [error, setError] = useState<unknown>();
  const items = useQuery(
      api.query("list_evidence", { projectId: ticket.projectId, ticketId: ticket.id }),
    ),
    add = useOperation("add_evidence");
  return (
    <Section title={t("native.evidence.title")}>
      <Body muted>{t("native.evidence.explanation")}</Body>
      {items.data?.map((item) => (
        <View key={item.id} style={{ gap: 8, paddingVertical: 10 }}>
          <Button
            title={item.title}
            onPress={() => {
              void Linking.openURL(item.url).catch(setError);
            }}
          />
          <Body muted>
            {evidenceKindLabels[item.kind]} · {evidenceOutcomeLabels[item.outcome]}
            {item.commit ? ` · ${item.commit}` : ""}
          </Body>
          <Markdown>{item.note}</Markdown>
        </View>
      ))}
      {access.canWrite && <Button title={t("native.evidence.add")} onPress={() => setOpen(true)} />}
      <ErrorNotice error={items.error ?? error} />
      <Sheet title={t("native.evidence.add")} open={open} onClose={() => setOpen(false)}>
        <Field
          label={t("native.evidence.name")}
          value={title}
          onChangeText={setTitle}
          maxLength={200}
        />
        <Field
          label={t("native.evidence.url")}
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Choice
          label={t("common.filterField.kind")}
          value={kind}
          onChange={setKind}
          options={evidenceFields.shape.kind.options.map((value) => ({
            value,
            label: evidenceKindLabels[value],
          }))}
        />
        <Choice
          label={t("native.evidence.outcome")}
          value={outcome}
          onChange={setOutcome}
          options={evidenceFields.shape.outcome.unwrap().options.map((value) => ({
            value,
            label: evidenceOutcomeLabels[value],
          }))}
        />
        <Field
          label={t("native.evidence.commit")}
          value={commit}
          onChangeText={setCommit}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Field
          label={t("native.evidence.note")}
          value={note}
          onChangeText={setNote}
          multiline
          maxLength={20000}
        />
        <ErrorNotice error={add.error} />
        <Button
          title={t("native.evidence.save")}
          primary
          disabled={!title.trim() || !url || add.isPending}
          onPress={() => {
            void add
              .mutateAsync({
                projectId: ticket.projectId,
                ticketId: ticket.id,
                title,
                url,
                kind: evidenceFields.shape.kind.parse(kind),
                outcome: z.enum(["reported", "pending", "passed", "failed"]).parse(outcome),
                commit: commit || null,
                note,
              })
              .then(() => setOpen(false))
              .catch(() => {});
          }}
        />
      </Sheet>
    </Section>
  );
}
export function Links({ ticket }: { ticket: Ticket }) {
  const { api } = useConnection(),
    access = useProjectAccess(ticket.projectId);
  const items = useQuery(
    api.query("list_resources", { projectId: ticket.projectId, ticketId: ticket.id }),
  );
  const add = useOperation("add_resource"),
    update = useOperation("update_resource"),
    remove = useOperation("delete_resource");
  const [editing, setEditing] = useState<Output<"list_resources">[number] | null | undefined>(),
    [title, setTitle] = useState(""),
    [url, setUrl] = useState("");
  const pending = add.isPending || update.isPending || remove.isPending;
  return (
    <Section title={t("detail.link.heading")}>
      <ErrorNotice error={items.error ?? remove.error} />
      {items.data?.map((item) => (
        <View key={item.id} style={{ gap: 8 }}>
          <Row
            title={item.title || item.url}
            caption={resourceRemoteLabel(item)}
            onPress={() => {
              void Linking.openURL(item.url);
            }}
          />
          {access.canWrite && (
            <View style={styles.actions}>
              <Button
                compact
                title={t("detail.link.edit")}
                onPress={() => {
                  setEditing(item);
                  setTitle(item.title);
                  setUrl(item.url);
                }}
              />
              <Button
                compact
                title={t("detail.link.remove")}
                danger
                disabled={pending}
                onPress={() =>
                  Alert.alert(t("detail.link.remove"), item.title || item.url, [
                    { text: t("common.action.cancel"), style: "cancel" },
                    {
                      text: t("common.action.remove"),
                      style: "destructive",
                      onPress: () =>
                        remove.mutate({
                          projectId: ticket.projectId,
                          resourceId: item.id,
                          expectedVersion: item.version,
                        }),
                    },
                  ])
                }
              />
            </View>
          )}
        </View>
      ))}
      {access.canWrite && (
        <Button
          title={t("detail.link.add")}
          onPress={() => {
            setEditing(null);
            setTitle("");
            setUrl("");
          }}
        />
      )}
      <Sheet
        title={t("detail.link.edit")}
        open={editing !== undefined}
        onClose={() => {
          if (!pending) setEditing(undefined);
        }}
      >
        <Field
          label={t("detail.field.title")}
          value={title}
          onChangeText={setTitle}
          maxLength={200}
        />
        <Field
          label={t("detail.field.url")}
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <ErrorNotice error={add.error ?? update.error} />
        <Button
          title={t("detail.link.save")}
          primary
          disabled={!url || pending}
          onPress={() => {
            void (
              editing
                ? update.mutateAsync({
                    projectId: ticket.projectId,
                    resourceId: editing.id,
                    expectedVersion: editing.version,
                    title,
                    url,
                  })
                : add.mutateAsync({ projectId: ticket.projectId, ticketId: ticket.id, title, url })
            )
              .then(() => setEditing(undefined))
              .catch(() => {});
          }}
        />
      </Sheet>
    </Section>
  );
}
export function Activity({ ticket }: { ticket: Ticket }) {
  const { api } = useConnection(),
    [offset, setOffset] = useState(0);
  const events = useQuery(
    api.query("list_activity", { projectId: ticket.projectId, ticketId: ticket.id, offset }),
  );
  return (
    <Section title={t("native.activity.title")}>
      <ErrorNotice error={events.error} />
      {events.data?.items.map((event) => (
        <View key={event.id}>
          <Body>{formatEvent(event)}</Body>
          <Body muted>{formatTimestamp(event.createdAt)}</Body>
        </View>
      ))}
      <View style={styles.actions}>
        <Button
          title={t("native.activity.previous")}
          disabled={!offset}
          onPress={() => setOffset(Math.max(0, offset - 50))}
        />
        <Button
          title={t("native.activity.next")}
          disabled={offset + 50 >= (events.data?.total ?? 0)}
          onPress={() => setOffset(offset + 50)}
        />
      </View>
    </Section>
  );
}
