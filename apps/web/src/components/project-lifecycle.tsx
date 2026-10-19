import { useState, type ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, ArrowRightLeft, Download, LogIn, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  ApiError,
  deletedAccountName,
  type AccountImpact,
  type Project,
  type ProjectImpact,
  type Workspace,
  type WorkspaceImpact,
} from "@kanvil/contracts";
import { api, signOut, useIdentity, useOperation, useProjectAccess } from "../data.tsx";
import { downloadFile } from "../lib/browser.ts";
import {
  Button,
  Confirm,
  ErrorNotice,
  FormActions,
  Input,
  Loading,
  Modal,
  RelativeTime,
  Select,
  SelectItem,
  fileSize,
  reportError,
} from "../ui.tsx";
import { SettingRow } from "./settings-layout.tsx";

function useArchive(project: Project) {
  const archive = useOperation("archive_project");
  return {
    pending: archive.isPending,
    set: (archived: boolean) =>
      archive
        .mutateAsync({ projectId: project.id, expectedVersion: project.version, archived })
        .then(() => toast.success(archived ? "Project archived" : "Project restored")),
  };
}
// Shown above an archived project's tickets; its administrators restore it from here.
export function ArchivedNotice({ project }: { project: Project }) {
  const access = useProjectAccess(project.id),
    archive = useArchive(project);
  if (!project.archivedAt) return null;
  return (
    <p
      role="status"
      className="mt-0 mb-4 flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-b py-1.5 text-xs text-muted-foreground"
    >
      <Archive className="size-3.5" aria-hidden="true" />
      <span>
        Archived <RelativeTime value={project.archivedAt} /> · read only
      </span>
      {access.canManage && (
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={archive.pending}
          onClick={() => void archive.set(false).catch(reportError)}
        >
          <ArchiveRestore />
          Restore
        </Button>
      )}
    </p>
  );
}
export function ArchiveProjectRow({ project }: { project: Project }) {
  const archive = useArchive(project);
  return (
    <SettingRow
      title="Archive"
      description={
        project.archivedAt ? (
          <>
            Archived <RelativeTime value={project.archivedAt} />. Its tickets are read only and stay
            out of lists, search, My work, calendar feeds, and agent queues.
          </>
        ) : (
          "Hides the project from lists, search, My work, calendar feeds, and agent queues and makes its tickets read only. History is kept."
        )
      }
    >
      {project.archivedAt ? (
        <Button
          disabled={archive.pending}
          onClick={() => void archive.set(false).catch(reportError)}
        >
          <ArchiveRestore />
          Restore
        </Button>
      ) : (
        <Confirm
          label="Archive project"
          description={`${project.name} leaves project lists and agent queues until it is restored. Claimed tickets must be released first.`}
          onConfirm={() => archive.set(true)}
        />
      )}
    </SettingRow>
  );
}
const names = (people: { name: string }[]) => people.map((person) => person.name).join(", ");
const counted = (value: number, one: string, many = `${one}s`) =>
  `${value} ${value === 1 ? one : many}`;
