import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import {
  customFieldFilter,
  customFieldFilterTokens,
  customFieldTypeLabels,
  customFieldTypes,
  formatCustomFieldValue,
  type CustomField,
  type CustomFieldType,
  type CustomFieldValue,
  type LabelColor,
} from "@kanvil/contracts";
import { useOperation } from "../data.tsx";
import {
  Check,
  Confirm,
  EmptyState,
  ErrorNotice,
  FormActions,
  IconButton,
  Input,
  Loading,
  Modal,
  SectionHeading,
  Select,
  SelectItem,
  reportError,
} from "../ui.tsx";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SettingRow } from "./settings-layout.tsx";
import { AccentColorPicker } from "./accent-color-picker.tsx";
import { CustomFieldProperty, customFieldIcons, useCustomFields } from "./ticket-property.tsx";
import { accentColor } from "../lib/accent-colors.ts";
import { t } from "@kanvil/contracts/i18n";

type Option = { id: string; name: string; color: LabelColor };
type Draft = {
  field: CustomField | null;
  name: string;
  type: CustomFieldType;
  options: Option[];
  required: boolean;
  defaultValue: CustomFieldValue | null;
  // Where the values of each removed option go: a kept option, or null to clear them.
  reassign: Record<string, string | null>;
};
const hasOptions = (type: CustomFieldType) => type === "select" || type === "multiselect";

