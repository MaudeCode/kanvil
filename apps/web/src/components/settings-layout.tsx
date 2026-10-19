import {
  Button,
  ErrorNotice,
  IconButton,
  Input,
  PageHeader,
  Select,
  SelectGroup,
  SelectItem,
  SelectLabel,
  Textarea,
} from "../ui.tsx";
import { Item, ItemContent, ItemTitle, ItemDescription, ItemActions } from "@/components/ui/item";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useIsMobile } from "../hooks/use-mobile.ts";
import { submitOnModEnter } from "../forms.ts";
import { createContext, use, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIdentity, useProjects, useWorkspace } from "../data.tsx";
import {
  expanded,
  settingsEntries,
  settingsGroups,
  settingsHref,
  settingsLocation,
  type SettingsEntry,
} from "../lib/settings-nav.ts";
import { ProjectIcon } from "./project-icon.tsx";
export function useSettingsGroups() {
  const identity = useIdentity(),
    workspace = useWorkspace(),
    projects = useProjects();
  return settingsGroups({
    workspace: workspace.active?.role ? workspace.active : undefined,
    projects: projects.data ?? [],
    admin: identity.admin,
  });
}
const Section = createContext("");
// Opening another scope (or admin section) remounts the page, so the chosen entry takes focus back
// once the page that owns it renders; the outgoing page can still render once with the new URL.
let refocus: string | undefined;
export function SettingsLayout({
  title,
  section,
  children,
}: {
  title: string;
  section: string;
  children: ReactNode;
}) {
  const mobile = useIsMobile(1024),
    groups = useSettingsGroups(),
    navigate = useNavigate(),
    pathname = useRouterState({ select: (state) => state.location.pathname }),
    nav = useRef<HTMLElement>(null),
    id = useId();
  const current = (entry: SettingsEntry<unknown>) =>
    entry.to === pathname && entry.section === section && !entry.children;
  const here = settingsLocation(groups, pathname, section);
  useEffect(() => {
    if (!refocus || here?.group.title !== title || settingsHref(here.entry) !== refocus) return;
    refocus = undefined;
    nav.current?.querySelector<HTMLElement>('[aria-current="page"], [role="combobox"]')?.focus();
  });
  const link = (entry: SettingsEntry<unknown>) => (
    <Link
      to={entry.to}
      search={{ section: entry.section }}
      aria-current={current(entry) ? "page" : undefined}
      onClick={() => {
        refocus = current(entry) ? undefined : settingsHref(entry);
      }}
    />
  );
  return (
    <>
      <PageHeader title={title} />
      <div className="grid min-w-0 grid-cols-1 items-start gap-5 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-9">
        <nav ref={nav} aria-label="Settings" className="min-w-0 lg:sticky lg:top-14">
          {mobile ? (
            <Select
              label="Settings section"
              labelHidden
              className="mb-0"
              value={`${pathname}?section=${section}`}
              onValueChange={(next) => {
                const entry = settingsEntries(groups).find((item) => settingsHref(item) === next);
                if (!entry) return;
                refocus = settingsHref(entry);
                void navigate({ to: entry.to, search: { section: entry.section } });
              }}
            >
              {groups.map((group) => (
                <SelectGroup key={group.id}>
                  <SelectLabel>{group.label}</SelectLabel>
                  {group.entries.flatMap((entry) => {
                    const sections = expanded(entry, pathname);
                    return (sections.length ? sections : [entry]).map((item) => (
                      <SelectItem key={settingsHref(item)} value={settingsHref(item)}>
                        {item.project ? (
                          <ProjectIcon project={item.project} className="size-4" />
                        ) : (
                          item.icon && <item.icon className="size-4" />
                        )}
                        {sections.length ? `${entry.label} · ${item.label}` : item.label}
                      </SelectItem>
                    ));
                  })}
                </SelectGroup>
              ))}
            </Select>
          ) : (
            groups.map((group) => (
              <SidebarGroup
                key={group.id}
                role="group"
                aria-labelledby={`${id}-${group.id}`}
                className="px-0 pt-0"
              >
                <SidebarGroupLabel id={`${id}-${group.id}`}>{group.label}</SidebarGroupLabel>
                <SidebarMenu>
                  {group.entries.map((entry) => {
                    const sections = expanded(entry, pathname);
                    return (
                      <SidebarMenuItem key={settingsHref(entry)}>
                        <SidebarMenuButton isActive={current(entry)} render={link(entry)}>
                          {entry.project ? (
                            <ProjectIcon project={entry.project} className="size-4" />
                          ) : (
                            entry.icon && <entry.icon />
                          )}
                          <span>{entry.label}</span>
                        </SidebarMenuButton>
                        {sections.length > 0 && (
                          <SidebarMenuSub role="group" aria-label={entry.label}>
                            {sections.map((child) => (
                              <SidebarMenuSubItem key={settingsHref(child)}>
                                <SidebarMenuSubButton
                                  isActive={current(child)}
                                  render={link(child)}
                                >
                                  <span>{child.label}</span>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            ))}
                          </SidebarMenuSub>
                        )}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroup>
            ))
          )}
        </nav>
        <div className="settings @container min-w-0 max-w-3xl [&_form]:max-w-none [&_p]:text-sm [&_p]:text-muted-foreground [&_section]:border-t [&_section]:py-5 [&_section:first-child]:border-0 [&_section:first-child]:pt-0 [&>[data-settings-section]>section:first-child]:border-0 [&>[data-settings-section]>section:first-child]:pt-0">
          <Section value={section}>{children}</Section>
        </div>
      </div>
    </>
  );
}
// One settings section's content; only the open section renders.
export function SettingsPanel({ value, children }: { value: string; children: ReactNode }) {
  return use(Section) === value ? (
    <div data-settings-section={value} className="animate-in fade-in-0 duration-200">
      {children}
    </div>
  ) : null;
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
