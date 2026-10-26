import { TicketProperties } from "./ticket-properties.tsx";
import { useEffect, useState } from "react";
import { View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery } from "@tanstack/react-query";
import { type Ticket, capabilitiesOf } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import {
  createTicketDraft,
  draftFields,
  splitTags,
  ticketDraftSchema,
  parseCustomFieldDraft,
} from "@kanvil/contracts/drafts";
import {
  useConnection,
  useIdentity,
  useOperation,
  useAllProjects,
  useProjectAccess,
} from "./data.tsx";
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
  DateField,
  CustomFieldInput,
  MarkdownField,
  TicketPicker,
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
        else navigation.replace("Ticket", { projectId: ticket.projectId, ticketId: ticket.id });
      }}
    />
  );
}
function Editor({
  projectId: initialProjectId,
  ticket,
  onSaved,
}: {
  projectId: string;
  ticket?: Ticket;
  onSaved: (ticket: Ticket) => void;
}) {
  const { api, prefix } = useConnection(),
    identity = useIdentity();
  const key = `${prefix}:${identity.id}:draft:${ticket?.projectId ?? initialProjectId}:${ticket?.id ?? "new"}`;
  const [initialTicket] = useState(ticket);
  const [draft, setDraft] = useState(() => createTicketDraft(ticket)),
    [ready, setReady] = useState(false),
    [error, setError] = useState<unknown>(),
    [preview, setPreview] = useState(false);
  const [createMore, setCreateMore] = useState(false);
  const [labels, setLabels] = useState(draft.fields.labels.join(", ")),
    [scopesText, setScopesText] = useState(draft.fields.scopes.join(", "));
  const create = useOperation("create_ticket"),
    update = useOperation("update_ticket");
  const projectId = ticket?.projectId ?? draft.projectId ?? initialProjectId;
  const projects = useAllProjects(),
    access = useProjectAccess(projectId);
  const customFields = useQuery(api.query("list_custom_fields", { projectId }));
  const catalog = useQuery(api.query("list_ticket_labels", { projectId }));
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
        customFields: Object.fromEntries(
          Object.entries(draft.fields.customFields).map(([id, value]) => {
            const field = customFields.data?.find((item) => item.id === id);
            return [id, field ? parseCustomFieldDraft(field, value) : value];
          }),
        ),
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
      if (!ticket && createMore) {
        change({
          fields: { ...draft.fields, title: "", description: "", acceptanceCriteria: "" },
          projectId,
          uploads: [],
        });
      } else onSaved(result);
    } catch (cause) {
      setError(cause);
    }
  }
  if (!ready) return <Loading />;
  const fields = draft.fields,
    stale = !!ticket && ticket.version !== draft.version;
  return (
    <Screen form>
      {!ticket && (
        <Choice
          label={t("ticket.project.label")}
          value={projectId}
          options={(projects.data ?? [])
            .filter(
              (project) =>
                !project.archivedAt &&
                (identity.admin || capabilitiesOf(project).includes("ticket.write")),
            )
            .map((project) => ({ value: project.id, label: project.name }))}
          onChange={(next) => {
            change({
              ...draft,
              projectId: next,
              fields: {
                ...draft.fields,
                stateId: null,
                parentId: null,
                assigneeId: null,
                labels: [],
                customFields: {},
              },
            });
            setLabels("");
          }}
        />
      )}
      {stale && (
        <>
          <Body>{t("native.editor.stale", { version: draft.version ?? "" })}</Body>
          <Button
            title={t("native.editor.discardDraft")}
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
        label={t("native.editor.title")}
        value={fields.title}
        onChangeText={(value) => set("title", value)}
        maxLength={500}
        multiline
      />
      <TicketProperties
        projectId={projectId}
        value={fields}
        onChange={(changes) => change({ ...draft, fields: { ...draft.fields, ...changes } })}
        disabled={!access.canWrite}
      />
      <Choice
        label={t("ticket.tags.labels")}
        value=""
        selected={draft.fields.labels}
        options={(catalog.data ?? []).map((label) => ({ value: label.name, label: label.name }))}
        onChange={() => {}}
        onToggle={(label) => {
          const next = draft.fields.labels.includes(label)
            ? draft.fields.labels.filter((value) => value !== label)
            : [...draft.fields.labels, label];
          set("labels", next);
          setLabels(next.join(", "));
        }}
      />
      <Field
        label={t("native.editor.scopes")}
        value={scopesText}
        onChangeText={(value) => {
          setScopesText(value);
          set("scopes", splitTags(value));
        }}
      />
      <Button
        title={preview ? t("native.editor.editMarkdown") : t("native.editor.previewMarkdown")}
        onPress={() => setPreview(!preview)}
      />
      {preview ? (
        <>
          <Markdown>{fields.description}</Markdown>
          <Markdown>{fields.acceptanceCriteria}</Markdown>
        </>
      ) : (
        <>
          <MarkdownField
            label={t("native.editor.description")}
            value={fields.description}
            onChangeText={(value) => set("description", value)}
            maxLength={100000}
          />
          <MarkdownField
            label={t("native.editor.acceptanceCriteria")}
            value={fields.acceptanceCriteria}
            onChangeText={(value) => set("acceptanceCriteria", value)}
            maxLength={50000}
          />
        </>
      )}
      <TicketPicker
        label={t("detail.field.parentTicket")}
        projectId={projectId}
        value={fields.parentId}
        {...(ticket ? { excludeId: ticket.id } : {})}
        onChange={(value) => set("parentId", value)}
      />
      <DateField
        label={t("ticket.date.start")}
        value={fields.startAt}
        dayBoundary="start"
        bounds={{ to: fields.dueAt }}
        onChange={(value) => set("startAt", value)}
      />
      <DateField
        label={t("ticket.date.due")}
        value={fields.dueAt}
        dayBoundary="end"
        bounds={{ from: fields.startAt }}
        onChange={(value) => set("dueAt", value)}
      />
      {customFields.data?.map((field) => (
        <CustomFieldInput
          key={field.id}
          field={field}
          value={fields.customFields[field.id]}
          onChange={(value) => set("customFields", { ...fields.customFields, [field.id]: value })}
        />
      ))}
      <Check
        label={t("native.editor.automationReady")}
        checked={fields.automationReady}
        onChange={(value) => set("automationReady", value)}
      />
      <Field
        label={t("native.editor.holdReason")}
        value={fields.holdReason ?? ""}
        onChangeText={(value) => set("holdReason", value || null)}
        maxLength={2000}
      />
      <View style={styles.actions}>
        <Body muted>{t("native.editor.draftSaved")}</Body>
      </View>
      <Button
        title={t("native.editor.save")}
        primary
        disabled={
          stale || create.isPending || update.isPending || !access.canWrite || !fields.title.trim()
        }
        onPress={() => {
          void save();
        }}
      />
      {!ticket && (
        <Check
          label={t("detail.editor.createMore")}
          checked={createMore}
          onChange={setCreateMore}
        />
      )}
    </Screen>
  );
}
