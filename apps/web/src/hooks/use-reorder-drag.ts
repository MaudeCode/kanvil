import { useState, type DragEvent } from "react";

// Drag to reorder rows, cards, or sidebar items: the dragged item, and a drop line above or below
// the item under the pointer. `accepts` turns an item into a drop target for the current drag.
export function useReorderDrag(onPlace: (id: string, anchor: string, below: boolean) => void) {
  const [dragging, setDragging] = useState<string | null>(null),
    [over, setOver] = useState<{ id: string; below: boolean } | null>(null);
  const end = () => {
    setDragging(null);
    setOver(null);
  };
  const item = (
    id: string,
    { draggable = true, accepts = true }: { draggable?: boolean; accepts?: boolean } = {},
  ) => ({
    draggable,
    "data-dragging": dragging === id || undefined,
    "data-drop": over?.id === id ? (over.below ? "after" : "before") : undefined,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
      setDragging(id);
    },
    onDragEnd: end,
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!dragging || dragging === id || !accepts) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const box = event.currentTarget.getBoundingClientRect(),
        below = event.clientY > box.top + box.height / 2;
      if (over?.id !== id || over.below !== below) setOver({ id, below });
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !event.currentTarget.contains(event.relatedTarget)
      )
        setOver((current) => (current?.id === id ? null : current));
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!dragging || over?.id !== id) return;
      // The item handles the drop; a surrounding lane must not.
      event.preventDefault();
      event.stopPropagation();
      onPlace(dragging, id, over.below);
      end();
    },
  });
  return { dragging, end, item };
}
