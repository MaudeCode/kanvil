import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ApiError, type CatalogLabel, type LabelColor } from "@kanvil/contracts";
import { api, useOperation } from "../data.tsx";
import {
  Check,
  Confirm,
  EmptyState,
  ErrorNotice,
  IconButton,
  Input,
  Loading,
  Modal,
  SearchField,
  SectionHeading,
  FormActions,
} from "../ui.tsx";
import { SettingRow } from "./settings-layout.tsx";
import { TicketTag } from "./ticket-tags.tsx";
import { AccentColorPicker } from "./accent-color-picker.tsx";

// The project keys a `label_conflict` names; the workspace label can adopt their definitions.
function conflictingProjects(error: unknown) {
  if (!(error instanceof ApiError) || error.code !== "label_conflict") return [];
  const details: unknown = error.details;
  return details && typeof details === "object" && "projects" in details
    ? [details.projects].flat().filter((key): key is string => typeof key === "string")
    : [];
}

// MemberDirectory edits account roles; labels reuse SettingRow with a name/color editor. A project
// lists its own labels and its workspace's, which only workspace settings edit.
export function LabelSettings({
  owner,
  canAdmin,
}: {
  owner: { projectId: string } | { workspaceId: string };
  canAdmin: boolean;
}) {
  const projectId = "projectId" in owner ? owner.projectId : undefined,
    workspaceId = "workspaceId" in owner ? owner.workspaceId : undefined;
  const projectLabels = useQuery({
      ...api.query("list_project_labels", { projectId: projectId ?? "" }),
      enabled: !!projectId,
    }),
    workspaceLabels = useQuery({
      ...api.query("list_workspace_labels", { workspaceId: workspaceId ?? "" }),
      enabled: !!workspaceId,
    }),
    labels = projectId ? projectLabels : workspaceLabels;
  const create = useOperation("create_project_label"),
    update = useOperation("update_project_label"),
    remove = useOperation("delete_project_label"),
    createShared = useOperation("create_workspace_label"),
    updateShared = useOperation("update_workspace_label"),
    removeShared = useOperation("delete_workspace_label");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<{
    label: CatalogLabel | null;
    name: string;
    color: LabelColor;
    adopt: boolean;
  } | null>(null);
  const busy =
    create.isPending || update.isPending || createShared.isPending || updateShared.isPending;
  const error = create.error ?? update.error ?? createShared.error ?? updateShared.error;
  const conflicts = conflictingProjects(error);
  const rows: CatalogLabel[] = labels.data ?? [];
  const matches = rows.filter((label) =>
    label.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  function edit(label: CatalogLabel | null) {
    for (const action of [create, update, createShared, updateShared]) action.reset();
    setDraft({ label, name: label?.name ?? "", color: label?.color ?? "gray", adopt: false });
  }
  function save(label: CatalogLabel | null, name: string, color: LabelColor, adopt: boolean) {
    if (workspaceId)
      return label
        ? updateShared.mutateAsync({
            workspaceId,
            labelId: label.id,
            expectedVersion: label.version,
            name,
            color,
            adopt,
          })
        : createShared.mutateAsync({ workspaceId, name, color, adopt });
    const id = projectId ?? "";
    return label
      ? update.mutateAsync({
          projectId: id,
          labelId: label.id,
          expectedVersion: label.version,
          name,
          color,
        })
      : create.mutateAsync({ projectId: id, name, color });
  }
  async function destroy(label: CatalogLabel) {
    if (workspaceId)
      await removeShared.mutateAsync({
        workspaceId,
        labelId: label.id,
        expectedVersion: label.version,
      });
    else
      await remove.mutateAsync({
        projectId: projectId ?? "",
        labelId: label.id,
        expectedVersion: label.version,
      });
    toast.success("Label deleted");
  }
  const where = workspaceId ? " in every project" : "";
  return (
    <section>
      <SectionHeading
        title="Labels"
        action={
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            {!!rows.length && (
              <SearchField label="Search labels" value={query} onChange={setQuery} />
            )}
            {canAdmin && (
              <IconButton label="New label" variant="default" onClick={() => edit(null)}>
                <Plus />
              </IconButton>
            )}
          </div>
        }
      />
      <ErrorNotice error={labels.error} />
      {labels.isPending ? (
        <Loading />
      ) : matches.length ? (
        matches.map((label) => {
          const tickets = `${label.count} ${label.count === 1 ? "ticket" : "tickets"}`;
          // A project shows its workspace's labels read-only; their owner is the workspace.
          const editable = canAdmin && (!!workspaceId || label.scope === "project");
          return (
            <SettingRow
              key={label.id}
              compact
              title={
                <span className="flex min-w-0 items-baseline gap-2">
                  <TicketTag
                    tag={label.name}
                    color={label.color}
                    className="h-auto max-w-full border-0 bg-transparent px-0 text-[13px] font-normal"
                  />
                  {projectId && label.scope === "workspace" && (
                    <span className="shrink-0 text-xs text-muted-foreground">Workspace</span>
                  )}
                </span>
              }
            >
              {projectId ? (
                <Link
                  to="/projects/$projectId"
                  params={{ projectId }}
                  search={{ label: label.name }}
                  className="text-xs whitespace-nowrap text-muted-foreground tabular-nums hover:text-foreground"
                >
                  {tickets}
                </Link>
              ) : (
                <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                  {tickets}
                </span>
              )}
              {editable && (
                <>
                  <IconButton label={`Edit label ${label.name}`} onClick={() => edit(label)}>
                    <Pencil />
                  </IconButton>
                  <Confirm
                    label={`Delete label ${label.name}`}
                    icon={<Trash2 />}
                    danger
                    description={
                      label.count
                        ? `Remove ${label.name} from ${tickets}${where}, including archived tickets? Saved views using this label will have their label filter removed.`
                        : `Delete the unused label ${label.name}? Saved views using it will have their label filter removed.`
                    }
                    onConfirm={() => destroy(label)}
                  />
                </>
              )}
            </SettingRow>
          );
        })
      ) : (
        !labels.error && <EmptyState title={query ? "No matching labels" : "No labels yet"} />
      )}
      <Modal
        title={draft?.label ? "Edit label" : "New label"}
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
              void save(draft.label, draft.name, draft.color, draft.adopt)
                .then(() => {
                  setDraft(null);
                  toast.success("Label saved");
                })
                .catch(() => {});
            }}
          >
            <Input
              label="Label name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value, adopt: false })}
              maxLength={40}
              required
              autoFocus
            />
            <AccentColorPicker
              label="Label color"
              value={draft.color}
              onChange={(color) => setDraft({ ...draft, color })}
              disabled={busy}
              custom
            />
            {!!draft.name.trim() && (
              <div className="mb-4">
                <TicketTag tag={draft.name.trim()} color={draft.color} />
              </div>
            )}
            {draft.label && draft.name.trim() !== draft.label.name && (
              <p className="text-xs text-muted-foreground">
                Renaming updates this label on tickets and in saved views{where}.
              </p>
            )}
            {!!conflicts.length && (
              <Check
                label="Adopt the project labels"
                description={`Defined in ${conflicts.join(", ")}. Their tickets keep the label and take this color.`}
                checked={draft.adopt}
                onCheckedChange={(adopt) => setDraft({ ...draft, adopt })}
              />
            )}
            <FormActions
              error={error}
              pending={busy}
              submitLabel="Save label"
              submitDisabled={!draft.name.trim()}
              onCancel={() => setDraft(null)}
            />
          </form>
        )}
      </Modal>
    </section>
  );
}
