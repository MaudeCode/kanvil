import type { ScrollView } from "react-native";
import { ProjectIcon } from "./project-icon.tsx";
import { labelOptions } from "./ticket-values.tsx";
import { TicketProperties } from "./ticket-properties.tsx";
import { useEffect, useState, useRef, type ComponentRef } from "react";
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
  Screen,
  Section,
  Sheet,
  DateField,
  CustomFieldInput,
  MarkdownField,
  TicketPicker,
  TicketTags,
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
  if (ticketId && !current.data)
    return (
      <Screen>
        <ErrorNotice
          error={current.error}
          retrying={current.isFetching}
          onRetry={() => {
            void current.refetch();
          }}
        />
      </Screen>
    );
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
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const [draft, setDraft] = useState(() => createTicketDraft(ticket)),
    [ready, setReady] = useState(false),
    [error, setError] = useState<unknown>(),
    [discarding, setDiscarding] = useState(false);
  const [createMore, setCreateMore] = useState(false);
  const [labels, setLabels] = useState(draft.fields.labels.join(", ")),
    [scopesText, setScopesText] = useState(draft.fields.scopes.join(", "));
  const create = useOperation("create_ticket"),
    update = useOperation("update_ticket");
  const projectId = ticket?.projectId ?? draft.projectId ?? initialProjectId;
  const projects = useAllProjects(),
    access = useProjectAccess(projectId);
  const customFields = useQuery(api.query("list_custom_fields", { projectId }));
  const catalog = useQuery(api.query("list_project_labels", { projectId }));
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
        scroll.current?.scrollTo({ y: 0, animated: true });
      } else onSaved(result);
    } catch (cause) {
      setError(cause);
    }
  }
  if (!ready) return <Loading />;
  const fields = draft.fields,
    stale = !!ticket && ticket.version !== draft.version;
  return (
    <Screen form scrollRef={scroll}>
      {!ticket && (
        <Choice
          label={t("ticket.project.label")}
          value={projectId}
          compact
          options={(projects.data ?? [])
            .filter(
              (project) =>
                !project.archivedAt &&
                (identity.admin || capabilitiesOf(project).includes("ticket.write")),
            )
            .map((project) => ({
              value: project.id,
              label: project.name,
              leading: <ProjectIcon project={project} size={18} />,
            }))}
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
        labelHidden
        variant="title"
        placeholder={t("native.editor.title")}
        value={fields.title}
        onChangeText={(value) => set("title", value)}
        maxLength={500}
        multiline
      />
      <TicketProperties
        compact
        projectId={projectId}
        value={fields}
        onChange={(changes) => change({ ...draft, fields: { ...draft.fields, ...changes } })}
        disabled={!access.canWrite}
      />
      <Choice
        label={t("ticket.tags.labels")}
        value=""
        selected={draft.fields.labels}
        summary={
          draft.fields.labels.length ? (
            <TicketTags projectId={projectId} tags={draft.fields.labels} limit={2} />
          ) : undefined
        }
        options={labelOptions(catalog.data ?? [])}
        onChange={() => {}}
        onToggle={(label) => {
          const next = draft.fields.labels.includes(label)
            ? draft.fields.labels.filter((value) => value !== label)
            : [...draft.fields.labels, label];
          set("labels", next);
          setLabels(next.join(", "));
        }}
      />
      <Body muted small>
        {t("detail.editor.savedLocally")}
      </Body>
      <MarkdownField
        label={t("native.detail.description")}
        value={fields.description}
        onChangeText={(value) => set("description", value)}
        maxLength={100000}
      />
      <Section
        title={t("native.detail.acceptanceCriteria")}
        collapsible
        initiallyOpen={!!fields.acceptanceCriteria}
      >
        <MarkdownField
          label={t("native.detail.acceptanceCriteria")}
          value={fields.acceptanceCriteria}
          onChangeText={(value) => set("acceptanceCriteria", value)}
          maxLength={50000}
        />
      </Section>
      <Section
        title={t("detail.editor.moreProperties")}
        collapsible
        summary={
          <Body muted small>
            {[
              fields.parentId ? t("detail.field.parentTicket") : "",
              fields.startAt ? t("ticket.date.start") : "",
              fields.dueAt ? t("ticket.date.due") : "",
              fields.scopes.length ? fields.scopes.join(", ") : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </Body>
        }
      >
        <Field
          label={t("native.editor.scopes")}
          value={scopesText}
          onChangeText={(value) => {
            setScopesText(value);
            set("scopes", splitTags(value));
          }}
        />
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
      </Section>
      <Button title={t("detail.editor.discardDraft")} danger onPress={() => setDiscarding(true)} />
      <Sheet
        title={t("detail.editor.discardDraft")}
        open={discarding}
        onClose={() => setDiscarding(false)}
      >
        <Button
          title={t("detail.editor.discardDraft")}
          danger
          onPress={() => {
            const next = createTicketDraft(ticket);
            change(next);
            setLabels(next.fields.labels.join(", "));
            setScopesText(next.fields.scopes.join(", "));
            setDiscarding(false);
          }}
        />
      </Sheet>

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
