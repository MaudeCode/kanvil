import { useId, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check as CheckIcon, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { z } from "zod";
import {
  credentialInput,
  credentialProjectsSchema,
  credentialsSchema,
  createdCredentialSchema,
  okSchema,
  scopes,
  type Project,
} from "@kanvil/contracts";
import { api, date, useAllProjects, useWorkspaces } from "../data.tsx";
import {
  Button,
  Check,
  Confirm,
  EmptyState,
  ErrorNotice,
  Input,
  SearchField,
  Loading,
  Modal,
  SectionHeading,
  Select,
  SelectItem,
  FormActions,
  IconButton,
} from "../ui.tsx";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { DatePicker, credentialExpiry } from "./date-picker.tsx";
import { copyText } from "../lib/browser.ts";
import { formText } from "../forms.ts";
import { t, formatList } from "@kanvil/contracts/i18n";

// Key lifetimes in days; 90 matches the server default. No expiry is only an explicit choice.
const expiryChoices = ["7", "30", "90", "365", "custom", "never"] as const;
const permissionText = (scope: (typeof scopes)[number]) => ({
  name: t(`settings.credentials.permission.${scope}.name`),
  description: t(`settings.credentials.permission.${scope}.description`),
});
function parseJSON(value: string | null): unknown {
  try {
    return JSON.parse(value ?? "null");
  } catch {
    return null;
  }
}
function accessOf(credential: z.infer<typeof credentialsSchema>[number]) {
  return {
    permissions:
      z.object({ kanvil: z.array(z.enum(scopes)) }).safeParse(parseJSON(credential.permissions))
        .data?.kanvil ?? [],
    projectIds: (
      credentialProjectsSchema.safeParse(parseJSON(credential.metadata)).data ?? { projectIds: [] }
    ).projectIds,
  };
}
export function Credentials() {
  const cache = useQueryClient(),
    projects = useAllProjects(),
    [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [secret, setSecret] = useState<z.infer<typeof createdCredentialSchema> | null>(null),
    [now] = useState(Date.now);
  const credentials = useQuery({
    queryKey: ["kanvil", "credentials"],
    queryFn: () => api.request("/api/v1/credentials", credentialsSchema),
  });
  function close() {
    setOpen(false);
    setSecret(null);
  }
  return (
    <section>
      <SectionHeading
        title={t("settings.credentials.title")}
        description={t("settings.credentials.description")}
        action={
          <IconButton
            label={t("settings.credentials.create")}
            variant="default"
            disabled={projects.isPending}
            onClick={() => setOpen(true)}
          >
            <Plus />
          </IconButton>
        }
      />
      <ErrorNotice error={credentials.error ?? projects.error} />
      {credentials.isPending ? (
        <Loading />
      ) : credentials.data?.length ? (
        <Table aria-label={t("settings.credentials.title")} mobileLayout="rows">
          <TableHeader>
            <TableRow>
              <TableHead>{t("settings.credentials.name")}</TableHead>
              <TableHead>{t("settings.credentials.access")}</TableHead>
              <TableHead>{t("settings.credentials.projects")}</TableHead>
              <TableHead>{t("settings.credentials.expires")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("settings.credentials.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {credentials.data.map((credential) => {
              const access = accessOf(credential),
                expired = !!credential.expiresAt && new Date(credential.expiresAt).getTime() <= now;
              const projectNames = access.projectIds?.map(
                (id) =>
                  projects.data?.find((project) => project.id === id)?.name ??
                  t("settings.credentials.unavailableProject"),
              );
              return (
                <TableRow key={credential.id}>
                  <TableCell className="max-w-64 whitespace-normal">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <KeyRound className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <strong dir="auto" className="block wrap-anywhere font-medium">
                          {credential.name || t("settings.credentials.untitled")}
                        </strong>
                        <code className="text-xs text-muted-foreground">{credential.start}…</code>
                      </div>
                      {(expired || !credential.enabled) && (
                        <Badge variant="secondary">
                          {expired
                            ? t("settings.credentials.expired")
                            : t("settings.credentials.disabled")}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell
                    data-label={t("settings.credentials.access")}
                    className="max-w-72 whitespace-normal"
                  >
                    <span className="text-sm">
                      {access.permissions.length === 1 && access.permissions[0] === "read"
                        ? t("settings.credentials.preset.read")
                        : formatList(
                            access.permissions.map((scope) => permissionText(scope).name),
                          ) || t("settings.credentials.custom")}
                    </span>
                  </TableCell>
                  <TableCell
                    data-label={t("settings.credentials.projects")}
                    className="max-w-64 whitespace-normal"
                  >
                    {access.projectIds === null
                      ? t("settings.credentials.global")
                      : formatList(projectNames ?? []) || t("settings.credentials.noProjects")}
                  </TableCell>
                  <TableCell
                    data-label={t("settings.credentials.expires")}
                    className="whitespace-nowrap text-muted-foreground"
                  >
                    {credential.expiresAt
                      ? date(credential.expiresAt)
                      : t("settings.credentials.never")}
                  </TableCell>
                  <TableCell>
                    <Confirm
                      label={t("settings.credentials.revoke")}
                      icon={<Trash2 />}
                      danger
                      description={
                        credential.name === null
                          ? t("settings.credentials.revokeUnnamed")
                          : t("settings.credentials.revokeNamed", { name: credential.name })
                      }
                      onConfirm={async () => {
                        await api.request(
                          `/api/v1/credentials/${encodeURIComponent(credential.id)}`,
                          okSchema,
                          { method: "DELETE" },
                        );
                        await cache.invalidateQueries({ queryKey: ["kanvil", "credentials"] });
                      }}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <EmptyState title={t("settings.credentials.empty")} icon={KeyRound} className="py-16">
          <p className="mb-0 max-w-sm text-center text-sm text-muted-foreground">
            {t("settings.credentials.emptyDescription")}
          </p>
        </EmptyState>
      )}
      <Modal
        busy={pending}
        title={secret ? t("settings.credentials.created") : t("settings.credentials.create")}
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        {secret ? (
          <CreatedKey value={secret} onDone={close} />
        ) : (
          <CreateKey
            pending={pending}
            setPending={setPending}
            projects={projects.data ?? []}
            loading={projects.isPending}
            onCancel={close}
            onCreated={async (value) => {
              setSecret(value);
              await cache.invalidateQueries({ queryKey: ["kanvil", "credentials"] });
            }}
          />
        )}
      </Modal>
    </section>
  );
}
function CreatedKey({
  value,
  onDone,
}: {
  value: z.infer<typeof createdCredentialSchema>;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState<unknown>();
  return (
    <div>
      <p>{t("settings.credentials.copyNow")}</p>
      <Input
        label={t("settings.credentials.newKey")}
        value={value.key}
        readOnly
        className="font-mono text-xs"
        onFocus={(event) => event.target.select()}
      />
      <ErrorNotice error={error} />
      <div className="flex items-center justify-between gap-3">
        <Button
          onClick={() => {
            void copyText(value.key)
              .then(() => setCopied(true))
              .catch(setError);
          }}
        >
          {copied ? <CheckIcon /> : <Copy />}
          {copied ? t("common.state.copied") : t("settings.credentials.copy")}
        </Button>
        <Button variant="default" onClick={onDone}>
          {t("common.action.done")}
        </Button>
      </div>
    </div>
  );
}
function Permission({
  scope,
  checked,
  onChange,
}: {
  scope: (typeof scopes)[number];
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId(),
    text = permissionText(scope);
  return (
    <Field
      orientation="horizontal"
      className="border-b py-3 last:border-0 [&_[data-slot=field-description]]:m-0 [&_[data-slot=field-description]]:text-xs"
    >
      <Checkbox id={id} checked={checked} onCheckedChange={onChange} />
      <FieldContent>
        <FieldLabel htmlFor={id}>{text.name}</FieldLabel>
        <FieldDescription>{text.description}</FieldDescription>
      </FieldContent>
    </Field>
  );
}
function CreateKey({
  projects,
  loading,
  onCreated,
  onCancel,
  pending,
  setPending,
}: {
  pending: boolean;
  setPending: (pending: boolean) => void;
  projects: Project[];
  loading: boolean;
  onCreated: (value: z.infer<typeof createdCredentialSchema>) => Promise<void>;
  onCancel: () => void;
}) {
  const spaces = useWorkspaces();
  const workspaceNames = new Map(spaces.data?.map((space) => [space.id, space.name]));
  const [{ tomorrow, lastDay }] = useState(() => {
    const first = new Date();
    first.setHours(0, 0, 0, 0);
    first.setDate(first.getDate() + 1);
    const last = new Date();
    last.setDate(last.getDate() + 365);
    return { tomorrow: first, lastDay: last };
  });
  const [projectIds, setProjectIds] = useState<string[]>(
      projects.length === 1 && projects[0] ? [projects[0].id] : [],
    ),
    [global, setGlobal] = useState(false),
    [permissions, setPermissions] = useState<(typeof scopes)[number][]>(["read"]),
    [expiresAt, setExpiresAt] = useState(() => {
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + 90);
      return expiry;
    }),
    [expiry, setExpiry] = useState("90"),
    [error, setError] = useState<unknown>(),
    [preset, setPreset] = useState("read"),
    [query, setQuery] = useState("");
  const matches = projects.filter((project) =>
    `${project.name} ${project.key} ${workspaceNames.get(project.workspaceId) ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await onCreated(
        await api.request("/api/v1/credentials", createdCredentialSchema, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formText(new FormData(event.currentTarget), "name"),
            projectIds: global ? null : projectIds,
            scopes: permissions,
            expiresIn:
              expiry === "never"
                ? null
                : expiry === "custom"
                  ? credentialExpiry(expiresAt)
                  : Number(expiry) * 86400,
          } satisfies z.input<typeof credentialInput>),
        }),
      );
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  if (loading) return <Loading />;
  return (
    <form
      onSubmit={(event) => {
        void create(event);
      }}
    >
      <FieldSet disabled={pending}>
        <Input
          label={t("settings.credentials.keyName")}
          name="name"
          required
          maxLength={100}
          placeholder={t("settings.credentials.keyNamePlaceholder")}
          autoFocus
        />
        <FieldSet className="gap-2">
          <FieldLegend variant="label">{t("settings.credentials.projectAccess")}</FieldLegend>
          <Check
            label={t("settings.credentials.global")}
            description={t("settings.credentials.globalDescription")}
            checked={global}
            onCheckedChange={setGlobal}
          />
          {!global && projects.length > 6 && (
            <SearchField
              label={t("settings.credentials.findProject")}
              value={query}
              onChange={setQuery}
              className="mb-2"
            />
          )}
          {!global && (
            <div className="max-h-44 overflow-y-auto px-3 py-1">
              {matches.map((project) => (
                <Check
                  key={project.id}
                  label={project.name}
                  description={t("settings.credentials.projectDescription", {
                    key: project.key,
                    workspace:
                      workspaceNames.get(project.workspaceId) ??
                      t("settings.credentials.workspace"),
                  })}
                  checked={projectIds.includes(project.id)}
                  onCheckedChange={(checked) =>
                    setProjectIds((current) =>
                      checked
                        ? [...current, project.id]
                        : current.filter((id) => id !== project.id),
                    )
                  }
                />
              ))}
              {matches.length === 0 && (
                <p className="my-4 text-sm text-muted-foreground">
                  {t("settings.credentials.noMatches")}
                </p>
              )}
            </div>
          )}
          <FieldDescription>{t("settings.credentials.roleLimit")}</FieldDescription>
        </FieldSet>
        <Select
          label={t("settings.credentials.accessLevel")}
          value={preset}
          onValueChange={(value) => {
            const next = value ?? "read";
            setPreset(next);
            if (next !== "custom")
              setPermissions(
                next === "read"
                  ? ["read"]
                  : next === "write"
                    ? ["read", "write"]
                    : ["read", "write", "claim"],
              );
          }}
        >
          <SelectItem value="read">{t("settings.credentials.preset.read")}</SelectItem>
          <SelectItem value="write">{t("settings.credentials.preset.write")}</SelectItem>
          <SelectItem value="automation">{t("settings.credentials.preset.automation")}</SelectItem>
          <SelectItem value="custom">{t("settings.credentials.preset.custom")}</SelectItem>
        </Select>
        {preset === "custom" && (
          <FieldSet className="gap-0">
            {scopes.map((scope) => (
              <Permission
                key={scope}
                scope={scope}
                checked={permissions.includes(scope)}
                onChange={(checked) =>
                  setPermissions((current) =>
                    checked ? [...current, scope] : current.filter((value) => value !== scope),
                  )
                }
              />
            ))}
          </FieldSet>
        )}
        <Select
          label={t("settings.credentials.expires")}
          value={expiry}
          onValueChange={(value) => setExpiry(value ?? "90")}
        >
          {expiryChoices.map((value) => (
            <SelectItem key={value} value={value}>
              {t(`settings.credentials.expiry.${value}`)}
            </SelectItem>
          ))}
        </Select>
        {expiry === "custom" && (
          <DatePicker
            label={t("settings.credentials.expiresOn")}
            value={expiresAt}
            onChange={(chosen) => {
              if (chosen) setExpiresAt(chosen);
            }}
            bounds={{ from: tomorrow, to: lastDay }}
          />
        )}
        {expiry === "never" && (
          <FieldDescription>{t("settings.credentials.neverDescription")}</FieldDescription>
        )}
        <FormActions
          error={error}
          pending={pending}
          submitLabel={t("settings.credentials.create")}
          pendingLabel={t("settings.credentials.creating")}
          submitDisabled={(!global && !projectIds.length) || !permissions.length}
          onCancel={onCancel}
        />
      </FieldSet>
    </form>
  );
}
