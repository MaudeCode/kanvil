import { useAuthError } from "./hooks/use-auth-error.ts";
import { formText } from "./forms.ts";
import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { okSchema, roleLabels } from "@kanvil/contracts";
import { brandMark } from "@kanvil/contracts/theme";
import { t } from "@kanvil/contracts/i18n";
import { Trans } from "react-i18next";
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
          <p
            dir="auto"
            className="m-0 text-2xl leading-snug font-semibold tracking-tight text-foreground"
          >
            {name}
          </p>
          {instance?.description && (
            <p dir="auto" className="mt-2 mb-0 max-w-sm text-sm text-muted-foreground">
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
  const [error, setError] = useAuthError();
  const info = useInfo(),
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
    invited = window.location.pathname.startsWith("/invite/"),
    emailEnabled = info.data?.authentication.emailPasswordEnabled ?? true,
    showEmail = setup || (emailEnabled && (!provider || emailOpen));
  return (
    <AuthScreen
      title={setup ? t("shell.auth.createOwner") : t("shell.auth.signIn")}
      subtitle={
        setup ? t("shell.auth.ownerHint") : invited ? t("shell.auth.invitedHint") : undefined
      }
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
              const callbackURL = new URL(window.location.href);
              callbackURL.searchParams.delete("error");
              callbackURL.searchParams.delete("error_description");
              void auth.signIn
                .social({
                  provider: "oidc",
                  callbackURL: callbackURL.href,
                  errorCallbackURL: `${window.location.origin}/login`,
                })
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
            {t("shell.auth.signInWith", { provider: provider.name })}
          </Button>
          {emailEnabled && !showEmail && (
            <Button
              variant="outline"
              size="lg"
              className="w-full"
              disabled={pending}
              onClick={() => setEmailOpen(true)}
            >
              {t("shell.auth.useEmail")}
            </Button>
          )}
          {showEmail && (
            <div className="flex items-center gap-3 py-2 text-xs text-muted-foreground">
              <Separator className="flex-1" />
              {t("shell.auth.or")}
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
              <Input
                label={t("shell.auth.name")}
                name="name"
                autoComplete="name"
                required
                maxLength={120}
              />
              <Input
                label={t("shell.auth.setupToken")}
                name="token"
                type="password"
                required
                autoComplete="off"
              />
              <small className="-mt-2 mb-5 block">{t("shell.auth.setupTokenHint")}</small>
            </>
          )}
          <Input
            label={t("shell.auth.email")}
            name="email"
            type="email"
            autoComplete="username"
            required
            disabled={pending}
            autoFocus
          />
          <Input
            label={t("shell.auth.password")}
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
            {pending
              ? t("shell.auth.signingIn")
              : setup
                ? t("shell.auth.createAccount")
                : t("shell.auth.signIn")}
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
      if (!response.url) throw new Error(t("shell.auth.consent.expired"));
      window.location.assign(response.url);
    } catch (cause) {
      setError(cause);
      setPending(false);
    }
  }
  return (
    <AuthScreen
      title={
        client.data?.client_name
          ? t("shell.auth.consent.title", { client: client.data.client_name })
          : t("shell.auth.consent.titleUnnamed")
      }
      subtitle={t("shell.auth.consent.subtitle")}
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
          {t("shell.auth.consent.deny")}
        </Button>
        <Button
          variant="default"
          disabled={pending || !client.data}
          onClick={() => {
            void consent(true);
          }}
        >
          {pending ? <Spinner /> : null}
          {t("shell.auth.consent.allow")}
        </Button>
      </div>
    </AuthScreen>
  );
}
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
          ? t("shell.auth.invitation.unavailable")
          : data.status === "pending"
            ? t("shell.auth.invitation.join", { workspace: data.workspace.name })
            : data.workspace.name
      }
      instance={info.data}
    >
      <ErrorNotice error={invitation.error ?? accept.error ?? error} />
      {data && (
        <>
          <dl className="mb-6 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 border-y py-4 text-sm">
            <dt className="text-muted-foreground">{t("shell.auth.invitation.invited")}</dt>
            <dd className="m-0 wrap-anywhere">{data.email}</dd>
            {data.invitedBy && (
              <>
                <dt className="text-muted-foreground">{t("shell.auth.invitation.from")}</dt>
                <dd dir="auto" className="m-0">
                  {data.invitedBy}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">{t("shell.auth.invitation.access")}</dt>
            <dd className="m-0">
              {roleLabels[data.role]} ·{" "}
              {data.projects
                ? data.projects.map((project) => project.name).join(", ") ||
                  t("shell.auth.invitation.removedProjects")
                : t("shell.auth.invitation.wholeWorkspace")}
            </dd>
            {data.status === "pending" && (
              <>
                <dt className="text-muted-foreground">{t("shell.auth.invitation.expires")}</dt>
                <dd className="m-0">
                  <RelativeTime value={data.expiresAt} />
                </dd>
              </>
            )}
          </dl>
          {data.status !== "pending" ? (
            <>
              <p className="mb-6 text-sm">{t(`shell.auth.invitation.${data.status}`)}</p>
              <Button render={<a href="/" />}>{t("shell.openKanvil")}</Button>
            </>
          ) : !data.matchesAccount ? (
            <>
              <p className="mb-6 text-sm">
                <Trans
                  i18nKey="shell.auth.invitation.wrongAccount"
                  values={{ current: identity.email, invited: data.email }}
                  components={{ account: <span className="font-medium" /> }}
                />
              </p>
              <Button
                onClick={() => {
                  setError(undefined);
                  void signOut(identity, window.location.pathname).catch(setError);
                }}
              >
                {t("shell.auth.invitation.signOut")}
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
                    toast.success(
                      t("shell.auth.invitation.joined", { workspace: data.workspace.name }),
                    );
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
              {t("shell.auth.invitation.accept")}
            </Button>
          )}
        </>
      )}
      {!data && <Button render={<a href="/" />}>{t("shell.openKanvil")}</Button>}
    </AuthScreen>
  );
}
