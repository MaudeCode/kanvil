import { useEffect, useState } from "react";
import { View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  difficulties,
  kinds,
  priorities,
  priorityLabels,
  stateLabels,
  states,
  type Ticket,
} from "@kanvil/contracts";
import {
  createTicketDraft,
  draftFields,
  splitTags,
  ticketDraftSchema,
} from "@kanvil/contracts/drafts";
import { useConnection, useIdentity, useOperation } from "./data.tsx";
import {
  Body,
  Button,
  Check,
  Choice,
  ErrorNotice,
  Field,
  Loading,
  Markdown,
  Screen,
  styles,
} from "./ui.tsx";
import type { ScreenProps } from "./navigation.ts";

export function EditTicket({ route, navigation }: ScreenProps<"Edit">) {
  const { api } = useConnection(),
    { projectId, ticketId } = route.params;
  const current = useQuery({
    ...api.query("get_ticket", { projectId, ticketId: ticketId ?? "new" }),
    enabled: !!ticketId,
  });
  if (ticketId && current.isPending) return <Loading />;
  if (ticketId && !current.data) return <ErrorNotice error={current.error} />;
  return (
    <Editor
      key={`${projectId}:${ticketId ?? "new"}`}
      projectId={projectId}
      {...(current.data ? { ticket: current.data.ticket } : {})}
      onSaved={(ticket) => {
        if (ticketId) navigation.goBack();
        else navigation.replace("Ticket", { projectId, ticketId: ticket.id });
      }}
    />
  );
}
function Editor({
  projectId,
  ticket,
  onSaved,
}: {
  projectId: string;
  ticket?: Ticket;
  onSaved: (ticket: Ticket) => void;
}) {
  const { api, prefix } = useConnection(),
    identity = useIdentity();
  const key = `${prefix}:${identity.id}:draft:${ticket?.projectId ?? projectId}:${ticket?.id ?? "new"}`;
  const [initialTicket] = useState(ticket);
  const [draft, setDraft] = useState(() => createTicketDraft(ticket)),
    [ready, setReady] = useState(false),
    [error, setError] = useState<unknown>(),
    [preview, setPreview] = useState(false);
  const [labels, setLabels] = useState(draft.fields.labels.join(", ")),
    [scopesText, setScopesText] = useState(draft.fields.scopes.join(", "));
  const create = useOperation("create_ticket"),
    update = useOperation("update_ticket");
  const members = useQuery(api.query("list_members", { projectId }));
  // Older servers have no workflow; the editor then offers the canonical statuses.
  const workflow = useQuery(api.query("list_workflow_states", { projectId }));
  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem(key)
      .then((stored) => {
        const parsed = stored ? ticketDraftSchema.safeParse(JSON.parse(stored)) : null;
        const restored = parsed?.success ? parsed.data : createTicketDraft(initialTicket);
        if (mounted) {
          setDraft(restored);
          setLabels(restored.fields.labels.join(", "));
          setScopesText(restored.fields.scopes.join(", "));
          setReady(true);
        }
      })
      .catch((cause: unknown) => {
        if (mounted) {
          setError(cause);
          setReady(true);
        }
      });
    return () => {
      mounted = false;
    };
    // The draft belongs to this editor instance; incoming versions must not replace it.
  }, [key, initialTicket]);
  function change(next: typeof draft) {
    setDraft(next);
    setError(undefined);
    void AsyncStorage.setItem(key, JSON.stringify(next)).catch(setError);
  }
  const set = <K extends keyof typeof draft.fields>(field: K, value: (typeof draft.fields)[K]) =>
    change({ ...draft, fields: { ...draft.fields, [field]: value } });
  async function save() {
    try {
      const fields = draftFields({
        ...draft.fields,
        labels: splitTags(labels),
        scopes: splitTags(scopesText),
      });
      const result = ticket
        ? await update.mutateAsync({
            projectId,
            ticketId: ticket.id,
            expectedVersion: draft.version ?? ticket.version,
            changes: fields,
          })
        : await create.mutateAsync({ projectId, ...fields });
      await AsyncStorage.removeItem(key);
      onSaved(result);
    } catch (cause) {
      setError(cause);
    }
  }
  if (!ready) return <Loading />;
  const fields = draft.fields,
    stale = !!ticket && ticket.version !== draft.version;
  return (
    <Screen>
      {stale && (
        <>
          <Body>This ticket changed. Your saved draft still uses version {draft.version}.</Body>
          <Button
            title="Discard draft and reload"
            onPress={() => {
              const next = createTicketDraft(ticket);
              change(next);
              setLabels(next.fields.labels.join(", "));
              setScopesText(next.fields.scopes.join(", "));
            }}
          />
        </>
      )}
      <ErrorNotice error={error ?? create.error ?? update.error} />
      <Field
        label="Title"
        value={fields.title}
        onChangeText={(value) => set("title", value)}
        maxLength={500}
        multiline
      />
      <Choice
        label="Status"
        value={
          fields.stateId ??
          workflow.data?.find((state) => state.category === fields.status)?.id ??
          fields.status
        }
        options={
          workflow.data?.length
            ? workflow.data.map((state) => ({ value: state.id, label: state.name }))
            : states.map((value) => ({ value, label: stateLabels[value] }))
        }
        onChange={(value) => {
          const state = workflow.data?.find((item) => item.id === value);
          change({
            ...draft,
            fields: {
              ...draft.fields,
              ...(state
                ? { status: state.category, stateId: state.id }
                : { status: z.enum(states).parse(value), stateId: null }),
            },
          });
        }}
      />
      <Choice
        label="Priority"
        value={fields.priority}
        options={priorities.map((value) => ({ value, label: priorityLabels[value] }))}
        onChange={(value) => set("priority", z.enum(priorities).parse(value))}
      />
      <Choice
        label="Kind"
        value={fields.kind}
        options={kinds.map((value) => ({ value, label: value }))}
        onChange={(value) => set("kind", z.enum(kinds).parse(value))}
      />
      <Choice
        label="Difficulty"
        value={fields.difficulty ?? ""}
        options={[
          { value: "", label: "Unspecified" },
          ...difficulties.map((value) => ({ value, label: value })),
        ]}
        onChange={(value) => set("difficulty", value ? z.enum(difficulties).parse(value) : null)}
      />
      <Choice
        label="Assignee"
        value={fields.assigneeId ?? ""}
        options={[
          { value: "", label: "Unassigned" },
          ...(members.data?.map((member) => ({ value: member.userId, label: member.name })) ?? []),
        ]}
        onChange={(value) => set("assigneeId", value || null)}
      />
      <Field
        label="Labels (comma separated)"
        value={labels}
        onChangeText={(value) => {
          setLabels(value);
          set("labels", splitTags(value));
        }}
      />
      <Field
        label="Scopes (comma separated)"
        value={scopesText}
        onChangeText={(value) => {
          setScopesText(value);
          set("scopes", splitTags(value));
        }}
      />
      <Button
        title={preview ? "Edit Markdown" : "Preview Markdown"}
        onPress={() => setPreview(!preview)}
      />
      {preview ? (
        <>
          <Markdown>{fields.description}</Markdown>
          <Markdown>{fields.acceptanceCriteria}</Markdown>
        </>
      ) : (
        <>
          <Field
            label="Description (Markdown)"
            value={fields.description}
            onChangeText={(value) => set("description", value)}
            multiline
            maxLength={100000}
          />
          <Field
            label="Acceptance criteria (Markdown)"
            value={fields.acceptanceCriteria}
            onChangeText={(value) => set("acceptanceCriteria", value)}
            multiline
            maxLength={50000}
          />
        </>
      )}
      <Field
        label="Parent ticket ID"
        value={fields.parentId ?? ""}
        autoCapitalize="none"
        onChangeText={(value) => set("parentId", value || null)}
      />
      <Check
        label="Ready for agents when requirements and dependencies permit"
        checked={fields.automationReady}
        onChange={(value) => set("automationReady", value)}
      />
      <Field
        label="Hold reason"
        value={fields.holdReason ?? ""}
        onChangeText={(value) => set("holdReason", value || null)}
        maxLength={2000}
      />
      <View style={styles.actions}>
        <Body muted>Draft saved on this device</Body>
      </View>
      <Button
        title="Save ticket"
        primary
        disabled={stale || create.isPending || update.isPending}
        onPress={() => {
          void save();
        }}
      />
    </Screen>
  );
}
