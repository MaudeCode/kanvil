import { formText } from "./forms.ts";
import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { infoSchema, okSchema } from "@kanvil/contracts";
import { brandMark } from "@kanvil/contracts/theme";
import { z } from "zod";
import { api, auth } from "./data.tsx";
import { Brand, Button, ErrorNotice, Input, Loading } from "./ui.tsx";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import { ShieldCheck } from "lucide-react";

// Shared frame for the sign-in, setup, and OAuth consent screens: the instance's identity on one
// side, the task on the other.
function AuthScreen({
  title,
  subtitle,
  instance,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  instance?: { name: string; description: string } | undefined;
  children: ReactNode;
}) {
  const name = instance?.name ?? "Kanvil";
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden overflow-hidden bg-sidebar text-sidebar-foreground lg:flex lg:flex-col lg:justify-between lg:p-10">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_20%_10%,color-mix(in_oklab,var(--primary)_22%,transparent),transparent_70%),radial-gradient(50%_40%_at_90%_90%,color-mix(in_oklab,var(--primary)_14%,transparent),transparent_70%)]"
        />
        <span aria-hidden="true" />
        <div className="relative">
          <svg
            className="mb-8 h-20 w-28 text-primary/80 animate-in fade-in-0 slide-in-from-bottom-2 duration-500"
            viewBox={brandMark.viewBox}
            aria-hidden="true"
          >
            <path d={brandMark.path} fill="currentColor" />
          </svg>
          <p className="m-0 text-2xl leading-snug font-semibold tracking-tight text-foreground">
            {name}
          </p>
          {instance?.description && (
            <p className="mt-2 mb-0 max-w-sm text-sm text-muted-foreground">
              {instance.description}
            </p>
          )}
        </div>
        <span aria-hidden="true" />
      </aside>
      <main className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
          <a href="/" className="mb-10 inline-flex items-center gap-2 text-foreground lg:hidden">
            <Brand />
          </a>
          <h1 className="text-2xl">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>}
          <div className="mt-8">{children}</div>
        </div>
      </main>
    </div>
  );
}

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
    <AuthScreen
      title={setup ? "Create your owner account" : "Sign in"}
      subtitle={setup ? "The first account administers this instance." : undefined}
      instance={info.data}
    >
      <ErrorNotice error={info.error ?? error} />
      {provider && !setup && (
        <div className="flex flex-col gap-3">
          <Button
            variant="default"
            size="lg"
            className="w-full"
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
            {pending ? <Spinner /> : null}
            Sign in with {provider.name}
          </Button>
          {!showEmail && (
            <Button
              variant="outline"
              size="lg"
              className="w-full"
              disabled={pending}
              onClick={() => setEmailOpen(true)}
            >
              Use email and password
            </Button>
          )}
          {showEmail && (
            <div className="flex items-center gap-3 py-2 text-xs text-muted-foreground">
              <Separator className="flex-1" />
              or
              <Separator className="flex-1" />
            </div>
          )}
        </div>
      )}
      {showEmail && (
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
          className="flex flex-col"
        >
          {setup && (
            <>
              <Input label="Name" name="name" autoComplete="name" required maxLength={120} />
              <Input label="Setup token" name="token" type="password" required autoComplete="off" />
              <small className="-mt-2 mb-5 block">
                Use KANVIL_SETUP_TOKEN from your instance configuration.
              </small>
            </>
          )}
          <Input
            label="Email"
            name="email"
            type="email"
            autoComplete="username"
            required
            disabled={pending}
            autoFocus
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
            size="lg"
            className="mt-2 w-full"
            variant={provider && !setup ? "outline" : "default"}
            disabled={pending}
          >
            {pending ? <Spinner /> : null}
            {pending ? "Signing in…" : setup ? "Create account" : "Sign in"}
          </Button>
        </form>
      )}
    </AuthScreen>
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
  const info = useQuery({
    queryKey: ["info"],
    queryFn: () => api.request("/api/v1/info", infoSchema),
  });
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
    <AuthScreen
      title={`Authorize ${client.data?.client_name ?? "client"}`}
      subtitle="This client requests access as your account. Project permissions still apply."
      instance={info.data}
    >
      <ErrorNotice error={client.error ?? error} />
      <ul className="mb-6 flex flex-col gap-1.5 border-y py-4">
        {requested.map((scope) => (
          <li key={scope} className="flex items-center gap-2 text-sm">
            <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
            <code className="font-mono text-xs">{scope}</code>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-end gap-2">
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
          {pending ? <Spinner /> : null}
          Allow access
        </Button>
      </div>
    </AuthScreen>
  );
}
