import {
  createContext,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { Maximize2, X } from "lucide-react";
import { t } from "@kanvil/contracts/i18n";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button, EmptyState, IconButton, Loading } from "../ui.tsx";
import { previewSearchSchema } from "../search.ts";

// A ticket a reference names, with an optional anchor such as a comment.
export interface PreviewTarget {
  ticketId: string;
  projectId?: string | undefined;
  hash?: string | undefined;
}
// A page's ordered tickets, such as a list or the Inbox. A preview of one of them steps through
// the rest with J and K and returns focus to its row.
export interface PreviewCollection {
  order: string[];
  open: (ticketId: string) => void;
  returnFocus: () => HTMLElement | null;
}
// What the detail inside the sheet can do: step through the collection it came from, follow a
// moved ticket, and close.
export interface TicketPreview {
  order: string[];
  open: (ticketId: string) => void;
  follow: (target: PreviewTarget) => void;
  close: () => void;
}
interface Controller {
  shared: boolean;
  open: (target: PreviewTarget, origin?: HTMLElement | null) => void;
  register: (collection: PreviewCollection) => () => void;
}
const PreviewContext = createContext<Controller | null>(null);
export const useTicketPreview = () => useContext(PreviewContext);

// Opens the sheet on an ordinary click of a link to a ticket; modified clicks keep the link's
// own full-page href. `shared` links preview only under the public layout's controller.
export function usePreviewClick(shared = false) {
  const controller = useTicketPreview();
  return (event: MouseEvent<HTMLElement>, target: PreviewTarget) => {
    if (
      !controller ||
      controller.shared !== shared ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    controller.open(target, event.currentTarget);
  };
}

// Registers the page's collection while it is mounted, so previews of its tickets keep its order.
export function usePreviewCollection(
  order: string[],
  open: (ticketId: string) => void,
  returnFocus: () => HTMLElement | null,
) {
  const register = useTicketPreview()?.register;
  const handlers = useRef({ open, returnFocus });
  useEffect(() => {
    handlers.current = { open, returnFocus };
  });
  const key = order.join("\n");
  useEffect(
    () =>
      register?.({
        order: key ? key.split("\n") : [],
        open: (id) => handlers.current.open(id),
        returnFocus: () => handlers.current.returnFocus(),
      }),
    [register, key],
  );
}

// The sheet's header actions: the ticket's canonical full page, and Close.
export function PreviewActions({
  projectId,
  ticketId,
  shared = false,
  preview,
}: {
  projectId: string;
  ticketId: string;
  shared?: boolean;
  preview: TicketPreview;
}) {
  return (
    <>
      <IconButton
        label={t("detail.page.openFullPage")}
        render={
          <Link
            to={
              shared
                ? "/public/projects/$projectId/tickets/$ticketId"
                : "/projects/$projectId/tickets/$ticketId"
            }
            params={{ projectId, ticketId }}
          />
        }
      >
        <Maximize2 />
      </IconButton>
      <IconButton label={t("detail.page.closePreview")} shortcut="Esc" onClick={preview.close}>
        <X />
      </IconButton>
    </>
  );
}
// The one ticket sheet of a layout. The previewed ticket rides in the URL (`peek`, plus
// `peekProject` when it is not the route's project, and the anchor as the hash), so refresh,
// history, and a copied link agree, and the page below stays mounted with its own state.
export function TicketPreviewController({
  shared = false,
  content: Content,
  children,
}: {
  shared?: boolean;
  // The detail the sheet shows: the member ticket, or the public projection of a shared one.
  content: ComponentType<{ projectId: string; ticketId: string; preview: TicketPreview }>;
  children: ReactNode;
}) {
  const router = useRouter(),
    navigate = useNavigate();
  const { projectId: routeProject } = useParams({ strict: false });
  const search = previewSearchSchema.parse(
    useRouterState({ select: (state) => state.location.search }),
  );
  const target = search.peek
    ? { id: search.peek, projectId: search.peekProject ?? routeProject }
    : undefined;
  // The last ticket stays rendered while the sheet closes.
  const [shown, setShown] = useState(target);
  if (target && (target.id !== shown?.id || target.projectId !== shown.projectId)) setShown(target);
  const [collection, setCollection] = useState<PreviewCollection | null>(null);
  // The control that opened the sheet, and the history entry the opening pushed: closing steps
  // back over that entry, so Back and Escape agree.
  const [origin, setOrigin] = useState<HTMLElement | null>(null),
    pushed = useRef<number | null>(null);
  const index = () => {
    const { __TSR_index: position } = router.history.location.state;
    return position;
  };
  // A sheet already open changes its ticket in place; opening one adds a history entry.
  function open(next: PreviewTarget, from?: HTMLElement | null) {
    const replace = !!search.peek;
    if (!replace) {
      setOrigin(from ?? null);
      pushed.current = index() + 1;
    }
    void navigate({
      to: ".",
      search: (current) => ({
        ...current,
        peek: next.ticketId,
        peekProject: next.projectId === routeProject ? undefined : next.projectId,
      }),
      hash: next.hash ?? "",
      replace,
    });
  }
  function close() {
    if (pushed.current === index()) {
      pushed.current = null;
      router.history.back();
    } else
      void navigate({
        to: ".",
        search: (current) => ({ ...current, peek: undefined, peekProject: undefined }),
        hash: "",
        replace: true,
      });
  }
  // Stable, so a page registers its collection once per change of order.
  const [register] = useState(() => (next: PreviewCollection) => {
    setCollection(next);
    return () => setCollection((current) => (current === next ? null : current));
  });
  const listed = !!shown && !!collection?.order.includes(shown.id);
  const preview: TicketPreview = {
    order: listed && collection ? collection.order : [],
    open: (ticketId) => (listed && collection ? collection.open(ticketId) : undefined),
    follow: (next) => open(next),
    close,
  };
  // Focus returns to the collection's row of the ticket last shown, which J and K may have
  // changed, then to the control that opened the sheet, then to the page.
  const returnFocus = () =>
    (listed ? collection?.returnFocus() : null) ??
    (origin?.isConnected ? origin : null) ??
    document.getElementById("main");
  return (
    <PreviewContext value={{ shared, open, register }}>
      {children}
      <Sheet
        open={!!target}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <SheetContent
          aria-label={t("detail.page.preview")}
          showCloseButton={false}
          // The page stays readable beside the preview, so the backdrop only dims it.
          overlayClassName="supports-backdrop-filter:backdrop-blur-none"
          className="w-full! gap-0 outline-none sm:max-w-[960px]!"
          finalFocus={() => returnFocus() ?? true}
        >
          <div className="@container min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-3 pb-8 max-[650px]:px-4">
            {shown &&
              (shown.projectId ? (
                <Suspense fallback={<Loading />}>
                  <Content
                    key={`${shown.projectId}:${shown.id}`}
                    projectId={shown.projectId}
                    ticketId={shown.id}
                    preview={preview}
                  />
                </Suspense>
              ) : (
                <EmptyState title={t("detail.page.unavailable")}>
                  <p>{t("detail.page.noProject")}</p>
                  <Button onClick={close}>{t("detail.page.closePreview")}</Button>
                </EmptyState>
              ))}
          </div>
        </SheetContent>
      </Sheet>
    </PreviewContext>
  );
}