type ImpactRows = [string, ReactNode][];
// What a deletion or move changes, as its impact preview reports it; blockers come first.
function ImpactSummary<T extends Pick<ProjectImpact, "blockers">>({
  query,
  rows: describe,
}: {
  query: UseQueryResult<T>;
  rows: (impact: T) => ImpactRows;
}) {
  if (query.error) return <ErrorNotice error={query.error} />;
  if (!query.data) return <Loading />;
  const impact = query.data;
  return (
    <>
      {impact.blockers.map((blocker) => (
        <ErrorNotice
          // One code can block for several reasons, such as two administrator checks.
          key={`${blocker.code}:${blocker.message}`}
          error={
            new Error(
              blocker.tickets.length
                ? `${blocker.message}: ${blocker.tickets.join(", ")}`
                : blocker.message,
            )
          }
        />
      ))}
      <SummaryList rows={describe(impact)} />
    </>
  );
}
// Labeled values of a preview; empty values are left out.
export function SummaryList({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="my-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1.5 text-sm">
      {rows
        .filter(([, value]) => value !== "")
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="m-0 wrap-anywhere">{value}</dd>
          </div>
        ))}
    </dl>
  );
}
const projectRows =
  (project: Project) =>
  (impact: ProjectImpact): ImpactRows =>
    impact.transfer
      ? [
          ["Tickets", `${impact.tickets}, keeping their keys and links`],
          ["Loses access", names(impact.transfer.losingAccess) || "No one"],
          ["Gains access", names(impact.transfer.gainingAccess) || "No one"],
          ["Labels copied", impact.transfer.copiedLabels.join(", ")],
          ["Labels merged", impact.transfer.mergedLabels.join(", ")],
          [
            "Follows removed",
            impact.transfer.subscriptions ? String(impact.transfer.subscriptions) : "",
          ],
          [
            "Invitations",
            impact.transfer.invitations
              ? `${impact.transfer.invitations} pending ${impact.transfer.invitations === 1 ? "invitation drops" : "invitations drop"} the project`
              : "",
          ],
        ]
      : [
          ["Tickets", String(impact.tickets)],
          ["Comments", String(impact.comments)],
          ["Files", `${impact.attachments} · ${fileSize(impact.attachmentBytes)}`],
          ["Kept", `${impact.events} activity entries and the ${project.key} prefix`],
        ];
