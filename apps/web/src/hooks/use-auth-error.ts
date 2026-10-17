import { useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

// Callback descriptions come from the provider and may contain private details.
function callbackError(code: string | null) {
  if (code === null) return undefined;
  switch (code) {
    case "access_denied":
      return new Error("Sign-in was cancelled. Try again when you are ready.");
    case "account_already_linked_to_different_user":
    case "account_ownership_conflict":
      return new Error(
        "This identity is already linked to another Kanvil account. Use a different identity or contact your administrator.",
      );
    case "signup_disabled":
    case "account_not_linked":
      return new Error(
        "This identity is not linked to a Kanvil account. Sign in with your local account and link it in Settings.",
      );
    case "state_mismatch":
    case "state_not_found":
    case "state_expired":
      return new Error(
        "The sign-in request expired or could not be verified. Try again from this screen.",
      );
    case "email_does_not_match":
      return new Error(
        "The identity provider email could not be linked. Contact your administrator.",
      );
    default:
      return new Error("Sign-in could not be completed. Try again or contact your administrator.");
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
