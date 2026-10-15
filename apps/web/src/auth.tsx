import { formText } from "./forms.ts";
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { infoSchema, okSchema } from "@kanvil/contracts";
import { z } from "zod";
import { api, auth } from "./data.tsx";
import { Brand, Button, ErrorNotice, Input, Loading } from "./ui.tsx";

export function Login() {
  const info = useQuery({
    queryKey: ["info"],
    queryFn: () => api.request("/api/v1/info", infoSchema),
  });
  const [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const email = formText(values, "email"),
      password = formText(values, "password");
    setPending(true);
    setError(undefined);
    try {
      if (info.data?.setupRequired)
        await api.request("/api/v1/setup", okSchema, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            password,
            name: values.get("name"),
            token: values.get("token"),
          }),
        });
      const result = await auth.signIn.email({ email, password });
      if (result.error) throw new Error(result.error.message);
      // OAuth provider responses are validated server-side before this redirect.
      if (result.data && "url" in result.data && typeof result.data.url === "string")
        window.location.assign(result.data.url);
      else if (window.location.pathname === "/login") window.location.assign("/");
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  if (info.isPending) return <Loading />;
  return (
    <main className="login">
      <a href="/" className="brand">
        <Brand />
      </a>
      <h1>{info.data?.setupRequired ? "Create your owner account" : "Sign in"}</h1>
      <ErrorNotice error={info.error ?? error} />
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {info.data?.setupRequired && (
          <>
            <Input label="Name" name="name" autoComplete="name" required maxLength={120} />
            <Input label="Setup token" name="token" type="password" required autoComplete="off" />
            <small>Use KANVIL_SETUP_TOKEN from your instance configuration.</small>
          </>
        )}
        <Input label="Email" name="email" type="email" autoComplete="username" required />
        <Input
          label="Password"
          name="password"
          type="password"
          minLength={12}
          maxLength={128}
          autoComplete={info.data?.setupRequired ? "new-password" : "current-password"}
          required
        />
        <Button type="submit" className="primary" disabled={pending}>
          {pending ? "Signing in…" : info.data?.setupRequired ? "Create account" : "Sign in"}
        </Button>
      </form>
      {info.data?.oidc && !info.data.setupRequired && (
        <Button
          disabled={pending}
          onClick={() => {
            void auth.signIn
              .social({ provider: "oidc", callbackURL: window.location.href })
              .then((result) => {
                if (result.error) setError(new Error(result.error.message));
              });
          }}
        >
          Sign in with {info.data.oidc.name}
        </Button>
      )}
    </main>
  );
}
const publicClientSchema = z
  .object({ client_name: z.string().optional(), client_id: z.string().optional() })
  .passthrough();
const authorizationSchema = z.object({
  redirect: z.boolean().optional(),
  url: z.string().optional(),
});
export function Consent() {
  const params = new URLSearchParams(window.location.search),
    clientId = params.get("client_id");
  const client = useQuery({
    queryKey: ["oauth-client", clientId],
    enabled: !!clientId,
    queryFn: () =>
      api.request(
        `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId ?? "")}`,
        publicClientSchema,
      ),
  });
  const [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false);
  const requested = (params.get("scope") ?? "").split(" ").filter(Boolean);
  async function consent(accept: boolean) {
    setPending(true);
    setError(undefined);
    try {
      const result = await auth.oauth2.consent({ accept });
      if (result.error) throw new Error(result.error.message);
      const response = authorizationSchema.parse(result.data);
      if (!response.url)
        throw new Error("The authorization request has expired. Reconnect your client.");
      window.location.assign(response.url);
    } catch (cause) {
      setError(cause);
      setPending(false);
    }
  }
  return (
    <main className="login">
      <a href="/" className="brand">
        <Brand />
      </a>
      <h1>Authorize {client.data?.client_name ?? "client"}</h1>
      <ErrorNotice error={client.error ?? error} />
      <p>This client requests access as your account. Project permissions still apply.</p>
      <ul>
        {requested.map((scope) => (
          <li key={scope}>
            <code>{scope}</code>
          </li>
        ))}
      </ul>
      <div className="actions">
        <Button
          disabled={pending || !client.data}
          onClick={() => {
            void consent(false);
          }}
        >
          Deny
        </Button>
        <Button
          className="primary"
          disabled={pending || !client.data}
          onClick={() => {
            void consent(true);
          }}
        >
          Allow access
        </Button>
      </div>
    </main>
  );
}
