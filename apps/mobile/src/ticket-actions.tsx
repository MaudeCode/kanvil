import { useState } from "react";
import { Alert, Share } from "react-native";
import { StackActions } from "@react-navigation/native";
import { useQuery } from "@tanstack/react-query";
import { capabilitiesOf, type Input, type Ticket } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { parseCustomFieldDraft, sharedTicketValue } from "@kanvil/contracts/drafts";
import {
  useAllProjects,
  useConnection,
  useIdentity,
  useOperation,
  useProjectAccess,
} from "./data.tsx";
import { useAppNavigation } from "./navigation.ts";
import { TicketProperties, type PropertyFields } from "./ticket-properties.tsx";
import {
  Body,
  Button,
  Choice,
  CustomFieldInput,
  DateField,
  Field,
  ErrorNotice,
  Loading,
  Section,
} from "./ui.tsx";

// One action surface for list rows and ticket detail, backed by the same versioned operations.
export function TicketActions({
  ticket,
  onClose,
  onSelect,
  detail = false,
  order,
}: {
  ticket: Ticket;
  onClose: () => void;
  onSelect?: () => void;
  detail?: boolean;
  order?: Ticket[];
}) {
  const { api, baseUrl } = useConnection(),
    access = useProjectAccess(ticket.projectId),
    navigation = useAppNavigation();
  const current = useQuery(
    api.query("get_ticket", { projectId: ticket.projectId, ticketId: ticket.id }),
  );
  const update = useOperation("update_ticket"),
    duplicate = useOperation("duplicate_ticket"),
    remove = useOperation("delete_ticket"),
    follow = useOperation("set_subscription"),
    move = useOperation("move_ticket");
  const [relocating, setRelocating] = useState(false);
  const pending = update.isPending || duplicate.isPending || remove.isPending || move.isPending;
  function change(fields: PropertyFields) {
    const { stateId, ...rest } = fields;
    void update
      .mutateAsync({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        expectedVersion: ticket.version,
        changes: { ...rest, ...(stateId ? { stateId } : {}) },
      })
      .then(onClose)
      .catch(() => {});
  }
  function place(where: "up" | "down" | "first" | "last") {
    if (!order) return;
    const index = order.findIndex((item) => item.id === ticket.id);
    const neighbor =
      where === "up"
        ? order[index - 1]
        : where === "down"
          ? order[index + 1]
          : where === "first"
            ? order[0]
            : order.at(-1);
    if (!neighbor || neighbor.id === ticket.id) return;
    const placement =
      where === "up" || where === "first" ? { before: neighbor.id } : { after: neighbor.id };
    void move
      .mutateAsync({
        projectId: ticket.projectId,
        ticketId: ticket.id,
        expectedVersion: ticket.version,
        ...placement,
      })
      .then(onClose)
      .catch(() => {});
  }
  if (relocating) return <Relocation ticket={ticket} detail={detail} onSaved={onClose} />;
  return (
    <>
      {!detail && (
        <Button
          title={t("ticket.menu.open")}
          onPress={() => {
            onClose();
            navigation.navigate("Ticket", { projectId: ticket.projectId, ticketId: ticket.id });
          }}
        />
      )}
      {onSelect && access.canWrite && (
        <Button
          title={t("ticket.list.selectTicket", { key: ticket.key })}
          onPress={() => {
            onSelect();
            onClose();
          }}
        />
      )}
      {access.canWrite && (
        <>
          <Button
            title={t("ticket.menu.edit")}
            onPress={() => {
              onClose();
              navigation.navigate("Edit", { projectId: ticket.projectId, ticketId: ticket.id });
            }}
          />
          <TicketProperties
            projectId={ticket.projectId}
            value={ticket}
            onChange={change}
            disabled={pending}
          />
          <Button
            title={t("ticket.menu.duplicate")}
            disabled={pending}
            onPress={() => {
              void duplicate
                .mutateAsync({ projectId: ticket.projectId, ticketId: ticket.id })
                .then((copy) => {
                  onClose();
                  navigation.navigate("Ticket", { projectId: copy.projectId, ticketId: copy.id });
                })
                .catch(() => {});
            }}
          />
          <Button
            title={t("ticket.menu.moveToProject")}
            disabled={pending}
            onPress={() => setRelocating(true)}
          />
          {order && (
            <Section title={t("ticket.menu.move")}>
              <Button
                title={t("shell.move.up.menu")}
                disabled={pending || order[0]?.id === ticket.id}
                onPress={() => place("up")}
              />
              <Button
                title={t("shell.move.down.menu")}
                disabled={pending || order.at(-1)?.id === ticket.id}
                onPress={() => place("down")}
              />
            </Section>
          )}
          <Button
            title={ticket.archived ? t("ticket.menu.unarchive") : t("ticket.menu.archive")}
            disabled={pending}
            onPress={() =>
              Alert.alert(
                ticket.archived ? t("ticket.menu.unarchive") : t("ticket.menu.archive"),
                ticket.key,
                [
                  { text: t("common.action.cancel"), style: "cancel" },
                  {
                    text: t("common.action.confirm"),
                    onPress: () => {
                      void update
                        .mutateAsync({
                          projectId: ticket.projectId,
                          ticketId: ticket.id,
                          expectedVersion: ticket.version,
                          changes: { archived: !ticket.archived },
                        })
                        .then(onClose)
                        .catch(() => {});
                    },
                  },
                ],
              )
            }
          />
        </>
      )}
      <Button
        title={current.data?.subscribed ? t("ticket.menu.unfollow") : t("ticket.menu.follow")}
        disabled={follow.isPending || !current.data}
        onPress={() => {
          void follow
            .mutateAsync({
              projectId: ticket.projectId,
              ticketId: ticket.id,
              enabled: !current.data?.subscribed,
            })
            .then(onClose)
            .catch(() => {});
        }}
      />
      <Button
        title={t("native.detail.share")}
        onPress={() => {
          void Share.share({
            message: `${ticket.key}: ${ticket.title}\n${baseUrl}/projects/${ticket.projectId}/tickets/${ticket.id}`,
          });
        }}
      />
      {access.canDelete && (
        <Button
          title={t("ticket.menu.delete")}
          danger
          disabled={pending}
          onPress={() =>
            Alert.alert(
              t("ticket.menu.delete"),
              t("ticket.menu.deleteConfirm", { key: ticket.key }),
              [
                { text: t("common.action.cancel"), style: "cancel" },
                {
                  text: t("common.action.delete"),
                  style: "destructive",
                  onPress: () => {
                    void remove
                      .mutateAsync({
                        projectId: ticket.projectId,
                        ticketId: ticket.id,
                        expectedVersion: ticket.version,
                      })
                      .then(() => {
                        onClose();
                        if (detail) navigation.goBack();
                      })
                      .catch(() => {});
                  },
                },
              ],
            )
          }
        />
      )}
      <ErrorNotice
        error={
          current.error ??
          update.error ??
          duplicate.error ??
          remove.error ??
          follow.error ??
          move.error
        }
      />
    </>
  );
}

