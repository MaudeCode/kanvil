import { useEffect, useRef, useState, type MouseEvent } from "react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Bell, BellDot, Check, CheckCheck, ListX, X } from "lucide-react";
import { formatEvent, notificationCategoryLabels } from "@kanvil/contracts";
import { notificationCategoryIcons } from "./lib/notification-categories.ts";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { api, useProjects } from "./data.tsx";
import {
  EmptyState,
  ErrorNotice,
  IconButton,
  Loading,
  PageHeader,
  RelativeTime,
  reportError,
} from "./ui.tsx";
import { TicketPreviewSheet } from "./ticket-detail.tsx";
import { useShortcut } from "./hooks/use-shortcut.ts";
import { actions } from "./lib/actions.ts";
import { inboxSearchSchema, type InboxSearch } from "./search.ts";
import { cn } from "@/lib/utils";

type Entry = Awaited<ReturnType<ReturnType<typeof api.notifications>["queryFn"]>>[number];
// A deletion notice has no ticket left to open.
const ticketOf = (entry: Entry) =>
  entry.event.type === "ticket.deleted" ? null : entry.event.ticketId;
const interactive = "a, button, input, [role=tab], [role=menu]";
const openButton = (id: string | null | undefined) =>
  id ? document.querySelector<HTMLElement>(`[data-entry="${CSS.escape(id)}"] [data-open]`) : null;
// Focuses an entry's open button, or the selected tab when the entry is gone.
const focusRow = (id: string | null | undefined) =>
  (
    openButton(id) ??
    document.querySelector<HTMLElement>('.inbox-tabs [role="tab"][aria-selected="true"]')
  )?.focus();

