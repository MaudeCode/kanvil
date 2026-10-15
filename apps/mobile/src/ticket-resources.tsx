import { formatTimestamp } from "@kanvil/contracts";
import { useState } from "react";
import { Alert, Linking, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { attachmentLimit, evidenceFields, type Ticket, type Output } from "@kanvil/contracts";
import { useConnection, useOperation } from "./data.tsx";
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
} from "./ui.tsx";

export function Attachments({ ticket }: { ticket: Ticket }) {
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
        if (file.size > attachmentLimit) throw new Error("Choose a file no larger than 10 MB.");
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
        throw new Error("File sharing is unavailable on this device.");
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
    <Section title="Attachments">
      {attachments.data?.map((item) => (
        <View key={item.id} style={{ gap: 8 }}>
          <Button
            title={`${item.name} · ${Math.max(1, Math.ceil(item.size / 1000))} kB`}
            disabled={pending}
            onPress={() => {
              void open(item);
            }}
          />
          <Button
            title={`Remove ${item.name}`}
            disabled={remove.isPending}
            onPress={() =>
              Alert.alert("Remove attachment?", item.name, [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Remove",
                  style: "destructive",
                  onPress: () =>
                    remove.mutate({ projectId: ticket.projectId, attachmentId: item.id }),
                },
              ])
            }
          />
        </View>
      ))}
      <ErrorNotice error={error ?? attachments.error ?? remove.error} />
      <Button
        title={pending ? "Working…" : "Add attachment"}
        disabled={pending}
        onPress={() => {
          void choose();
        }}
      />
    </Section>
  );
}
export function Evidence({ ticket }: { ticket: Ticket }) {
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
    <Section title="Evidence">
      <Body muted>Outcomes are reported by their submitting accounts.</Body>
      {items.data?.map((item) => (
        <View key={item.id} style={{ gap: 8, paddingVertical: 10 }}>
          <Button
            title={item.title}
            onPress={() => {
              void Linking.openURL(item.url).catch(setError);
            }}
          />
          <Body muted>
            {item.kind} · {item.outcome}
            {item.commit ? ` · ${item.commit}` : ""}
          </Body>
          <Markdown>{item.note}</Markdown>
        </View>
      ))}
      <Button title="Add evidence" onPress={() => setOpen(true)} />
      <ErrorNotice error={items.error ?? error} />
      <Sheet title="Add evidence" open={open} onClose={() => setOpen(false)}>
        <Field label="Title" value={title} onChangeText={setTitle} maxLength={200} />
        <Field
          label="URL"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Choice
          label="Kind"
          value={kind}
          onChange={setKind}
          options={evidenceFields.shape.kind.options.map((value) => ({ value, label: value }))}
        />
        <Choice
          label="Reported outcome"
          value={outcome}
          onChange={setOutcome}
          options={["reported", "pending", "passed", "failed"].map((value) => ({
            value,
            label: value,
          }))}
        />
        <Field
          label="Commit (full hash)"
          value={commit}
          onChangeText={setCommit}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Field label="Note" value={note} onChangeText={setNote} multiline maxLength={20000} />
        <ErrorNotice error={add.error} />
        <Button
          title="Save evidence"
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
export function Activity({ ticket }: { ticket: Ticket }) {
  const { api } = useConnection(),
    [offset, setOffset] = useState(0);
  const events = useQuery(
    api.query("list_activity", { projectId: ticket.projectId, ticketId: ticket.id, offset }),
  );
  return (
    <Section title="Activity">
      <ErrorNotice error={events.error} />
      {events.data?.items.map((event) => (
        <View key={event.id}>
          <Body>{event.type.replaceAll(".", " · ").replaceAll("_", " ")}</Body>
          <Body muted>{formatTimestamp(event.createdAt)}</Body>
        </View>
      ))}
      <View style={styles.actions}>
        <Button
          title="Previous activity"
          disabled={!offset}
          onPress={() => setOffset(Math.max(0, offset - 50))}
        />
        <Button
          title="Next activity"
          disabled={offset + 50 >= (events.data?.total ?? 0)}
          onPress={() => setOffset(offset + 50)}
        />
      </View>
    </Section>
  );
}