function Relocation({
  ticket,
  detail,
  onSaved,
}: {
  ticket: Ticket;
  detail: boolean;
  onSaved: () => void;
}) {
  const { api } = useConnection(),
    projects = useAllProjects(),
    identity = useIdentity(),
    navigation = useAppNavigation();
  const workspaceId = projects.data?.find(
    (project) => project.id === ticket.projectId,
  )?.workspaceId;
  const [destinationProjectId, setDestination] = useState(""),
    [stateId, setState] = useState("");
  const preview = useQuery({
    ...api.query("check_ticket_relocation", {
      projectId: ticket.projectId,
      ticketId: ticket.id,
      destinationProjectId,
    }),
    enabled: !!destinationProjectId,
  });
  const relocate = useOperation("relocate_ticket");
  return (
    <>
      <Choice
        label={t("ticket.move.destination")}
        value={destinationProjectId}
        options={[
          { value: "", label: t("ticket.move.projectPlaceholder") },
          ...(projects.data ?? [])
            .filter(
              (project) =>
                project.workspaceId === workspaceId &&
                project.id !== ticket.projectId &&
                !project.archivedAt &&
                (identity.admin || capabilitiesOf(project).includes("ticket.write")),
            )
            .map((project) => ({ value: project.id, label: project.name })),
        ]}
        onChange={(value) => {
          setDestination(value);
          setState("");
        }}
      />
      {destinationProjectId && preview.isPending && <Loading />}
      {preview.data && (
        <>
          <Choice
            label={t("common.filterField.status")}
            value={stateId || preview.data.stateId}
            options={preview.data.states.map((state) => ({ value: state.id, label: state.name }))}
            onChange={setState}
          />
          {preview.data.blockers.map((blocker) => (
            <Body key={blocker.code}>{blocker.message}</Body>
          ))}
        </>
      )}
      <ErrorNotice error={preview.error ?? relocate.error} />
      <Button
        title={t("ticket.move.submit")}
        primary
        disabled={!preview.data || !!preview.data.blockers.length || relocate.isPending}
        onPress={() => {
          void relocate
            .mutateAsync({
              projectId: ticket.projectId,
              ticketId: ticket.id,
              destinationProjectId,
              expectedVersion: ticket.version,
              ...(stateId ? { stateId } : {}),
            })
            .then((moved) => {
              onSaved();
              const params = { projectId: moved.projectId, ticketId: moved.id };
              if (detail) navigation.dispatch(StackActions.replace("Ticket", params));
              else navigation.navigate("Ticket", params);
            })
            .catch(() => {});
        }}
      />
    </>
  );
}