// The project's typed ticket fields, laid out like the label directory: one row per field with its
// usage, order, and editor actions.
export function CustomFieldSettings({
  projectId,
  canAdmin,
}: {
  projectId: string;
  canAdmin: boolean;
}) {
  const fields = useCustomFields(projectId);
  const create = useOperation("create_custom_field"),
    update = useOperation("update_custom_field"),
    move = useOperation("move_custom_field"),
    remove = useOperation("delete_custom_field");
  const [draft, setDraft] = useState<Draft | null>(null);
  const busy = create.isPending || update.isPending,
    list = fields.data ?? [];
  function edit(field: CustomField | null) {
    create.reset();
    update.reset();
    setDraft({
      field,
      name: field?.name ?? "",
      type: field?.type ?? "select",
      options: field?.options ?? [],
      required: field?.required ?? false,
      defaultValue: field?.defaultValue ?? null,
      reassign: {},
    });
  }
  function place(field: CustomField, neighbor: CustomField | undefined, side: "before" | "after") {
    if (!neighbor) return;
    void move
      .mutateAsync({
        projectId,
        fieldId: field.id,
        expectedVersion: field.version,
        [side]: neighbor.id,
      })
      .catch(reportError);
  }
  return (
    <section>
      <SectionHeading
        title={t("settings.fields.title")}
        action={
          canAdmin && (
            <IconButton
              label={t("settings.fields.new")}
              variant="default"
              onClick={() => edit(null)}
            >
              <Plus />
            </IconButton>
          )
        }
      />
      <ErrorNotice error={fields.error} />
      {fields.isPending ? (
        <Loading />
      ) : list.length ? (
        list.map((field, index) => {
          const Icon = customFieldIcons[field.type];
          return (
            <SettingRow
              key={field.id}
              compact
              title={
                <span className="inline-flex min-w-0 items-center gap-2">
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span dir="auto" className="min-w-0 break-words">
                    {field.name}
                  </span>
                </span>
              }
              description={[
                customFieldTypeLabels[field.type],
                field.required && t("settings.fields.required"),
                field.defaultValue !== null &&
                  t("settings.fields.defaultValue", {
                    value: formatCustomFieldValue(field, field.defaultValue),
                  }),
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              <Link
                to="/projects/$projectId"
                params={{ projectId }}
                search={{
                  customFieldNot: [customFieldFilter(field.id, customFieldFilterTokens.empty)],
                }}
                className="text-xs whitespace-nowrap text-muted-foreground tabular-nums hover:text-foreground"
              >
                {t("settings.tickets", { count: field.count })}
              </Link>
              {canAdmin && (
                <>
                  <IconButton
                    label={t("settings.moveUp", { name: field.name })}
                    disabled={index === 0 || move.isPending}
                    onClick={() => place(field, list[index - 1], "before")}
                  >
                    <ArrowUp />
                  </IconButton>
                  <IconButton
                    label={t("settings.moveDown", { name: field.name })}
                    disabled={index === list.length - 1 || move.isPending}
                    onClick={() => place(field, list[index + 1], "after")}
                  >
                    <ArrowDown />
                  </IconButton>
                  <IconButton
                    label={t("settings.fields.editNamed", { name: field.name })}
                    onClick={() => edit(field)}
                  >
                    <Pencil />
                  </IconButton>
                  <Confirm
                    label={t("settings.fields.deleteNamed", { name: field.name })}
                    icon={<Trash2 />}
                    danger
                    description={
                      field.count
                        ? t("settings.fields.deleteUsed", { name: field.name, count: field.count })
                        : t("settings.fields.deleteUnused", { name: field.name })
                    }
                    onConfirm={async () => {
                      await remove.mutateAsync({
                        projectId,
                        fieldId: field.id,
                        expectedVersion: field.version,
                      });
                      toast.success(t("settings.fields.deleted"));
                    }}
                  />
                </>
              )}
            </SettingRow>
          );
        })
      ) : (
        !fields.error && <EmptyState title={t("settings.fields.empty")} />
      )}
      <Modal
        title={draft?.field ? t("settings.fields.edit") : t("settings.fields.new")}
        open={!!draft}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
        busy={busy}
      >
        {draft && (
          <FieldEditor
            projectId={projectId}
            draft={draft}
            onChange={setDraft}
            busy={busy}
            error={create.error ?? update.error}
            onCancel={() => setDraft(null)}
            onSubmit={() => {
              const { field } = draft,
                options = hasOptions(draft.type) ? draft.options : [];
              const removed =
                field?.options.filter((option) => !options.some((kept) => kept.id === option.id)) ??
                [];
              const action = field
                ? update.mutateAsync({
                    projectId,
                    fieldId: field.id,
                    expectedVersion: field.version,
                    name: draft.name,
                    options,
                    required: draft.required,
                    defaultValue: draft.defaultValue,
                    ...(removed.length && {
                      reassign: Object.fromEntries(
                        removed.map((option) => [option.id, draft.reassign[option.id] ?? null]),
                      ),
                    }),
                  })
                : create.mutateAsync({
                    projectId,
                    name: draft.name,
                    type: draft.type,
                    options,
                    required: draft.required,
                    defaultValue: draft.defaultValue,
                  });
              void action
                .then(() => {
                  setDraft(null);
                  toast.success(t("settings.fields.saved"));
                })
                .catch(() => {});
            }}
          />
        )}
      </Modal>
    </section>
  );
}

function FieldEditor({
  projectId,
  draft,
  onChange,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  projectId: string;
  draft: Draft;
  onChange: (draft: Draft) => void;
  busy: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const choices = hasOptions(draft.type),
    removed = choices
      ? (draft.field?.options.filter(
          (option) => !draft.options.some((kept) => kept.id === option.id),
        ) ?? [])
      : [];
  // The default editor previews the field as it will be saved.
  const preview: CustomField = {
    id: draft.field?.id ?? "draft",
    projectId,
    name: t("settings.fields.default"),
    type: draft.type,
    options: draft.options,
    required: false,
    defaultValue: null,
    version: 1,
  };
  const setOptions = (options: Option[]) => {
    const kept = new Set(options.map((option) => option.id)),
      value = draft.defaultValue;
    // A removed option cannot stay the default.
    const defaultValue = Array.isArray(value)
      ? value.filter((id) => kept.has(id))
      : typeof value === "string" && choices && !kept.has(value)
        ? null
        : value;
    onChange({
      ...draft,
      options,
      defaultValue: Array.isArray(defaultValue) && !defaultValue.length ? null : defaultValue,
    });
  };
  const swap = (index: number, other: number) => {
    const next = [...draft.options],
      [item] = next.splice(index, 1);
    if (item) next.splice(other, 0, item);
    setOptions(next);
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Input
        label={t("settings.fields.name")}
        value={draft.name}
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
        maxLength={60}
        required
        autoFocus
      />
      <Select
        label={t("settings.fields.type")}
        value={draft.type}
        disabled={!!draft.field || busy}
        onValueChange={(value) => {
          const type = customFieldTypes.find((item) => item === value) ?? draft.type;
          onChange({
            ...draft,
            type,
            options: hasOptions(type) ? draft.options : [],
            required: type === "checkbox" ? false : draft.required,
            defaultValue: null,
          });
        }}
      >
        {customFieldTypes.map((type) => (
          <SelectItem key={type} value={type}>
            {customFieldTypeLabels[type]}
          </SelectItem>
        ))}
      </Select>
      {choices && (
        <fieldset className="mb-4">
          <legend className="mb-2 text-xs font-medium text-muted-foreground">
            {t("settings.fields.options")}
          </legend>
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
            {draft.options.map((option, index) => {
              // An unnamed option goes by its place in the list.
              const named = option.name || t("settings.fields.optionInline", { number: index + 1 });
              return (
                <li key={option.id} className="flex items-center gap-1">
                  <OptionColor
                    name={option.name || t("settings.fields.option", { number: index + 1 })}
                    value={option.color}
                    disabled={busy}
                    onChange={(color) =>
                      setOptions(
                        draft.options.map((item) =>
                          item.id === option.id ? { ...item, color } : item,
                        ),
                      )
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <Input
                      label={t("settings.fields.option", { number: index + 1 })}
                      labelHidden
                      value={option.name}
                      maxLength={60}
                      required
                      onChange={(event) =>
                        setOptions(
                          draft.options.map((item) =>
                            item.id === option.id ? { ...item, name: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </div>
                  <IconButton
                    label={t("settings.moveUp", { name: named })}
                    size="icon-sm"
                    disabled={index === 0 || busy}
                    onClick={() => swap(index, index - 1)}
                  >
                    <ArrowUp />
                  </IconButton>
                  <IconButton
                    label={t("settings.moveDown", { name: named })}
                    size="icon-sm"
                    disabled={index === draft.options.length - 1 || busy}
                    onClick={() => swap(index, index + 1)}
                  >
                    <ArrowDown />
                  </IconButton>
                  <IconButton
                    label={t("settings.fields.removeOption", { name: named })}
                    size="icon-sm"
                    disabled={busy}
                    onClick={() =>
                      setOptions(draft.options.filter((item) => item.id !== option.id))
                    }
                  >
                    <X />
                  </IconButton>
                </li>
              );
            })}
          </ol>
          <Button
            variant="ghost"
            size="sm"
            className="mt-1.5"
            disabled={busy}
            onClick={() =>
              setOptions([...draft.options, { id: crypto.randomUUID(), name: "", color: "gray" }])
            }
          >
            <Plus />
            {t("settings.fields.addOption")}
          </Button>
        </fieldset>
      )}
      {removed.map((option) => (
        <Select
          key={option.id}
          label={t("settings.fields.reassign", { name: option.name })}
          value={draft.reassign[option.id] ?? ""}
          onValueChange={(value) =>
            onChange({ ...draft, reassign: { ...draft.reassign, [option.id]: value || null } })
          }
        >
          <SelectItem value="">{t("settings.fields.clearValue")}</SelectItem>
          {draft.options
            .filter((kept) => kept.name.trim())
            .map((kept) => (
              <SelectItem key={kept.id} value={kept.id}>
                {t("settings.fields.moveTo", { name: kept.name })}
              </SelectItem>
            ))}
        </Select>
      ))}
      {draft.type !== "checkbox" && (
        <Check
          label={t("settings.fields.required")}
          description={t("settings.fields.requiredDescription")}
          checked={draft.required}
          disabled={busy}
          onCheckedChange={(required) => onChange({ ...draft, required })}
        />
      )}
      <div className="mb-4">
        <CustomFieldProperty
          variant="row"
          field={preview}
          value={draft.defaultValue}
          disabled={busy || (choices && !draft.options.some((option) => option.name.trim()))}
          onChange={(defaultValue) => onChange({ ...draft, defaultValue })}
        />
      </div>
      <FormActions
        error={error}
        pending={busy}
        submitLabel={t("settings.fields.save")}
        submitDisabled={!draft.name.trim()}
        onCancel={onCancel}
      />
    </form>
  );
}

function OptionColor({
  name,
  value,
  disabled,
  onChange,
}: {
  name: string;
  value: LabelColor;
  disabled: boolean;
  onChange: (color: LabelColor) => void;
}) {
  const tone = accentColor(value);
  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("settings.fields.optionColor", { name })}
            className={tone.className}
            style={tone.style}
          />
        }
      >
        <span className="size-3 rounded-full bg-current" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(20rem,calc(100vw-2rem))] p-3 pb-0">
        <AccentColorPicker
          label={t("settings.fields.optionColor", { name })}
          value={value}
          onChange={onChange}
          custom
        />
      </PopoverContent>
    </Popover>
  );
}