export function Inbox({
  search,
  onSearch,
}: {
  search: InboxSearch;
  onSearch: (next: InboxSearch, push: boolean) => void;
}) {
  const cache = useQueryClient(),
    router = useRouter(),
    projects = useProjects(),
    notifications = api.notifications(),
    items = useQuery(notifications),
    [pending, setPending] = useState(false);
  // Entries read while Unread is open stay until the tab changes, so the highlight and the
  // preview's order hold still.
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const entries =
    items.data?.filter((item) =>
      projects.data?.some((project) => project.id === item.event.projectId),
    ) ?? [];
  const unread = entries.filter((entry) => !entry.readAt),
    read = entries.filter((entry) => entry.readAt),
    visible = {
      unread: entries.filter((entry) => !entry.readAt || kept.has(entry.id)),
      mentions: entries.filter((entry) => entry.category === "mention"),
      all: entries,
    }[search.view];
  const order = [...new Set(visible.flatMap((entry) => ticketOf(entry) ?? []))];
  const [active, setActive] = useState<string | null>(null);
  const highlighted = visible.find((entry) => entry.id === active);

  async function write(change: () => Promise<unknown>) {
    setPending(true);
    try {
      await change();
      await cache.invalidateQueries({ queryKey: notifications.queryKey });
      return true;
    } catch (cause) {
      reportError(cause);
      return false;
    } finally {
      setPending(false);
    }
  }
  function mark(ids: string[], isRead: boolean, keep = true) {
    if (!ids.length) return Promise.resolve(true);
    if (isRead && keep) setKept((current) => new Set([...current, ...ids]));
    return write(() => api.markNotifications({ ids, read: isRead }));
  }
  function dismiss(entry: Entry) {
    const index = visible.indexOf(entry),
      next = visible[index + 1] ?? visible[index - 1];
    void write(() => api.dismissNotifications({ ids: [entry.id] })).then((done) => {
      if (!done) return;
      setActive(next?.id ?? null);
      // The dismissed row is gone, so focus settles on its neighbor, or the tabs when none is left.
      requestAnimationFrame(() => focusRow(next?.id));
    });
  }

  // The preview: the sheet keeps the last ticket while it closes, and closing a preview this
  // page opened steps back over its history entry, so Back and Escape agree.
  const target = search.peek ? { id: search.peek, projectId: search.peekProject } : undefined;
  const [preview, setPreview] = useState(target);
  if (target && (target.id !== preview?.id || target.projectId !== preview.projectId))
    setPreview(target);
  const pushed = useRef(false);
  function show(ticketId: string, push: boolean) {
    const first = visible.find((entry) => ticketOf(entry) === ticketId);
    if (!first) return null;
    if (push) pushed.current = true;
    void mark(
      entries
        .filter((entry) => !entry.readAt && ticketOf(entry) === ticketId)
        .map((entry) => entry.id),
      true,
    );
    onSearch({ ...search, peek: ticketId, peekProject: first.event.projectId }, push);
    return first;
  }
  function open(entry: Entry) {
    const ticketId = ticketOf(entry);
    setActive(entry.id);
    if (ticketId) show(ticketId, true);
  }
  function close() {
    if (pushed.current) {
      pushed.current = false;
      router.history.back();
    } else onSearch({ ...search, peek: undefined, peekProject: undefined }, false);
  }

  useEffect(() => {
    if (active)
      document
        .querySelector(`[data-entry="${CSS.escape(active)}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const move = (delta: number) => {
    if (!visible.length) return;
    const index = highlighted ? visible.indexOf(highlighted) : -1,
      next =
        index < 0
          ? delta > 0
            ? 0
            : visible.length - 1
          : Math.min(visible.length - 1, Math.max(0, index + delta));
    setActive(visible[next]?.id ?? null);
  };
  const rowKeys = { enabled: !search.peek };
  // A focused control keeps Enter, Space, and the arrows for itself.
  const navKeys = {
    ...rowKeys,
    guard: (event: KeyboardEvent) =>
      !(event.target instanceof Element && event.target.closest(interactive)),
  };
  useShortcut("j", () => move(1), rowKeys);
  useShortcut("ArrowDown", () => move(1), navKeys);
  useShortcut("k", () => move(-1), rowKeys);
  useShortcut("ArrowUp", () => move(-1), navKeys);
  const openHighlighted = () => {
    if (highlighted) open(highlighted);
  };
  useShortcut("Enter", openHighlighted, navKeys);
  useShortcut(" ", openHighlighted, navKeys);
  useShortcut(
    "u",
    () => {
      if (highlighted) void mark([highlighted.id], !highlighted.readAt);
    },
    rowKeys,
  );
  const dismissHighlighted = () => {
    if (highlighted) dismiss(highlighted);
  };
  useShortcut("Backspace", dismissHighlighted, rowKeys);
  useShortcut("Delete", dismissHighlighted, rowKeys);

  return (
    <>
      <PageHeader title="Inbox">
        <div className="flex items-center gap-1">
          <IconButton
            label="Mark all read"
            disabled={pending || !unread.length}
            onClick={() => {
              void mark(
                unread.map((entry) => entry.id),
                true,
                false,
              );
            }}
          >
            <CheckCheck />
          </IconButton>
          <IconButton
            label="Clear read"
            disabled={pending || !read.length}
            onClick={() => {
              void write(() =>
                api.dismissNotifications({ ids: read.map((entry) => entry.id) }),
              ).then((done) => {
                // Unread hides read entries, so say what went.
                if (done)
                  toast.success(
                    `Cleared ${read.length} read ${read.length === 1 ? "notification" : "notifications"}`,
                  );
              });
            }}
          >
            <ListX />
          </IconButton>
        </div>
      </PageHeader>
      <Tabs
        value={search.view}
        onValueChange={(value) => {
          setKept(new Set());
          onSearch({ ...search, view: inboxSearchSchema.shape.view.parse(value) }, false);
        }}
        className="inbox-tabs mb-5"
      >
        <TabsList variant="line">
          <TabsTrigger value="unread">
            Unread
            {unread.length > 0 && (
              <Badge variant="secondary" className="ml-1">
                {unread.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="mentions">Mentions</TabsTrigger>
          <TabsTrigger value="all">All notifications</TabsTrigger>
        </TabsList>
      </Tabs>
      <ErrorNotice error={items.error} />
      {items.isPending ? (
        <Loading />
      ) : (
        <ItemGroup className="gap-0 border-t">
          {visible.map((entry) => (
            <InboxEntry
              key={entry.id}
              entry={entry}
              active={entry.id === active}
              projectName={
                projects.data?.find((project) => project.id === entry.event.projectId)?.name
              }
              onOpen={() => open(entry)}
              onMark={() => void mark([entry.id], !entry.readAt)}
              onDismiss={() => dismiss(entry)}
            />
          ))}
        </ItemGroup>
      )}
      {!items.isPending && !visible.length && (
        <EmptyState
          title={
            {
              unread: "No unread notifications",
              mentions: "No mentions",
              all: "No notifications",
            }[search.view]
          }
          icon={Bell}
        />
      )}
      <TicketPreviewSheet
        open={!!search.peek}
        ticket={preview}
        order={order}
        onOpen={(id) => {
          const first = show(id, false);
          if (first) setActive(first.id);
        }}
        onClose={close}
        returnFocus={() => openButton(active)}
      />
    </>
  );
}

function InboxEntry({
  entry,
  active,
  projectName,
  onOpen,
  onMark,
  onDismiss,
}: {
  entry: Entry;
  active: boolean;
  projectName: string | undefined;
  onOpen: () => void;
  onMark: () => void;
  onDismiss: () => void;
}) {
  const { event } = entry,
    title = typeof event.data.title === "string" ? event.data.title : formatEvent(event),
    key = typeof event.data.key === "string" ? event.data.key : null,
    linked = !!ticketOf(entry),
    CategoryIcon = notificationCategoryIcons[entry.category];
  const body = (
    <>
      <ItemMedia variant="icon" title={notificationCategoryLabels[entry.category]}>
        <CategoryIcon role="img" aria-label={notificationCategoryLabels[entry.category]} />
      </ItemMedia>
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="line-clamp-none max-w-full text-[13px] leading-5 wrap-anywhere">
          {title}
        </ItemTitle>
        <ItemDescription className="m-0 text-xs">
          {projectName}
          {key && ` · ${key}`} ·{" "}
          {event.type === "ticket.updated" &&
          (entry.category === "assignment" || entry.category === "status")
            ? notificationCategoryLabels[entry.category]
            : formatEvent(event)}
        </ItemDescription>
      </ItemContent>
    </>
  );
  return (
    <Item
      data-entry={entry.id}
      data-unread={!entry.readAt}
      data-active={active || undefined}
      // Whole rows open; their buttons keep their own clicks.
      onClick={(click: MouseEvent) => {
        if (linked && !(click.target instanceof Element && click.target.closest(interactive)))
          onOpen();
      }}
      className={cn(
        "flex-nowrap rounded-none border-x-0 border-t-0 border-b-border px-3 py-3 data-[active=true]:bg-muted/60 data-[active=true]:shadow-[inset_2px_0_0_var(--primary)] data-[unread=true]:bg-primary/5 data-[unread=true]:shadow-[inset_2px_0_0_var(--primary)] data-[active=true]:data-[unread=true]:bg-primary/10",
        linked && "cursor-pointer",
      )}
    >
      {linked ? (
        <button
          type="button"
          data-open
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm text-left text-foreground outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2.5">{body}</div>
      )}
      <ItemActions className="gap-1 self-start">
        <IconButton
          label={entry.readAt ? "Mark unread" : "Mark read"}
          shortcut={actions.inboxRead.keys}
          size="icon-sm"
          onClick={onMark}
        >
          {entry.readAt ? <BellDot /> : <Check />}
        </IconButton>
        <IconButton
          label="Dismiss"
          shortcut={actions.inboxDismiss.keys}
          size="icon-sm"
          onClick={onDismiss}
        >
          <X />
        </IconButton>
        <RelativeTime
          value={entry.createdAt ?? event.createdAt}
          className="ml-1 self-center text-xs whitespace-nowrap text-muted-foreground"
        />
      </ItemActions>
    </Item>
  );
}