// Offered to administrators of the project's workspace who administer another one too.
export function MoveProject({
  project,
  destinations,
}: {
  project: Project;
  destinations: Workspace[];
}) {
  const [open, setOpen] = useState(false),
    [target, setTarget] = useState(destinations[0]?.id ?? ""),
    transfer = useOperation("transfer_project");
  const impact = useQuery({
    ...api.query("get_project_impact", { projectId: project.id, workspaceId: target }),
    enabled: open && !!target,
  });
  const destination = destinations.find((space) => space.id === target);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <ArrowRightLeft />
        Move
      </Button>
      <Modal
        title={`Move ${project.name}`}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) transfer.reset();
        }}
        busy={transfer.isPending}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void transfer
              .mutateAsync({
                projectId: project.id,
                expectedVersion: project.version,
                workspaceId: target,
              })
              .then(() => {
                setOpen(false);
                toast.success(`Moved to ${destination?.name ?? "the workspace"}`);
              })
              .catch(() => {});
          }}
        >
          <Select
            label="Destination workspace"
            value={target}
            onValueChange={(value) => {
              if (value) setTarget(value);
            }}
          >
            {destinations.map((space) => (
              <SelectItem key={space.id} value={space.id}>
                {space.name}
              </SelectItem>
            ))}
          </Select>
          <ImpactSummary query={impact} rows={projectRows(project)} />
          <FormActions
            error={transfer.error}
            pending={transfer.isPending}
            submitLabel="Move project"
            pendingLabel="Moving…"
            submitDisabled={!impact.data || impact.data.blockers.length > 0}
            onCancel={() => setOpen(false)}
          />
        </form>
      </Modal>
    </>
  );
}
// Anyone who can read the project can export what they read.
export function ExportProjectRow({ project }: { project: Project }) {
  const [pending, setPending] = useState(false);
  return (
    <SettingRow
      title="Export"
      description="Tickets with their workflow, fields, labels, relationships, comments, evidence, and links as versioned JSON. Attachments and activity history stay here."
    >
      <Button
        disabled={pending}
        onClick={() => {
          setPending(true);
          void api
            .call("export_project", { projectId: project.id })
            .then((bundle) =>
              downloadFile(`${project.key}.kanvil-tickets.json`, JSON.stringify(bundle, null, 2)),
            )
            .catch(reportError)
            .finally(() => setPending(false));
        }}
      >
        <Download />
        {pending ? "Exporting…" : "Export JSON"}
      </Button>
    </SettingRow>
  );
}
// Deleting a project or a workspace: the preview, a typed confirmation, and the destructive submit.
function DeletionRow({
  description,
  label,
  name,
  confirm,
  open,
  onOpenChange,
  summary,
  ready,
  pending,
  error,
  onDelete,
  footer,
}: {
  description: string;
  label: string;
  name: string;
  // The value people type to confirm; compared without regard to case.
  confirm: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: ReactNode;
  // The preview loaded without blockers.
  ready: boolean;
  pending: boolean;
  error: unknown;
  onDelete: (typed: string) => Promise<unknown>;
  footer?: ReactNode;
}) {
  const [typed, setTyped] = useState(""),
    toggle = (next: boolean) => {
      onOpenChange(next);
      if (!next) setTyped("");
    };
  return (
    <SettingRow title="Delete" description={description}>
      <Button variant="destructive" onClick={() => toggle(true)}>
        <Trash2 />
        {label}
      </Button>
      <Modal title={`Delete ${name}`} open={open} onOpenChange={toggle} busy={pending}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onDelete(typed)
              .then(() => toast.success(`${name} deleted`))
              .catch(() => {});
          }}
        >
          {summary}
          <Input
            label={`Type ${confirm} to confirm`}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          {footer}
          <FormActions
            danger
            error={error}
            pending={pending}
            submitLabel={label}
            pendingLabel="Deleting…"
            submitDisabled={typed.trim().toLowerCase() !== confirm.toLowerCase() || !ready}
            onCancel={() => toggle(false)}
          />
        </form>
      </Modal>
    </SettingRow>
  );
}
export function DeleteProjectRow({ project }: { project: Project }) {
  const navigate = useNavigate(),
    [open, setOpen] = useState(false),
    // Leaves the project's pages before their reads refetch and find it gone.
    remove = useOperation("delete_project", () => navigate({ to: "/" }));
  const impact = useQuery({
    ...api.query("get_project_impact", { projectId: project.id }),
    enabled: open,
  });
  return (
    <DeletionRow
      description={`Permanently removes tickets, comments, and files. Activity history stays, and ${project.key} is never reused.`}
      label="Delete project"
      name={project.name}
      confirm={project.key}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) remove.reset();
      }}
      summary={<ImpactSummary query={impact} rows={projectRows(project)} />}
      ready={!!impact.data && !impact.data.blockers.length}
      pending={remove.isPending}
      error={remove.error}
      onDelete={(typed) =>
        remove.mutateAsync({
          projectId: project.id,
          expectedVersion: project.version,
          confirmKey: typed,
        })
      }
    />
  );
}
const workspaceRows =
  (workspace: Workspace) =>
  (impact: WorkspaceImpact): ImpactRows => [
    [
      "Projects",
      impact.projects.length ? (
        <ul key="projects" className="m-0 list-none p-0">
          {impact.projects.map((project) => (
            <li key={project.id}>
              {project.name} <span className="font-mono text-muted-foreground">{project.key}</span>
              <span className="text-muted-foreground">
                {" "}
                · {counted(project.tickets, "ticket")}
                {project.archived && " · archived"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        "None"
      ),
    ],
    ["Tickets", String(impact.tickets)],
    ["Comments", String(impact.comments)],
    ["Files", `${impact.attachments} · ${fileSize(impact.attachmentBytes)}`],
    ["Members", `${impact.members} lose access; their accounts stay`],
    ["Invitations", impact.invitations ? `${impact.invitations} pending` : ""],
    ["Shared labels", impact.labels ? String(impact.labels) : ""],
    ["Kept", `${impact.events} activity entries and the ${workspace.slug} URL key`],
  ];
// Workspace and account deletion ask for a sign-in within the last 15 minutes; an older session
// signs in again and returns to the same page.
function SignInAgain({ error }: { error: unknown }) {
  const identity = useIdentity();
  if (!(error instanceof ApiError && error.code === "reauthentication_required")) return null;
  return (
    <Button
      className="mb-3"
      onClick={() =>
        void signOut(identity, window.location.pathname + window.location.search).catch(reportError)
      }
    >
      <LogIn />
      Sign in again
    </Button>
  );
}
// Offered to the workspace owner and instance administrators.
export function DeleteWorkspaceRow({ workspace }: { workspace: Workspace }) {
  const navigate = useNavigate(),
    [open, setOpen] = useState(false),
    remove = useOperation("delete_workspace", () => navigate({ to: "/" }));
  const impact = useQuery({
    ...api.query("get_workspace_impact", { workspaceId: workspace.id }),
    enabled: open,
  });
  return (
    <DeletionRow
      description="Permanently deletes every project in the workspace with its tickets, comments, and files, and removes its members. Accounts and activity history stay."
      label="Delete workspace"
      name={workspace.name}
      confirm={workspace.slug}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) remove.reset();
      }}
      summary={<ImpactSummary query={impact} rows={workspaceRows(workspace)} />}
      ready={!!impact.data && !impact.data.blockers.length}
      pending={remove.isPending}
      error={remove.error}
      footer={<SignInAgain error={remove.error} />}
      onDelete={(typed) =>
        remove.mutateAsync({
          workspaceId: workspace.id,
          expectedVersion: workspace.version,
          confirmSlug: typed,
        })
      }
    />
  );
}
export const signInMethods = (providers: readonly string[]) =>
  providers
    .map((provider) =>
      provider === "credential" ? "Local password" : provider === "oidc" ? "OIDC" : provider,
    )
    .join(", ") || "No linked sign-in methods";
const accountRows = (impact: AccountImpact): ImpactRows => [
  ["Sign-in", signInMethods(impact.providers)],
  ["Sessions", `${counted(impact.sessions, "session")} signed out`],
  [
    "Credentials",
    impact.credentials ? `${counted(impact.credentials, "API key or app connection")} revoked` : "",
  ],
  [
    "Devices",
    impact.devices ? `${counted(impact.devices, "device or notification channel")} removed` : "",
  ],
  [
    "Access",
    `${counted(impact.workspaces, "workspace")}${impact.projects ? ` and ${counted(impact.projects, "direct project")}` : ""} removed`,
  ],
  ["Claims", impact.claims ? `${counted(impact.claims, "claim")} released` : ""],
  ["Imports", impact.imports ? `${counted(impact.imports, "import")} cancelled` : ""],
  ["Profile", "Name, email, and photo erased"],
  [
    "Kept",
    `${counted(impact.tickets, "ticket")}, ${counted(impact.comments, "comment")}, and ${counted(impact.events, "activity entry", "activity entries")} shown as ${deletedAccountName}`,
  ],
];
// One flow for deleting your own account and for an instance administrator deleting someone
// else's; the server applies the same checks to both.
export function DeleteAccountRow({
  account,
  onDeleted,
}: {
  account: { id: string; name: string; email: string };
  onDeleted: () => Promise<unknown>;
}) {
  const identity = useIdentity(),
    own = account.id === identity.id,
    [open, setOpen] = useState(false),
    remove = useOperation("delete_account", onDeleted);
  const impact = useQuery({
    ...api.query("get_account_impact", { userId: account.id }),
    enabled: open,
  });
  return (
    <DeletionRow
      description={`Permanently removes ${own ? "your" : "this account's"} sign-in, sessions, keys, devices, memberships, and personal details. Tickets, comments, and activity stay and show as ${deletedAccountName}.`}
      label="Delete account"
      name={account.name}
      confirm={account.email}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) remove.reset();
      }}
      summary={<ImpactSummary query={impact} rows={accountRows} />}
      ready={!!impact.data && !impact.data.blockers.length}
      pending={remove.isPending}
      error={remove.error}
      footer={<SignInAgain error={remove.error} />}
      onDelete={(typed) => remove.mutateAsync({ userId: account.id, confirmEmail: typed })}
    />
  );
}
