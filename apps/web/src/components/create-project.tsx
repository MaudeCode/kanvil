import { SidebarGroupAction } from "@/components/ui/sidebar";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Plus, Users, Lock } from "lucide-react";
import { capabilitiesOf } from "@kanvil/contracts";
import { formText } from "../forms.ts";
import { useOperation, useWorkspace } from "../data.tsx";
import { Input, Modal, Textarea, fieldClass, FormActions, IconButton } from "../ui.tsx";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { t } from "@kanvil/contracts/i18n";

// Suggests a ticket prefix from the name: initials of up to three words, or the first letters.
export function suggestKey(name: string) {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const raw = words.length > 1 ? words.map((word) => word[0]).join("") : (words[0] ?? "");
  const key = raw.replace(/^[^A-Z]+/, "").slice(0, 4);
  return key.length >= 2 ? key : raw.slice(0, 3).replace(/^[^A-Z]+/, "");
}
// The prefix field shared by project creation and prefix changes, previewing the keys it issues.
export function PrefixInput({
  value,
  onChange,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
      <Input
        label={t("settings.project.prefix")}
        value={value}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
        required
        minLength={2}
        maxLength={10}
        pattern="[A-Z][A-Z0-9]{1,9}"
        placeholder="KAN"
        className="font-mono uppercase"
        autoFocus={autoFocus}
      />
      <p className="mb-4 h-8 min-w-24 content-center font-mono text-xs text-muted-foreground tabular-nums">
        {value ? `${value}-1, ${value}-2…` : ""}
      </p>
    </div>
  );
}
// Labels wrap instead of overflowing a narrow dialog.
const wrapping = "h-auto min-h-8 min-w-0 py-1.5 whitespace-normal";
// Who can open a new project; creation and import share it.
export function ProjectAccessField({
  value,
  onChange,
}: {
  value: "workspace" | "private";
  onChange: (value: "workspace" | "private") => void;
}) {
  return (
    <Field className={fieldClass}>
      <FieldLabel>{t("settings.project.access")}</FieldLabel>
      <ToggleGroup
        aria-label={t("settings.project.access")}
        value={[value]}
        onValueChange={(next) => {
          const chosen = next[0];
          if (chosen === "workspace" || chosen === "private") onChange(chosen);
        }}
        variant="outline"
        spacing={0}
        className="w-full *:flex-1"
      >
        <ToggleGroupItem
          value="workspace"
          aria-label={t("settings.createProject.everyoneLabel")}
          className={wrapping}
        >
          <Users />
          {t("settings.project.visibility.workspace")}
        </ToggleGroupItem>
        <ToggleGroupItem
          value="private"
          aria-label={t("settings.project.visibility.private")}
          className={wrapping}
        >
          <Lock />
          {t("settings.project.visibility.private")}
        </ToggleGroupItem>
      </ToggleGroup>
      <FieldDescription>
        {value === "workspace"
          ? t("settings.project.accessWorkspace")
          : t("settings.project.accessPrivate")}
      </FieldDescription>
    </Field>
  );
}
export function CreateProject({ sidebarAction = false }: { sidebarAction?: boolean }) {
  const { active: workspace } = useWorkspace();
  const canCreate = !!workspace && capabilitiesOf(workspace).includes("ticket.write");
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [key, setKey] = useState(""),
    [customKey, setCustomKey] = useState(false),
    [visibility, setVisibility] = useState<"workspace" | "private">("workspace"),
    create = useOperation("create_project"),
    navigate = useNavigate();
  function reset() {
    setName("");
    setKey("");
    setCustomKey(false);
    setVisibility("workspace");
    create.reset();
  }
  return (
    <>
      {sidebarAction ? (
        <SidebarGroupAction
          disabled={!canCreate}
          aria-label={t("settings.createProject.title")}
          onClick={() => setOpen(true)}
        >
          <Plus />
        </SidebarGroupAction>
      ) : (
        <IconButton
          label={t("settings.createProject.title")}
          variant="default"
          disabled={!canCreate}
          onClick={() => setOpen(true)}
        >
          <Plus />
        </IconButton>
      )}
      <Modal
        title={t("settings.createProject.title")}
        description={
          workspace ? t("settings.createProject.inWorkspace", { name: workspace.name }) : undefined
        }
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        busy={create.isPending}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void create
              .mutateAsync({
                workspaceId: workspace?.id,
                visibility,
                key,
                name,
                description: formText(values, "description"),
              })
              .then(async (project) => {
                setOpen(false);
                reset();
                await navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
              })
              .catch(() => {});
          }}
        >
          <Input
            label={t("settings.createProject.name")}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (!customKey) setKey(suggestKey(event.target.value));
            }}
            required
            maxLength={120}
            autoFocus
            placeholder={t("settings.createProject.namePlaceholder")}
          />
          <PrefixInput
            value={key}
            onChange={(next) => {
              setCustomKey(true);
              setKey(next);
            }}
          />
          <Textarea
            label={t("settings.layout.description")}
            name="description"
            maxLength={5000}
            rows={3}
          />
          <ProjectAccessField value={visibility} onChange={setVisibility} />
          <FormActions
            error={create.error}
            pending={create.isPending}
            submitLabel={t("settings.createProject.create")}
            onCancel={() => setOpen(false)}
          />
        </form>
      </Modal>
    </>
  );
}
