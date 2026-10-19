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
  event.preventDefault();
  submitForm(event.currentTarget);
}
// Submits like the form's own submit button, unless that button is disabled.
export function submitForm(form: HTMLFormElement | null) {
  if (form && !form.querySelector('button[type="submit"]:disabled')) form.requestSubmit();
}
