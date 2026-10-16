import { useId, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check as CheckIcon, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { z } from "zod";
import {
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
const permissionText = {
  read: { name: "Read tickets", description: "View projects, tickets, comments, and attachments." },
  write: {
    name: "Edit tickets",
    description: "Create and update tickets, comments, and attachments.",
  },
  claim: { name: "Claim work", description: "Claim, renew, and release ticket ownership." },
  admin: {
    name: "Manage projects",
    description: "Change project settings and membership where your role allows it.",
  },
};
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
    projectIds:
      z.object({ projectIds: z.array(z.string()) }).safeParse(parseJSON(credential.metadata)).data
        ?.projectIds ?? [],
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
        title="API keys"
        description="Connect scripts, integrations, and agents with access you can revoke."
        action={
          <IconButton
            label="Create API key"
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
        <Table aria-label="API keys" mobileLayout="rows">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Access</TableHead>
              <TableHead>Projects</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {credentials.data.map((credential) => {
              const access = accessOf(credential),
                expired = !!credential.expiresAt && new Date(credential.expiresAt).getTime() <= now;
              const projectNames = access.projectIds.map(
                (id) =>
                  projects.data?.find((project) => project.id === id)?.name ??
                  "Unavailable project",
              );
              return (
                <TableRow key={credential.id}>
                  <TableCell className="max-w-64 whitespace-normal">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <KeyRound className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <strong className="block wrap-anywhere font-medium">
                          {credential.name || "Untitled key"}
                        </strong>
                        <code className="text-xs text-muted-foreground">{credential.start}…</code>
                      </div>
                      {(expired || !credential.enabled) && (
                        <Badge variant="secondary">{expired ? "Expired" : "Disabled"}</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell data-label="Access" className="max-w-72 whitespace-normal">
                    <span className="text-sm">
                      {access.permissions.length === 1 && access.permissions[0] === "read"
                        ? "Read only"
                        : access.permissions
                            .map((scope) => permissionText[scope].name)
                            .join(", ") || "Custom"}
                    </span>
                  </TableCell>
                  <TableCell data-label="Projects" className="max-w-64 whitespace-normal">
                    {projectNames.join(", ") || "No project access"}
                  </TableCell>
                  <TableCell
                    data-label="Expires"
                    className="whitespace-nowrap text-muted-foreground"
                  >
                    {credential.expiresAt ? date(credential.expiresAt) : "Never"}
                  </TableCell>
                  <TableCell>
                    <Confirm
                      label="Revoke API key"
                      icon={<Trash2 />}
                      danger
                      description={`Revoke ${credential.name ?? "this API key"}? Connections using it will immediately lose access.`}
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
        <EmptyState title="No API keys" icon={KeyRound} className="py-16">
          <p className="mb-0 max-w-sm text-center text-sm text-muted-foreground">
            Create a key when a script, integration, or agent needs access to your projects.
          </p>
        </EmptyState>
      )}
      <Modal
        busy={pending}
        title={secret ? "API key created" : "Create API key"}
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
      <p>Copy this key now. You won’t be able to see it again.</p>
      <Input
        label="New API key"
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
          {copied ? "Copied" : "Copy API key"}
        </Button>
        <Button variant="default" onClick={onDone}>
          Done
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
    text = permissionText[scope];
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
    [permissions, setPermissions] = useState<(typeof scopes)[number][]>(["read"]),
    [expiresAt, setExpiresAt] = useState(() => {
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + 90);
      return expiry;
    }),
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
            name: new FormData(event.currentTarget).get("name"),
            projectIds,
            scopes: permissions,
            expiresIn: credentialExpiry(expiresAt),
          }),
        }),
      );
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  if (loading) return <Loading />;
  if (!projects.length)
    return (
      <EmptyState title="Choose a project first" className="py-8">
        <p>API keys need access to at least one project.</p>
        <Button render={<Link to="/" />}>Go to projects</Button>
      </EmptyState>
    );
  return (
    <form
      onSubmit={(event) => {
        void create(event);
      }}
    >
      <FieldSet disabled={pending}>
        <Input
          label="Key name"
          name="name"
          required
          maxLength={100}
          placeholder="e.g. Release automation"
          autoFocus
        />
        <FieldSet className="gap-2">
          <FieldLegend variant="label">Project access</FieldLegend>
          {projects.length > 6 && (
            <SearchField label="Find project" value={query} onChange={setQuery} className="mb-2" />
          )}
          <div className="max-h-44 overflow-y-auto rounded-md border px-3 py-1">
            {matches.map((project) => (
              <Check
                key={project.id}
                label={project.name}
                description={`${project.key} · ${workspaceNames.get(project.workspaceId) ?? "Workspace"}`}
                checked={projectIds.includes(project.id)}
                onCheckedChange={(checked) =>
                  setProjectIds((current) =>
                    checked ? [...current, project.id] : current.filter((id) => id !== project.id),
                  )
                }
              />
            ))}
            {matches.length === 0 && (
              <p className="my-4 text-sm text-muted-foreground">No matching projects</p>
            )}
          </div>
          <FieldDescription>
            Your existing project role still limits what this key can do.
          </FieldDescription>
        </FieldSet>
        <Select
          label="Access level"
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
          <SelectItem value="read">Read only</SelectItem>
          <SelectItem value="write">Read and write</SelectItem>
          <SelectItem value="automation">Read, write, and claim work</SelectItem>
          <SelectItem value="custom">Custom permissions</SelectItem>
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
        <DatePicker
          label="Expires on"
          value={expiresAt}
          onChange={(chosen) => {
            if (chosen) setExpiresAt(chosen);
          }}
          bounds={{ from: tomorrow, to: lastDay }}
        />
        <FormActions
          error={error}
          pending={pending}
          submitLabel="Create API key"
          pendingLabel="Creating…"
          submitDisabled={!projectIds.length || !permissions.length}
          onCancel={onCancel}
        />
      </FieldSet>
    </form>
  );
}
