import { useEffect, useRef } from "react";

// Single-key shortcuts stay out of the way while the user is typing or inside an overlay. An
// overlay matching `scope` is the shortcut's own surface, such as the ticket preview sheet.
export function isTypingContext(target: EventTarget | null, scope?: string) {
  if (!(target instanceof Element)) return false;
  if (
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="menu"], [role="listbox"]',
    )
  )
    return true;
  const overlay = target.closest('[role="dialog"], [role="alertdialog"]');
  return !!overlay && !(scope && overlay.matches(scope));
}

export function useShortcut(
  key: string,
  handler: (event: KeyboardEvent) => void,
  {
    enabled = true,
    mod = false,
    guard,
    scope,
  }: {
    enabled?: boolean;
    mod?: boolean;
    // Skips the shortcut (and leaves the key's default) when it returns false.
    guard?: (event: KeyboardEvent) => boolean;
    scope?: string | undefined;
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
      if (!mod && isTypingContext(event.target, scope)) return;
      if (current.current.guard && !current.current.guard(event)) return;
      event.preventDefault();
      current.current.handler(event);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [key, enabled, mod, scope]);
}
