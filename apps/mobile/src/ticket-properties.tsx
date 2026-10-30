import type { ReactNode } from "react";
import { View } from "react-native";
import { PropertyValue, propertyOption } from "./ticket-values.tsx";
import { useQuery } from "@tanstack/react-query";
import {
  difficulties,
  difficultyLabels,
  kinds,
  kindLabels,
  priorities,
  priorityLabels,
  presentWorkflow,
  stateLabels,
  states,
  type Ticket,
} from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { useConnection } from "./data.tsx";
import { Choice, ErrorNotice } from "./ui.tsx";

// The native sibling of the web property picker. Drafts, inline edits and bulk edits share it.
export type PropertyFields = Partial<
  Pick<Ticket, "status" | "stateId" | "priority" | "kind" | "difficulty" | "assigneeId">
>;
// Clearing a legacy workflow ID means writing its canonical category, never a null stateId.
export function propertyChanges({ stateId, ...rest }: PropertyFields) {
  return { ...rest, ...(stateId ? { stateId } : {}) };
}
const mixedValue = "__mixed__";
export function TicketProperties({
  projectId,
  value,
  onChange,
  mixed = false,
  disabled = false,
  compact = false,
  children,
  leading,
}: {
  projectId: string;
  value: { [K in keyof PropertyFields]: PropertyFields[K] | undefined };
  onChange: (change: PropertyFields) => void;
  mixed?: boolean;
  disabled?: boolean;
  compact?: boolean;
  children?: ReactNode;
  leading?: ReactNode;
}) {
  const { api } = useConnection();
  const members = useQuery(api.query("list_members", { projectId }));
  const workflow = useQuery({
    ...api.query("list_workflow_states", { projectId }),
    select: presentWorkflow,
  });
  const prefix = mixed ? [{ value: mixedValue, label: t("ticket.field.mixed") }] : [];
  const stateId =
    value.stateId ?? workflow.data?.find((state) => state.category === value.status)?.id;
  return (
    <>
      <View style={compact ? { flexDirection: "row", flexWrap: "wrap", gap: 8 } : { gap: 4 }}>
        {leading}
        <Choice
          label={t("common.filterField.status")}
          summary={
            compact && value.status && !(mixed && value.stateId === undefined) ? (
              <PropertyValue
                projectId={projectId}
                property="status"
                value={value.status}
                stateId={stateId ?? null}
              />
            ) : undefined
          }
          disabled={disabled}
          compact={compact}
          value={
            mixed && value.stateId === undefined
              ? mixedValue
              : (stateId ?? value.status ?? mixedValue)
          }
          options={[
            ...prefix,
            ...(workflow.data?.length
              ? workflow.data.map((state) =>
                  propertyOption({
                    projectId,
                    property: "status",
                    value: state.category,
                    stateId: state.id,
                    optionValue: state.id,
                    label: state.name,
                  }),
                )
              : states.map((status) =>
                  propertyOption({
                    projectId,
                    property: "status",
                    value: status,
                    optionValue: status,
                    label: stateLabels[status],
                  }),
                )),
          ]}
          onChange={(next) => {
            if (next === mixedValue) return;
            const state = workflow.data?.find((item) => item.id === next);
            if (state) onChange({ stateId: state.id, status: state.category });
            else {
              const status = states.find((item) => item === next);
              if (status) onChange({ stateId: null, status });
            }
          }}
        />
        <Choice
          label={t("common.filterField.priority")}
          disabled={disabled}
          compact={compact}
          value={value.priority ?? mixedValue}
          options={[
            ...prefix,
            ...priorities.map((priority) =>
              propertyOption({
                projectId,
                property: "priority",
                value: priority,
                optionValue: priority,
                label: priorityLabels[priority],
              }),
            ),
          ]}
          onChange={(next) => {
            const priority = priorities.find((item) => item === next);
            if (priority) onChange({ priority });
          }}
        />
        <Choice
          label={t("common.filterField.assigneeId")}
          disabled={disabled}
          compact={compact}
          value={value.assigneeId === undefined ? mixedValue : (value.assigneeId ?? "")}
          options={[
            ...prefix,
            propertyOption({
              projectId,
              property: "assignee",
              value: null,
              optionValue: "",
              label: t("common.state.unassigned"),
            }),
            ...(members.data ?? []).map((member) =>
              propertyOption({
                projectId,
                property: "assignee",
                value: member.userId,
                optionValue: member.userId,
                label: member.name,
              }),
            ),
          ]}
          onChange={(next) => {
            if (next !== mixedValue) onChange({ assigneeId: next || null });
          }}
        />
        <Choice
          label={t("common.filterField.kind")}
          disabled={disabled}
          compact={compact}
          value={value.kind ?? mixedValue}
          options={[
            ...prefix,
            ...kinds.map((kind) =>
              propertyOption({
                projectId,
                property: "kind",
                value: kind,
                optionValue: kind,
                label: kindLabels[kind],
              }),
            ),
          ]}
          onChange={(next) => {
            const kind = kinds.find((item) => item === next);
            if (kind) onChange({ kind });
          }}
        />
        <Choice
          label={t("common.filterField.difficulty")}
          disabled={disabled}
          compact={compact}
          value={value.difficulty === undefined ? mixedValue : (value.difficulty ?? "")}
          options={[
            ...prefix,
            propertyOption({
              projectId,
              property: "difficulty",
              value: null,
              optionValue: "",
              label: t("native.editor.noDifficulty"),
            }),
            ...difficulties.map((difficulty) =>
              propertyOption({
                projectId,
                property: "difficulty",
                value: difficulty,
                optionValue: difficulty,
                label: difficultyLabels[difficulty],
              }),
            ),
          ]}
          onChange={(next) => {
            if (next === mixedValue) return;
            onChange({ difficulty: difficulties.find((item) => item === next) ?? null });
          }}
        />
        {children}
      </View>
      <ErrorNotice error={members.error ?? workflow.error} />
    </>
  );
}
