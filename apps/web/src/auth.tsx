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
    }),
    [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false),
    [emailOpen, setEmailOpen] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget),
      email = formText(values, "email"),
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
  const provider = info.data?.oidc,
    setup = info.data?.setupRequired,
    showEmail = setup || !provider || emailOpen;
  return (
    <main className="login">
      <a href="/" className="brand">
        <Brand />
      </a>
      <h1>{setup ? "Create your owner account" : "Sign in"}</h1>
      {info.data?.name !== "Kanvil" && info.data?.name && (
        <p className="mt-2 text-muted-foreground">{info.data.name}</p>
      )}
      <ErrorNotice error={info.error ?? error} />
      {provider && !setup && (
        <div className="login-methods">
          <Button
            variant="default"
            disabled={pending}
            onClick={() => {
              setPending(true);
              setError(undefined);
              void auth.signIn
                .social({ provider: "oidc", callbackURL: window.location.href })
                .then((result) => {
                  if (result.error) throw new Error(result.error.message);
                })
                .catch((cause) => {
                  setError(cause);
                  setPending(false);
                });
            }}
          >
            Sign in with {provider.name}
          </Button>
          {!showEmail && (
            <Button variant="outline" disabled={pending} onClick={() => setEmailOpen(true)}>
              Use email and password
            </Button>
          )}
        </div>
      )}
      {showEmail && (
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
          className={provider && !setup ? "login-email" : ""}
        >
          {setup && (
            <>
              <Input label="Name" name="name" autoComplete="name" required maxLength={120} />
              <Input label="Setup token" name="token" type="password" required autoComplete="off" />
              <small>Use KANVIL_SETUP_TOKEN from your instance configuration.</small>
            </>
          )}
          <Input
            label="Email"
            name="email"
            type="email"
            autoComplete="username"
            required
            disabled={pending}
          />
          <Input
            label="Password"
            name="password"
            type="password"
            minLength={12}
            maxLength={128}
            autoComplete={setup ? "new-password" : "current-password"}
            required
            disabled={pending}
          />
          <Button
            type="submit"
            variant={provider && !setup ? "outline" : "default"}
            disabled={pending}
          >
            {pending ? "Signing in…" : setup ? "Create account" : "Sign in"}
          </Button>
        </form>
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
          variant="default"
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
