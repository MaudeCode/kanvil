import { useEffect, useRef } from "react";

// Single-key shortcuts stay out of the way while the user is typing or inside an overlay.
export function isTypingContext(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
    )
  );
}

export function useShortcut(
  key: string,
  handler: (event: KeyboardEvent) => void,
  {
    enabled = true,
    mod = false,
    guard,
  }: {
    enabled?: boolean;
    mod?: boolean;
    // Skips the shortcut (and leaves the key's default) when it returns false.
    guard?: (event: KeyboardEvent) => boolean;
  } = {},
) {
  const current = useRef({ handler, guard });
  useEffect(() => {
    current.current = { handler, guard };
  });
  useEffect(() => {
    if (!enabled) return undefined;
    const listener = (event: KeyboardEvent) => {
      if (event.key !== key || event.defaultPrevented || event.repeat) return;
      if (mod ? !(event.metaKey || event.ctrlKey) : event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (!mod && isTypingContext(event.target)) return;
      if (current.current.guard && !current.current.guard(event)) return;
      event.preventDefault();
      current.current.handler(event);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [key, enabled, mod]);
}
