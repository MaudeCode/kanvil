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
import { t } from "@kanvil/contracts/i18n";

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
    toast.success(t("settings.labels.deleted"));
  }
  return (
    <section>
      <SectionHeading
        title={t("settings.labels.title")}
        action={
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            {!!rows.length && (
              <SearchField label={t("settings.labels.search")} value={query} onChange={setQuery} />
            )}
            {canAdmin && (
              <IconButton
                label={t("settings.labels.new")}
                variant="default"
                onClick={() => edit(null)}
              >
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
          const tickets = t("settings.tickets", { count: label.count });
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
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t("settings.labels.workspace")}
                    </span>
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
                  <IconButton
                    label={t("settings.labels.editNamed", { name: label.name })}
                    onClick={() => edit(label)}
                  >
                    <Pencil />
                  </IconButton>
                  <Confirm
                    label={t("settings.labels.deleteNamed", { name: label.name })}
                    icon={<Trash2 />}
                    danger
                    description={
                      label.count
                        ? t(
                            workspaceId
                              ? "settings.labels.deleteUsedShared"
                              : "settings.labels.deleteUsed",
                            {
                              name: label.name,
                              count: label.count,
                            },
                          )
                        : t("settings.labels.deleteUnused", { name: label.name })
                    }
                    onConfirm={() => destroy(label)}
                  />
                </>
              )}
            </SettingRow>
          );
        })
      ) : (
        !labels.error && (
          <EmptyState title={query ? t("settings.labels.noMatches") : t("settings.labels.empty")} />
        )
      )}
      <Modal
        title={draft?.label ? t("settings.labels.edit") : t("settings.labels.new")}
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
                  toast.success(t("settings.labels.saved"));
                })
                .catch(() => {});
            }}
          >
            <Input
              label={t("settings.labels.name")}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value, adopt: false })}
              maxLength={40}
              required
              autoFocus
            />
            <AccentColorPicker
              label={t("settings.labels.color")}
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
                {workspaceId ? t("settings.labels.renameShared") : t("settings.labels.rename")}
              </p>
            )}
            {!!conflicts.length && (
              <Check
                label={t("settings.labels.adopt")}
                description={t("settings.labels.adoptDescription", {
                  projects: conflicts.join(", "),
                })}
                checked={draft.adopt}
                onCheckedChange={(adopt) => setDraft({ ...draft, adopt })}
              />
            )}
            <FormActions
              error={error}
              pending={busy}
              submitLabel={t("settings.labels.save")}
              submitDisabled={!draft.name.trim()}
              onCancel={() => setDraft(null)}
            />
          </form>
        )}
      </Modal>
    </section>
  );
}
