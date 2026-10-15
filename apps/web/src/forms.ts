import type { KeyboardEvent } from "react";
export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export function submitOnModEnter(event: KeyboardEvent<HTMLFormElement>) {
  if (
    event.key !== "Enter" ||
    (!event.ctrlKey && !event.metaKey) ||
    event.nativeEvent.isComposing ||
    event.defaultPrevented
  )
    return;
  const form = event.currentTarget;
  if (form.querySelector('button[type="submit"]:disabled')) return;
  event.preventDefault();
  form.requestSubmit();
}