export function BulkProperties({
  projectId,
  tickets,
  onChange,
}: {
  projectId: string;
  tickets: Ticket[];
  onChange: (change: Input<"update_ticket">["changes"]) => Promise<unknown>;
}) {
  const { api } = useConnection();
  const labels = useQuery(api.query("list_ticket_labels", { projectId })),
    customFields = useQuery(api.query("list_custom_fields", { projectId }));
  const [fields, setFields] = useState<Input<"update_ticket">["changes"]>({}),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>();
  function common<K extends keyof PropertyFields>(key: K) {
    const result = sharedTicketValue(tickets, (ticket) => ticket[key]);
    return result.mixed ? undefined : result.value;
  }
  const commonProperties = {
    status: common("status"),
    stateId: common("stateId"),
    priority: common("priority"),
    kind: common("kind"),
    difficulty: common("difficulty"),
    assigneeId: common("assigneeId"),
  };
  return (
    <>
      <TicketProperties
        projectId={projectId}
        value={{ ...commonProperties, ...fields }}
        mixed
        disabled={pending}
        onChange={(changes) =>
          setFields((previous) => {
            const { stateId, ...rest } = changes;
            const next = { ...previous, ...rest };
            if ("stateId" in changes) {
              if (stateId) next.stateId = stateId;
              else delete next.stateId;
            }
            return next;
          })
        }
      />
      {(["startAt", "dueAt"] as const).map((key) => {
        const current = sharedTicketValue(tickets, (ticket) => ticket[key]);
        return (
          <DateField
            key={key}
            label={t(key === "startAt" ? "ticket.date.start" : "ticket.date.due")}
            value={key in fields ? (fields[key] ?? null) : current.mixed ? null : current.value}
            dayBoundary={key === "dueAt" ? "end" : "start"}
            onChange={(value) => setFields((previous) => ({ ...previous, [key]: value }))}
          />
        );
      })}
      {(["labels", "scopes"] as const).map((key) => {
        const current = sharedTicketValue(tickets, (ticket) => ticket[key]);
        const selected = fields[key] ?? (current.mixed ? [] : current.value);
        return key === "labels" ? (
          <Choice
            key={key}
            label={t("ticket.tags.labels")}
            value=""
            selected={selected}
            emptyLabel={
              current.mixed && !(key in fields)
                ? t("ticket.field.mixed")
                : t("ticket.field.noValue")
            }
            options={(labels.data ?? []).map((label) => ({ value: label.name, label: label.name }))}
            onChange={() => {}}
            onToggle={(value) =>
              setFields((previous) => ({
                ...previous,
                labels: selected.includes(value)
                  ? selected.filter((item) => item !== value)
                  : [...selected, value],
              }))
            }
          />
        ) : (
          <Field
            key={key}
            label={t("native.editor.scopes")}
            value={selected.join(", ")}
            placeholder={current.mixed ? t("ticket.field.mixed") : ""}
            onChangeText={(value) =>
              setFields((previous) => ({
                ...previous,
                scopes: value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
              }))
            }
          />
        );
      })}
      {customFields.data?.map((field) => {
        const current = sharedTicketValue(
          tickets,
          (ticket) => ticket.customFields[field.id] ?? null,
        );
        return (
          <CustomFieldInput
            key={field.id}
            field={field}
            value={
              field.id in (fields.customFields ?? {})
                ? fields.customFields?.[field.id]
                : current.mixed
                  ? null
                  : current.value
            }
            onChange={(value) =>
              setFields((previous) => ({
                ...previous,
                customFields: { ...previous.customFields, [field.id]: value },
              }))
            }
          />
        );
      })}
      <ErrorNotice error={error ?? labels.error ?? customFields.error} />
      <Button
        title={t("common.action.apply")}
        primary
        disabled={!Object.keys(fields).length || pending}
        onPress={() => {
          setPending(true);
          setError(undefined);
          void Promise.resolve()
            .then(() =>
              onChange({
                ...fields,
                ...(fields.customFields
                  ? {
                      customFields: Object.fromEntries(
                        Object.entries(fields.customFields).map(([id, value]) => {
                          const field = customFields.data?.find((item) => item.id === id);
                          return [id, field ? parseCustomFieldDraft(field, value) : value];
                        }),
                      ),
                    }
                  : {}),
              }),
            )
            .catch(setError)
            .finally(() => setPending(false));
        }}
      />
    </>
  );
}
