import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { ProjectLabel } from "@kanvil/contracts";
import { api, useOperation } from "../data.tsx";
import {
  Confirm,
  EmptyState,
  ErrorNotice,
  IconButton,
  Input,
  Loading,
  Modal,
  SectionHeading,
  FormActions,
} from "../ui.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { SettingRow } from "./settings-layout.tsx";
import { TicketTag } from "./ticket-tags.tsx";
import { AccentColorPicker } from "./accent-color-picker.tsx";

// MemberDirectory edits account roles; labels reuse SettingRow with a name/color editor.
export function ProjectLabelSettings({
  projectId,
  canAdmin,
}: {
  projectId: string;
  canAdmin: boolean;
}) {
  const labels = useQuery(api.query("list_project_labels", { projectId }));
  const create = useOperation("create_project_label"),
    update = useOperation("update_project_label"),
    remove = useOperation("delete_project_label");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<{
    label: ProjectLabel | null;
    name: string;
    color: ProjectLabel["color"];
  } | null>(null);
  const busy = create.isPending || update.isPending;
  const matches =
    labels.data?.filter((label) => label.name.toLowerCase().includes(query.trim().toLowerCase())) ??
    [];
  function edit(label: ProjectLabel | null) {
    create.reset();
    update.reset();
    setDraft({ label, name: label?.name ?? "", color: label?.color ?? "gray" });
  }
  return (
    <section>
      <SectionHeading
        title="Labels"
        action={
          <div className="flex items-center gap-2">
            {!!labels.data?.length && (
              <InputGroup className="w-56">
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  aria-label="Search labels"
                  placeholder="Search labels…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </InputGroup>
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
        matches.map((label) => (
          <SettingRow
            key={label.id}
            compact
            title={
              <TicketTag
                tag={label.name}
                color={label.color}
                className="h-auto max-w-full border-0 bg-transparent px-0 text-[13px] font-normal"
              />
            }
          >
            <Link
              to="/projects/$projectId"
              params={{ projectId }}
              search={{ label: label.name }}
              className="text-xs whitespace-nowrap text-muted-foreground tabular-nums hover:text-foreground"
            >
              {label.count} {label.count === 1 ? "ticket" : "tickets"}
            </Link>
            {canAdmin && (
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
                      ? `Remove ${label.name} from ${label.count} ${label.count === 1 ? "ticket" : "tickets"}, including archived tickets? Saved views using this label will have their label filter removed.`
                      : `Delete the unused label ${label.name}? Saved views using it will have their label filter removed.`
                  }
                  onConfirm={async () => {
                    await remove.mutateAsync({
                      projectId,
                      labelId: label.id,
                      expectedVersion: label.version,
                    });
                    toast.success("Label deleted");
                  }}
                />
              </>
            )}
          </SettingRow>
        ))
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
              const action = draft.label
                ? update.mutateAsync({
                    projectId,
                    labelId: draft.label.id,
                    expectedVersion: draft.label.version,
                    name: draft.name,
                    color: draft.color,
                  })
                : create.mutateAsync({ projectId, name: draft.name, color: draft.color });
              void action
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
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
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
                Renaming updates this label on tickets and in saved views.
              </p>
            )}
            <FormActions
              error={create.error ?? update.error}
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
