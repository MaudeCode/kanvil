import { useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { t } from "@kanvil/contracts/i18n";

// Callback descriptions come from the provider and may contain private details.
function callbackError(code: string | null) {
  if (code === null) return undefined;
  switch (code) {
    case "access_denied":
      return new Error(t("shell.auth.callback.cancelled"));
    case "account_already_linked_to_different_user":
    case "account_ownership_conflict":
      return new Error(t("shell.auth.callback.linkedElsewhere"));
    case "signup_disabled":
    case "account_not_linked":
      return new Error(t("shell.auth.callback.notLinked"));
    case "state_mismatch":
    case "state_not_found":
    case "state_expired":
      return new Error(t("shell.auth.callback.expired"));
    case "email_does_not_match":
      return new Error(t("shell.auth.callback.emailMismatch"));
    default:
      return new Error(t("shell.auth.callback.failed"));
  }
}

export function useAuthError() {
  const search = useLocation({ select: (location) => location.searchStr });
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(() =>
    callbackError(new URLSearchParams(search).get("error")),
  );
  function updateError(value: unknown) {
    setError(value);
    if (new URLSearchParams(search).has("error"))
      void navigate({
        to: ".",
        search: (previous) => ({ ...previous, error: undefined }),
        replace: true,
      });
  }
  return [error, updateError] as const;
}
