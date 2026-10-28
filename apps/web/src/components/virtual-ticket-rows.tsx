import {
  Fragment,
  useLayoutEffect,
  useMemo,
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Virtualizer,
  observeElementRect,
  observeElementOffset,
  elementScroll,
  type VirtualItem,
} from "@tanstack/react-virtual";
import { TableCell, TableRow } from "./ui/table.tsx";
import { ticketWindow } from "../lib/ticket-window.ts";

const controlsOf = (row: HTMLElement) =>
  [...row.querySelectorAll<HTMLElement>("a[href], button, input")].filter(
    (control) =>
      control.tabIndex >= 0 &&
      control.getClientRects().length > 0 &&
      !control.matches(":disabled, [aria-hidden=true]"),
  );

// Extends the list's existing rows, preserving table sections and board markup.
export function VirtualTicketRows<T extends { id: string }>({
  rows,
  pins,
  board = false,
  columns = 1,
  children,
}: {
  rows: T[];
  pins: (string | null | undefined)[];
  board?: boolean;
  columns?: number;
  children: (
    row: T,
    index: number,
    props: {
      ref: (element: HTMLElement | null) => void;
      "data-index": number;
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
      onFocus: () => void;
    },
  ) => ReactNode;
}) {
  const origin = useRef<HTMLElement | null>(null);
  const [scroll, setScroll] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  const [focus, setFocus] = useState<{ index: number; backwards: boolean } | null>(null);
  const [view, setView] = useState<{ items: VirtualItem[]; size: number }>({ items: [], size: 0 });
  const indexById = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);
  const getItemKey = useCallback((index: number) => rows[index]?.id ?? index, [rows]);
  const estimateSize = useCallback(() => (board ? 120 : 60), [board]);
  // The React adapter returns mutable getters that the compiler cannot memoize. Keep the core
  // engine behind immutable React snapshots instead; no flushSync or lint exemption is needed.
  const [virtual] = useState(
    () =>
      new Virtualizer<HTMLElement, HTMLElement>({
        count: 0,
        getScrollElement: () => null,
        estimateSize: () => 60,
        scrollToFn: elementScroll,
        observeElementRect,
        observeElementOffset,
      }),
  );
  const active = pins[0];
  const revealed = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => virtual["_didMount"](), [virtual]);
  useLayoutEffect(() => {
    const element = origin.current;
    const owner = element?.closest<HTMLElement>(".table-scroll, .ticket-board") ?? null;
    if (owner !== scroll) setScroll(owner);
    const offset =
      owner && element
        ? element.getBoundingClientRect().top - owner.getBoundingClientRect().top + owner.scrollTop
        : 0;
    if (Math.abs(offset - margin) > 0.5) setMargin(offset);
    virtual.setOptions({
      count: rows.length,
      getScrollElement: () => owner,
      getItemKey,
      estimateSize,
      overscan: 3,
      scrollMargin: offset,
      scrollPaddingStart: 72,
      scrollToFn: elementScroll,
      observeElementRect,
      observeElementOffset,
      rangeExtractor: (range) => ticketWindow(range, indexById, pins, focus?.index),
      onChange: (engine) =>
        setView((previous) => {
          const items = engine.getVirtualItems(),
            size = engine.getTotalSize();
          return previous.items === items && previous.size === size ? previous : { items, size };
        }),
    });
    virtual["_willUpdate"]();
    const items = virtual.getVirtualItems(),
      size = virtual.getTotalSize();
    setView((previous) =>
      previous.items === items && previous.size === size ? previous : { items, size },
    );
  }, [rows, pins, focus, indexById, virtual, scroll, margin, getItemKey, estimateSize]);
  useLayoutEffect(() => {
    if (active === revealed.current) return;
    const index = active ? indexById.get(active) : undefined;
    if (scroll && index !== undefined) {
      revealed.current = active;
      virtual.scrollToIndex(index, { align: "auto" });
    } else if (!active) revealed.current = active;
  }, [active, indexById, virtual, scroll]);
  useLayoutEffect(() => {
    if (!focus || !scroll || !view.items.some((item) => item.index === focus.index)) return;
    const row = rows[focus.index];
    if (!row) return;
    virtual.scrollToIndex(focus.index, { align: "auto" });
    const element = scroll.querySelector<HTMLElement>(
      `.ticket-row[data-id="${CSS.escape(row.id)}"]`,
    );
    const controls = element ? controlsOf(element) : [];
    const control = focus.backwards ? controls.at(-1) : controls[0];
    if (control) {
      control.focus();
    }
  }, [focus, rows, scroll, virtual, view.items]);
  const gap = (height: number, key: string, first = false) =>
    board ? (
      <li
        key={key}
        ref={
          first
            ? (element) => {
                origin.current = element;
              }
            : undefined
        }
        aria-hidden="true"
        style={{ height, flexShrink: 0 }}
      />
    ) : (
      <TableRow
        key={key}
        ref={
          first
            ? (element) => {
                origin.current = element;
              }
            : undefined
        }
        aria-hidden="true"
        className="border-0"
        style={{ height }}
      >
        <TableCell colSpan={columns} className="h-0 border-0 p-0" />
      </TableRow>
    );
  const last = view.items.at(-1);
  const end = last ? last.end - margin : 0;
  return (
    <>
      {gap(0, "origin", true)}
      {view.items.map((item, position) => {
        const row = rows[item.index];
        if (!row) return null;
        const previous = view.items[position - 1];
        const before = item.start - (previous?.end ?? margin);
        return (
          <Fragment key={row.id}>
            {before > 0 && gap(before, `gap-${row.id}`)}
            {children(row, item.index, {
              ref: virtual.measureElement,
              "data-index": item.index,
              onFocus: () => {
                if (focus) setFocus(null);
              },
              onKeyDown: (event) => {
                if (event.key !== "Tab" || !(event.target instanceof HTMLElement)) return;
                const controls = controlsOf(event.currentTarget);
                const edge = event.shiftKey ? controls[0] : controls.at(-1);
                const index = item.index + (event.shiftKey ? -1 : 1);
                if (event.target !== edge || index < 0 || index >= rows.length) return;
                event.preventDefault();
                setFocus({ index, backwards: event.shiftKey });
              },
            })}
          </Fragment>
        );
      })}
      {gap(Math.max(0, view.size - end), "end")}
    </>
  );
}
