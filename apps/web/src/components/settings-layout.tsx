import {
  Button,
  ErrorNotice,
  IconButton,
  Input,
  PageHeader,
  Select,
  SelectItem,
  Textarea,
} from "../ui.tsx";
import { Item, ItemContent, ItemTitle, ItemDescription, ItemActions } from "@/components/ui/item";
import { useIsMobile } from "../hooks/use-mobile.ts";
import { submitOnModEnter } from "../forms.ts";
import { useState, type ReactNode } from "react";
import { Pencil, type LucideIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
export function SettingsLayout({
  title,
  value,
  onChange,
  sections,
  children,
}: {
  title: string;
  value: string;
  onChange: (value: string) => void;
  sections: readonly { id: string; label: string; icon: LucideIcon }[];
  children: ReactNode;
}) {
  const mobile = useIsMobile(1024);
  return (
    <>
      <PageHeader title={title} />
      <Tabs
        orientation={mobile ? "horizontal" : "vertical"}
        value={value}
        onValueChange={(next) => onChange(String(next))}
        className="grid min-w-0 items-start grid-cols-1 gap-5 lg:grid-cols-[160px_minmax(0,1fr)] lg:gap-9"
      >
        {mobile && (
          <Select
            label={`${title} section`}
            labelHidden
            className="mb-0"
            value={value}
            onValueChange={(next) => {
              if (next) onChange(next);
            }}
          >
            {sections.map((section) => (
              <SelectItem key={section.id} value={section.id}>
                <section.icon className="size-4" />
                {section.label}
              </SelectItem>
            ))}
          </Select>
        )}
        <TabsList
          hidden={mobile}
          variant="line"
          aria-label={`${title} sections`}
          className={
            mobile ? "hidden" : "h-fit! w-full self-start flex-col items-stretch justify-start p-0"
          }
        >
          {sections.map((section) => (
            <TabsTrigger
              key={section.id}
              value={section.id}
              className="h-8 flex-none justify-start gap-2 px-3 text-left lg:w-full"
            >
              <section.icon />
              {section.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="settings @container mx-0 max-w-5xl min-w-0 [&_form]:max-w-none [&_p]:text-sm [&_p]:text-muted-foreground [&_section]:border-t [&_section]:py-5 [&_section:first-child]:border-0 [&_section:first-child]:pt-0 [&>[data-slot=tabs-content]>section:first-child]:border-0 [&>[data-slot=tabs-content]>section:first-child]:pt-0">
          {children}
        </div>
      </Tabs>
    </>
  );
}

export function SettingRow({
  title,
  description,
  children,
  compact = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  compact?: boolean;
}) {
  return (
    <Item
      className={cn(
        "setting-row rounded-none border-x-0 border-t-0 border-b-border px-0",
        compact ? "flex-nowrap py-2" : "py-3.5 @max-[28rem]:flex-col @max-[28rem]:items-stretch",
      )}
    >
      <ItemContent className={compact ? "min-w-0 gap-0.5" : undefined}>
        <ItemTitle className={compact ? "line-clamp-none max-w-full" : undefined}>
          {title}
        </ItemTitle>
        {description && (
          <ItemDescription
            className={cn("line-clamp-none max-w-xl whitespace-normal", compact && "m-0 text-xs")}
          >
            {description}
          </ItemDescription>
        )}
      </ItemContent>
      {children && (
        <ItemActions className={compact ? "shrink-0" : "@max-[28rem]:justify-start"}>
          {children}
        </ItemActions>
      )}
    </Item>
  );
}

// A settings heading that edits itself: the pencil turns the name (and description) into fields
// with Save, Cancel, ⌘↵, and Escape. `version` detects a change made elsewhere while editing.
export function EditableHeading({
  name,
  description,
  nameLabel = "Name",
  withDescription = true,
  canEdit,
  version,
  onSave,
  pending = false,
  error,
  editLabel = "Edit",
  media,
  badges,
  children,
}: {
  name: string;
  description?: string;
  nameLabel?: string;
  withDescription?: boolean;
  canEdit: boolean;
  version?: number;
  onSave: (draft: { name: string; description: string }) => Promise<unknown>;
  pending?: boolean;
  error?: unknown;
  editLabel?: string;
  media?: ReactNode;
  badges?: ReactNode;
  children?: ReactNode;
}) {
  const [draft, setDraft] = useState<{
    name: string;
    description: string;
    version: number | undefined;
  } | null>(null);
  const stale = draft !== null && draft.version !== version;
  const close = () => setDraft(null);
  return (
    <div className="flex flex-wrap items-start gap-5">
      {media}
      {draft ? (
        <form
          className="min-w-0 flex-1 basis-60 [&_[data-slot=field-label]]:sr-only"
          onKeyDown={submitOnModEnter}
          onSubmit={(event) => {
            event.preventDefault();
            void onSave({ name: draft.name, description: draft.description })
              .then(close)
              .catch(() => {});
          }}
        >
          <Input
            label={nameLabel}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Escape") close();
            }}
            required
            maxLength={120}
            autoFocus
            className="text-base font-semibold"
          />
          {withDescription && (
            <Textarea
              label="Description"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Escape") close();
              }}
              maxLength={5000}
              rows={3}
              placeholder="Add a description"
              className="field-sizing-content"
            />
          )}
          {stale && (
            <p role="alert" className="mt-2 mb-0 text-xs">
              This changed elsewhere. Cancel and start again.
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <Button type="submit" variant="default" size="sm" disabled={pending || stale}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" disabled={pending} onClick={close}>
              Cancel
            </Button>
          </div>
          <ErrorNotice error={error} />
        </form>
      ) : (
        <div className="min-w-0 flex-1 basis-60">
          <h2 className="mb-1 flex flex-wrap items-center gap-1.5 text-base">
            {name}
            {badges}
          </h2>
          {withDescription && (
            <p className={cn("max-w-xl whitespace-pre-wrap", children ? "mb-2" : "mb-0")}>
              {description || "No description"}
            </p>
          )}
          {children}
        </div>
      )}
      {canEdit && !draft && (
        <IconButton
          label={editLabel}
          disabled={pending}
          onClick={() => setDraft({ name, description: description ?? "", version })}
        >
          <Pencil />
        </IconButton>
      )}
    </div>
  );
}
