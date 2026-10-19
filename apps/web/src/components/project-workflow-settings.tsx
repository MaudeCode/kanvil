import { useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { stateLabels, states, type Output, type WorkflowState } from "@kanvil/contracts";
import { useOperation } from "../data.tsx";
import {
  ErrorNotice,
  FormActions,
  IconButton,
  Input,
  Loading,
  Modal,
  SectionHeading,
  Select,
  SelectItem,
  TicketIndicator,
  reportError,
  statusColor,
} from "../ui.tsx";
import { SettingRow } from "./settings-layout.tsx";
import { AccentColorPicker } from "./accent-color-picker.tsx";
import { PropertyValue, stateValue, useWorkflow } from "./ticket-property.tsx";

type Category = WorkflowState["category"];
const ticketCount = (count: number) => `${count} ${count === 1 ? "ticket" : "tickets"}`;
// ProjectLabelSettings has no categories, order, or reassignment, so states get their own rows:
// grouped by category, each with its place, presentation, and a delete that moves its tickets.
export function ProjectWorkflowSettings({
  projectId,
  canAdmin,
}: {
  projectId: string;
  canAdmin: boolean;
}) {
  const workflow = useWorkflow(projectId),
    rows = workflow.data ?? [];
  const create = useOperation("create_workflow_state"),
    update = useOperation("update_workflow_state"),
    remove = useOperation("delete_workflow_state");
  const [draft, setDraft] = useState<{
    state: WorkflowState | null;
    name: string;
    category: Category;
    color: WorkflowState["color"];
  } | null>(null);
  const [removing, setRemoving] = useState<{
    state: Output<"list_workflow_states">[number];
    reassignTo: string;
  } | null>(null);
  const busy = create.isPending || update.isPending;
  function edit(state: WorkflowState | null, category: Category = "todo") {
    create.reset();
    update.reset();
    setDraft({
      state,
      name: state?.name ?? "",
      category: state?.category ?? category,
      color: state?.color ?? "default",
    });
  }
  const move = (state: WorkflowState, position: number) =>
    void update
      .mutateAsync({ projectId, stateId: state.id, expectedVersion: state.version, position })
      .catch(reportError);
  return (
    <section>
      <SectionHeading
        title="Workflow"
        action={
          canAdmin && (
            <IconButton label="New state" variant="default" onClick={() => edit(null)}>
              <Plus />
            </IconButton>
          )
        }
      />
      <ErrorNotice error={workflow.error} />
      {workflow.isPending ? (
        <Loading />
      ) : (
        states.map((category) => {
          const group = rows.filter((state) => state.category === category);
          return (
            <div key={category} className="mb-5">
              <h3 className="mb-0 border-b pb-1.5 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                {stateLabels[category]}
              </h3>
              {group.map((state, index) => (
                <SettingRow
                  key={state.id}
                  compact
                  title={
                    <PropertyValue
                      property="status"
                      value={stateValue(state)}
                      projectId={projectId}
                    />
                  }
                >
                  <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                    {ticketCount(state.count)}
                  </span>
                  {canAdmin && (
                    <>
                      <IconButton
                        label={`Move ${state.name} up`}
                        disabled={index === 0 || update.isPending}
                        onClick={() => move(state, index - 1)}
                      >
                        <ArrowUp />
                      </IconButton>
                      <IconButton
                        label={`Move ${state.name} down`}
                        disabled={index === group.length - 1 || update.isPending}
                        onClick={() => move(state, index + 1)}
                      >
                        <ArrowDown />
                      </IconButton>
                      <IconButton label={`Edit state ${state.name}`} onClick={() => edit(state)}>
                        <Pencil />
                      </IconButton>
                      <IconButton
                        label={
                          group.length === 1
                            ? `${state.name} is the only ${stateLabels[category]} state`
                            : `Delete state ${state.name}`
                        }
                        disabled={group.length === 1}
                        onClick={() => {
                          remove.reset();
                          setRemoving({
                            state,
                            reassignTo: group.find((other) => other.id !== state.id)?.id ?? "",
                          });
                        }}
                      >
                        <Trash2 />
                      </IconButton>
                    </>
                  )}
                </SettingRow>
              ))}
            </div>
          );
        })
      )}
      <Modal
        title={draft?.state ? "Edit state" : "New state"}
        open={!!draft}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
        busy={busy}
      >
        {draft && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const action = draft.state
                ? update.mutateAsync({
                    projectId,
                    stateId: draft.state.id,
                    expectedVersion: draft.state.version,
                    name: draft.name,
                    color: draft.color,
                    category: draft.category,
                  })
                : create.mutateAsync({
                    projectId,
                    name: draft.name,
                    category: draft.category,
                    color: draft.color,
                  });
              void action
                .then(() => {
                  setDraft(null);
                  toast.success("State saved");
                })
                .catch(() => {});
            }}
          >
            <Input
              label="State name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              maxLength={40}
              required
              autoFocus
            />
            <Select
              label="Category"
              value={draft.category}
              onValueChange={(value) => {
                const category = states.find((item) => item === value);
                if (category) setDraft({ ...draft, category });
              }}
            >
              {states.map((category) => (
                <SelectItem key={category} value={category}>
                  {stateLabels[category]}
                </SelectItem>
              ))}
            </Select>
            <AccentColorPicker
              label="State color"
              value={draft.color}
              onChange={(color) => setDraft({ ...draft, color })}
              disabled={busy}
              custom
              defaultTint={statusColor(draft.category)}
            />
            {!!draft.name.trim() && (
              <div className="mb-4">
                <TicketIndicator
                  property="status"
                  value={draft.category}
                  label={draft.name.trim()}
                  color={draft.color}
                />
              </div>
            )}
            {draft.state && draft.category !== draft.state.category && (
              <p className="text-xs text-muted-foreground">
                Its tickets change status to {stateLabels[draft.category]}.
              </p>
            )}
            <FormActions
              error={create.error ?? update.error}
              pending={busy}
              submitLabel="Save state"
              submitDisabled={!draft.name.trim()}
              onCancel={() => setDraft(null)}
            />
          </form>
        )}
      </Modal>
      <Modal
        title={removing ? `Delete ${removing.state.name}` : "Delete state"}
        open={!!removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        busy={remove.isPending}
      >
        {removing && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void remove
                .mutateAsync({
                  projectId,
                  stateId: removing.state.id,
                  expectedVersion: removing.state.version,
                  reassignTo: removing.reassignTo,
                })
                .then(() => {
                  setRemoving(null);
                  toast.success("State deleted");
                })
                .catch(() => {});
            }}
          >
            <Select
              label={`Move ${ticketCount(removing.state.count)} to`}
              value={removing.reassignTo}
              onValueChange={(value) => {
                if (value) setRemoving({ ...removing, reassignTo: value });
              }}
            >
              {rows
                .filter((state) => state.id !== removing.state.id)
                .map((state) => (
                  <SelectItem key={state.id} value={state.id}>
                    {state.name}
                  </SelectItem>
                ))}
            </Select>
            <FormActions
              error={remove.error}
              pending={remove.isPending}
              submitLabel="Delete state"
              submitDisabled={!removing.reassignTo}
              onCancel={() => setRemoving(null)}
            />
          </form>
        )}
      </Modal>
    </section>
  );
}
