import { useLayoutEffect, useRef, useState } from "react";

type PinnedSection = {
  status: string;
  top: number;
  left: number;
  width: number;
  height: number;
};

// A fixed copy escapes the table's horizontal overflow without moving the original rows.
export function useStickyTicketSections(ready: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState<PinnedSection | null>(null);
  useLayoutEffect(() => {
    const container = ref.current;
    if (!ready || !container) return;
    function update() {
      const top = Math.max(
        0,
        document.querySelector(".workspace-header")?.getBoundingClientRect().bottom ?? 0,
      );
      const bounds = container.getBoundingClientRect();
      let next: PinnedSection | null = null;
      for (const header of container.querySelectorAll<HTMLTableRowElement>(
        ".ticket-status-heading",
      )) {
        const heading = header.getBoundingClientRect();
        if (heading.top <= top && header.parentElement!.getBoundingClientRect().bottom > top) {
          next = {
            status: header.dataset.status!,
            top,
            left: bounds.left,
            width: bounds.width,
            height: heading.height,
          };
        }
      }
      setPinned((previous) =>
        previous?.status === next?.status &&
        previous?.top === next?.top &&
        previous?.left === next?.left &&
        previous?.width === next?.width &&
        previous?.height === next?.height
          ? previous
          : next,
      );
    }
    const resize = new ResizeObserver(update);
    resize.observe(container);
    const changes = new MutationObserver(update);
    changes.observe(container, { childList: true, subtree: true, characterData: true });
    window.addEventListener("scroll", update, { passive: true, capture: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      resize.disconnect();
      changes.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [ready]);
  return { ref, pinned: ready ? pinned : null };
}
