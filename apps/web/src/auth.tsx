import { useAuthError } from "./hooks/use-auth-error.ts";
import { formText } from "./forms.ts";
import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { authResult, okSchema, roleLabels } from "@kanvil/contracts";
import { brandMark } from "@kanvil/contracts/theme";
import { z } from "zod";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { api, auth, signOut, useIdentity, useInfo, useOperation } from "./data.tsx";
import { rememberWorkspace } from "./components/workspace-provider.tsx";
import { Brand, Button, ErrorNotice, Input, Loading, RelativeTime } from "./ui.tsx";
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

// A sign-in that continues an OAuth authorization returns where to go next.
function continueSignIn(data: unknown) {
  if (data && typeof data === "object" && "url" in data && typeof data.url === "string")
    window.location.assign(data.url);
  else if (window.location.pathname === "/login") window.location.assign("/");
}
export function Login() {
  const [error, setError] = useAuthError();
  // An emailed link opens this screen with its address and code filled in.
  const [link] = useState(() => new URLSearchParams(window.location.search));
  const info = useInfo(),
    [pending, setPending] = useState(false),
    [emailOpen, setEmailOpen] = useState(false),
    [email, setEmail] = useState(() => link.get("email") ?? ""),
    [flow, setFlow] = useState<"code" | "reset" | null>(() =>
      link.get("code") ? (link.get("reset") ? "reset" : "code") : null,
    ),
    [sent, setSent] = useState(() => !!link.get("code")),
    [leaving, setLeaving] = useState<string>();
  async function attempt(action: () => Promise<void>) {
    setPending(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget),
      password = formText(values, "password");
    void attempt(async () => {
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
      continueSignIn(authResult(await auth.signIn.email({ email, password })).data);
    });
  }
  async function sendCode() {
    authResult(
      flow === "reset"
        ? await auth.emailOtp.requestPasswordReset({ email })
        : await auth.emailOtp.sendVerificationOtp({ email, type: "sign-in" }),
    );
    setSent(true);
  }
  function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget),
      otp = formText(values, "code");
    void attempt(async () => {
      if (!sent) return sendCode();
      if (flow === "code")
        return continueSignIn(authResult(await auth.signIn.emailOtp({ email, otp })).data);
      authResult(
        await auth.emailOtp.resetPassword({ email, otp, password: formText(values, "password") }),
      );
      // Keep the page the person started on, such as an invitation, minus the emailed code.
      const page = new URL(window.location.href);
      for (const key of ["email", "code", "reset"]) page.searchParams.delete(key);
      window.history.replaceState(null, "", page);
      setFlow(null);
      setSent(false);
      setEmailOpen(true);
      toast.success("Password reset. Sign in with the new password.");
    });
  }
  // The browser leaves for the provider, so the buttons stay disabled unless starting fails.
  function socialSignIn(provider: string) {
    setPending(true);
    setLeaving(provider);
    setError(undefined);
    const callbackURL = new URL(window.location.href);
    callbackURL.searchParams.delete("error");
    callbackURL.searchParams.delete("error_description");
    void auth.signIn
      .social({
        provider,
        callbackURL: callbackURL.href,
        errorCallbackURL: `${window.location.origin}/login`,
      })
      .then(authResult)
      .catch((cause) => {
        setError(cause);
        setPending(false);
        setLeaving(undefined);
      });
  }
  if (info.isPending) return <Loading />;
  const setup = info.data?.setupRequired,
    providers = setup ? [] : (info.data?.providers ?? []),
    invited = window.location.pathname.startsWith("/invite/"),
    emailEnabled = info.data?.authentication.emailPasswordEnabled ?? true,
    emailCodes = !setup && !!info.data?.emailCodes,
    showEmail = setup || (emailEnabled && (!providers.length || emailOpen));
  if (flow)
    return (
      <AuthScreen
        title={flow === "reset" ? "Reset password" : "Sign in with a code"}
        subtitle={
          sent
            ? `If ${email} has an account, a code is on its way. It expires in 10 minutes.`
            : undefined
        }
        instance={info.data}
      >
        <ErrorNotice error={info.error ?? error} />
        <form onSubmit={submitCode} className="flex flex-col">
          <Input
            label="Email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={pending || sent}
            autoFocus={!sent}
          />
          {sent && (
            <Input
              label="Code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              minLength={6}
              maxLength={6}
              required
              defaultValue={link.get("code") ?? ""}
              disabled={pending}
              autoFocus
            />
          )}
          {sent && flow === "reset" && (
            <Input
              label="New password"
              name="password"
              type="password"
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              required
              disabled={pending}
            />
          )}
          <Button
            type="submit"
            variant="default"
            size="lg"
            className="mt-2 w-full"
            disabled={pending}
          >
            {pending ? <Spinner /> : null}
            {!sent ? "Email me a code" : flow === "reset" ? "Reset password" : "Sign in"}
          </Button>
        </form>
        <div className="mt-4 flex items-center justify-between gap-3">
          <Button
            variant="link"
            size="sm"
            className="px-0"
            disabled={pending}
            onClick={() => {
              setError(undefined);
              setFlow(null);
              setSent(false);
            }}
          >
            Back to sign in
          </Button>
          {sent && (
            <Button
              variant="link"
              size="sm"
              className="px-0"
              disabled={pending}
              onClick={() =>
                void attempt(async () => {
                  await sendCode();
                  toast.success("Code sent again");
                })
              }
            >
              Resend code
            </Button>
          )}
        </div>
      </AuthScreen>
    );
  return (
    <AuthScreen
      title={setup ? "Create your owner account" : "Sign in"}
      subtitle={
        setup
          ? "The first account administers this instance."
          : invited
            ? "Sign in with the invited email address to accept the invitation."
            : undefined
      }
      instance={info.data}
    >
      <ErrorNotice error={info.error ?? error} />
      {providers.length > 0 && (
        <div className="flex flex-col gap-3">
          {providers.map((provider, index) => (
            <Button
              key={provider.id}
              variant={index === 0 ? "default" : "outline"}
              size="lg"
              className="w-full"
              disabled={pending}
              onClick={() => socialSignIn(provider.id)}
            >
              {leaving === provider.id ? <Spinner /> : null}
              Sign in with {provider.name}
            </Button>
          ))}
          {emailEnabled && !showEmail && (
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
        <form onSubmit={submit} className="flex flex-col">
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
            value={email}
            onChange={(event) => setEmail(event.target.value)}
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
            variant={providers.length && !setup ? "outline" : "default"}
            disabled={pending}
          >
            {pending ? <Spinner /> : null}
            {pending ? "Signing in…" : setup ? "Create account" : "Sign in"}
          </Button>
          {emailCodes && (
            <div className="mt-4 flex items-center justify-between gap-3">
              <Button
                variant="link"
                size="sm"
                className="px-0"
                disabled={pending}
                onClick={() => {
                  setError(undefined);
                  setFlow("code");
                }}
              >
                Email me a sign-in code
              </Button>
              <Button
                variant="link"
                size="sm"
                className="px-0"
                disabled={pending}
                onClick={() => {
                  setError(undefined);
                  setFlow("reset");
                }}
              >
                Forgot password?
              </Button>
            </div>
          )}
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
  const info = useInfo();
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
const unavailable = {
  expired: "This invitation has expired.",
  revoked: "This invitation was revoked.",
  accepted: "This invitation was already accepted.",
};
// The page behind an invitation link. Accepting needs the invited address; the server checks it
// again together with the sender's current authority.
export function AcceptInvitation({ token }: { token: string }) {
  const identity = useIdentity(),
    navigate = useNavigate(),
    info = useInfo(),
    invitation = useQuery({ ...api.query("get_invitation", { token }), retry: false }),
    accept = useOperation("accept_invitation"),
    [error, setError] = useState<unknown>();
  const data = invitation.data;
  if (invitation.isPending) return <Loading />;
  return (
    <AuthScreen
      title={
        !data
          ? "Invitation unavailable"
          : data.status === "pending"
            ? `Join ${data.workspace.name}`
            : data.workspace.name
      }
      instance={info.data}
    >
      <ErrorNotice error={invitation.error ?? accept.error ?? error} />
      {data && (
        <>
          <dl className="mb-6 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 border-y py-4 text-sm">
            <dt className="text-muted-foreground">Invited</dt>
            <dd className="m-0 wrap-anywhere">{data.email}</dd>
            {data.invitedBy && (
              <>
                <dt className="text-muted-foreground">From</dt>
                <dd className="m-0">{data.invitedBy}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Access</dt>
            <dd className="m-0">
              {roleLabels[data.role]} ·{" "}
              {data.projects
                ? data.projects.map((project) => project.name).join(", ") || "Removed projects"
                : "Whole workspace"}
            </dd>
            {data.status === "pending" && (
              <>
                <dt className="text-muted-foreground">Expires</dt>
                <dd className="m-0">
                  <RelativeTime value={data.expiresAt} />
                </dd>
              </>
            )}
          </dl>
          {data.status !== "pending" ? (
            <>
              <p className="mb-6 text-sm">
                {unavailable[data.status]} Ask a workspace administrator for a new invitation.
              </p>
              <Button render={<a href="/" />}>Open Kanvil</Button>
            </>
          ) : !data.matchesAccount ? (
            <>
              <p className="mb-6 text-sm">
                You are signed in as <span className="font-medium">{identity.email}</span>. Sign in
                as {data.email} to accept.
              </p>
              <Button
                onClick={() => {
                  setError(undefined);
                  void signOut(identity, window.location.pathname).catch(setError);
                }}
              >
                Sign out
              </Button>
            </>
          ) : (
            <Button
              variant="default"
              size="lg"
              className="w-full"
              disabled={accept.isPending}
              onClick={() => {
                void accept
                  .mutateAsync({ token })
                  .then((result) => {
                    rememberWorkspace(identity.id, result.workspaceId);
                    toast.success(`Joined ${data.workspace.name}`);
                    return navigate(
                      result.projectIds?.length === 1
                        ? {
                            to: "/projects/$projectId",
                            params: { projectId: result.projectIds[0] },
                          }
                        : { to: "/" },
                    );
                  })
                  .catch(() => {});
              }}
            >
              {accept.isPending ? <Spinner /> : null}
              Accept invitation
            </Button>
          )}
        </>
      )}
      {!data && <Button render={<a href="/" />}>Open Kanvil</Button>}
    </AuthScreen>
  );
}
