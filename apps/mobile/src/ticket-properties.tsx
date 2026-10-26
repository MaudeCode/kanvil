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
const mixedValue = "__mixed__";
export function TicketProperties({
  projectId,
  value,
  onChange,
  mixed = false,
  disabled = false,
}: {
  projectId: string;
  value: { [K in keyof PropertyFields]: PropertyFields[K] | undefined };
  onChange: (change: PropertyFields) => void;
  mixed?: boolean;
  disabled?: boolean;
}) {
  const { api } = useConnection();
  const members = useQuery(api.query("list_members", { projectId }));
  const workflow = useQuery({
    ...api.query("list_workflow_states", { projectId }),
    select: presentWorkflow,
  });
  const prefix = mixed ? [{ value: mixedValue, label: t("ticket.field.mixed") }] : [];
  return (
    <>
      <Choice
        label={t("common.filterField.status")}
        disabled={disabled}
        value={
          mixed && value.stateId === undefined
            ? mixedValue
            : (value.stateId ??
              workflow.data?.find((state) => state.category === value.status)?.id ??
              value.status ??
              mixedValue)
        }
        options={[
          ...prefix,
          ...(workflow.data?.length
            ? workflow.data.map((state) => ({ value: state.id, label: state.name }))
            : states.map((status) => ({ value: status, label: stateLabels[status] }))),
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
        value={value.priority ?? mixedValue}
        options={[
          ...prefix,
          ...priorities.map((priority) => ({ value: priority, label: priorityLabels[priority] })),
        ]}
        onChange={(next) => {
          const priority = priorities.find((item) => item === next);
          if (priority) onChange({ priority });
        }}
      />
      <Choice
        label={t("common.filterField.kind")}
        disabled={disabled}
        value={value.kind ?? mixedValue}
        options={[...prefix, ...kinds.map((kind) => ({ value: kind, label: kindLabels[kind] }))]}
        onChange={(next) => {
          const kind = kinds.find((item) => item === next);
          if (kind) onChange({ kind });
        }}
      />
      <Choice
        label={t("common.filterField.difficulty")}
        disabled={disabled}
        value={value.difficulty === undefined ? mixedValue : (value.difficulty ?? "")}
        options={[
          ...prefix,
          { value: "", label: t("native.editor.noDifficulty") },
          ...difficulties.map((difficulty) => ({
            value: difficulty,
            label: difficultyLabels[difficulty],
          })),
        ]}
        onChange={(next) => {
          if (next === mixedValue) return;
          onChange({ difficulty: difficulties.find((item) => item === next) ?? null });
        }}
      />
      <Choice
        label={t("common.filterField.assigneeId")}
        disabled={disabled}
        value={value.assigneeId === undefined ? mixedValue : (value.assigneeId ?? "")}
        options={[
          ...prefix,
          { value: "", label: t("common.state.unassigned") },
          ...(members.data ?? []).map((member) => ({ value: member.userId, label: member.name })),
        ]}
        onChange={(next) => {
          if (next !== mixedValue) onChange({ assigneeId: next || null });
        }}
      />
      <ErrorNotice error={members.error} />
    </>
  );
}
