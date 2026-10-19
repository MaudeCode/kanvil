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
import { t } from "@kanvil/contracts/i18n";
import { Trans } from "react-i18next";

function useArchive(project: Project) {
  const archive = useOperation("archive_project");
  return {
    pending: archive.isPending,
    set: (archived: boolean) =>
      archive
        .mutateAsync({ projectId: project.id, expectedVersion: project.version, archived })
        .then(() =>
          toast.success(
            archived
              ? t("settings.lifecycle.archivedToast")
              : t("settings.lifecycle.restoredToast"),
          ),
        ),
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
        <Trans
          i18nKey="settings.lifecycle.archivedNotice"
          components={{ time: <RelativeTime value={project.archivedAt} /> }}
        />
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
          {t("settings.lifecycle.restore")}
        </Button>
      )}
    </p>
  );
}
export function ArchiveProjectRow({ project }: { project: Project }) {
  const archive = useArchive(project);
  return (
    <SettingRow
      title={t("settings.lifecycle.archive")}
      description={
        project.archivedAt ? (
          <Trans
            i18nKey="settings.lifecycle.archivedDescription"
            components={{ time: <RelativeTime value={project.archivedAt} /> }}
          />
        ) : (
          t("settings.lifecycle.archiveDescription")
        )
      }
    >
      {project.archivedAt ? (
        <Button
          disabled={archive.pending}
          onClick={() => void archive.set(false).catch(reportError)}
        >
          <ArchiveRestore />
          {t("settings.lifecycle.restore")}
        </Button>
      ) : (
        <Confirm
          label={t("settings.lifecycle.archiveProject")}
          description={t("settings.lifecycle.archiveConfirm", { name: project.name })}
          onConfirm={() => archive.set(true)}
        />
      )}
    </SettingRow>
  );
}
const names = (people: { name: string }[]) => people.map((person) => person.name).join(", ");
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
                ? t("settings.lifecycle.blocker", {
                    message: blocker.message,
                    tickets: blocker.tickets.join(", "),
                  })
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
          [
            t("settings.lifecycle.row.tickets"),
            t("settings.lifecycle.transferTickets", { count: impact.tickets }),
          ],
          [
            t("settings.lifecycle.row.losesAccess"),
            names(impact.transfer.losingAccess) || t("settings.lifecycle.noOne"),
          ],
          [
            t("settings.lifecycle.row.gainsAccess"),
            names(impact.transfer.gainingAccess) || t("settings.lifecycle.noOne"),
          ],
          [t("settings.lifecycle.row.labelsCopied"), impact.transfer.copiedLabels.join(", ")],
          [t("settings.lifecycle.row.labelsMerged"), impact.transfer.mergedLabels.join(", ")],
          [
            t("settings.lifecycle.row.followsRemoved"),
            impact.transfer.subscriptions ? String(impact.transfer.subscriptions) : "",
          ],
          [
            t("settings.lifecycle.row.invitations"),
            impact.transfer.invitations
              ? t("settings.lifecycle.transferInvitations", { count: impact.transfer.invitations })
              : "",
          ],
        ]
      : [
          [t("settings.lifecycle.row.tickets"), String(impact.tickets)],
          [t("settings.lifecycle.row.comments"), String(impact.comments)],
          [
            t("settings.lifecycle.row.files"),
            t("settings.lifecycle.files", {
              count: impact.attachments,
              size: fileSize(impact.attachmentBytes),
            }),
          ],
          [
            t("settings.lifecycle.row.kept"),
            t("settings.lifecycle.keptProject", { count: impact.events, key: project.key }),
          ],
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
        {t("settings.lifecycle.move")}
      </Button>
      <Modal
        title={t("settings.lifecycle.moveTitle", { name: project.name })}
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
                toast.success(
                  destination
                    ? t("settings.lifecycle.moved", { name: destination.name })
                    : t("settings.lifecycle.movedUnnamed"),
                );
              })
              .catch(() => {});
          }}
        >
          <Select
            label={t("settings.lifecycle.destination")}
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
            submitLabel={t("settings.lifecycle.moveProject")}
            pendingLabel={t("settings.lifecycle.moving")}
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
      title={t("settings.lifecycle.export")}
      description={t("settings.lifecycle.exportDescription")}
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
        {pending ? t("settings.lifecycle.exporting") : t("settings.lifecycle.exportJson")}
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
    <SettingRow title={t("settings.lifecycle.delete")} description={description}>
      <Button variant="destructive" onClick={() => toggle(true)}>
        <Trash2 />
        {label}
      </Button>
      <Modal
        title={t("settings.lifecycle.deleteTitle", { name })}
        open={open}
        onOpenChange={toggle}
        busy={pending}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onDelete(typed)
              .then(() => toast.success(t("settings.lifecycle.deleted", { name })))
              .catch(() => {});
          }}
        >
          {summary}
          <Input
            label={t("settings.lifecycle.typeToConfirm", { value: confirm })}
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
            pendingLabel={t("settings.lifecycle.deleting")}
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
      description={t("settings.lifecycle.deleteProjectDescription", { key: project.key })}
      label={t("settings.lifecycle.deleteProject")}
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
      t("settings.lifecycle.row.projects"),
      impact.projects.length ? (
        <ul key="projects" className="m-0 list-none p-0">
          {impact.projects.map((project) => (
            <li key={project.id}>
              <span dir="auto">{project.name}</span>{" "}
              <span className="font-mono text-muted-foreground">{project.key}</span>
              <span className="text-muted-foreground">
                {" "}
                · {t("settings.tickets", { count: project.tickets })}
                {project.archived && <> · {t("settings.lifecycle.archivedProject")}</>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        t("common.state.none")
      ),
    ],
    [t("settings.lifecycle.row.tickets"), String(impact.tickets)],
    [t("settings.lifecycle.row.comments"), String(impact.comments)],
    [
      t("settings.lifecycle.row.files"),
      t("settings.lifecycle.files", {
        count: impact.attachments,
        size: fileSize(impact.attachmentBytes),
      }),
    ],
    [
      t("settings.lifecycle.row.members"),
      t("settings.lifecycle.membersLoseAccess", { count: impact.members }),
    ],
    [
      t("settings.lifecycle.row.invitations"),
      impact.invitations
        ? t("settings.lifecycle.pendingInvitations", { count: impact.invitations })
        : "",
    ],
    [t("settings.lifecycle.row.sharedLabels"), impact.labels ? String(impact.labels) : ""],
    [
      t("settings.lifecycle.row.kept"),
      t("settings.lifecycle.keptWorkspace", { count: impact.events, slug: workspace.slug }),
    ],
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
      {t("settings.lifecycle.signInAgain")}
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
      description={t("settings.lifecycle.deleteWorkspaceDescription")}
      label={t("settings.lifecycle.deleteWorkspace")}
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
      provider === "credential"
        ? t("settings.account.localPassword")
        : provider === "oidc"
          ? "OIDC"
          : provider,
    )
    .join(", ") || t("settings.lifecycle.noSignInMethods");
const accountRows = (impact: AccountImpact): ImpactRows => [
  [t("settings.lifecycle.row.signIn"), signInMethods(impact.providers)],
  [
    t("settings.lifecycle.row.sessions"),
    t("settings.lifecycle.sessions", { count: impact.sessions }),
  ],
  [
    t("settings.lifecycle.row.credentials"),
    impact.credentials ? t("settings.lifecycle.credentials", { count: impact.credentials }) : "",
  ],
  [
    t("settings.lifecycle.row.devices"),
    impact.devices ? t("settings.lifecycle.devices", { count: impact.devices }) : "",
  ],
  [
    t("settings.lifecycle.row.access"),
    impact.projects
      ? t("settings.lifecycle.accessBoth", {
          workspaces: t("settings.lifecycle.workspaceCount", { count: impact.workspaces }),
          projects: t("settings.lifecycle.directProjectCount", { count: impact.projects }),
        })
      : t("settings.lifecycle.accessWorkspaces", {
          workspaces: t("settings.lifecycle.workspaceCount", { count: impact.workspaces }),
        }),
  ],
  [
    t("settings.lifecycle.row.claims"),
    impact.claims ? t("settings.lifecycle.claims", { count: impact.claims }) : "",
  ],
  [
    t("settings.lifecycle.row.imports"),
    impact.imports ? t("settings.lifecycle.imports", { count: impact.imports }) : "",
  ],
  [t("settings.lifecycle.row.profile"), t("settings.lifecycle.profileErased")],
  [
    t("settings.lifecycle.row.kept"),
    t("settings.lifecycle.keptAccount", {
      tickets: t("settings.tickets", { count: impact.tickets }),
      comments: t("settings.lifecycle.commentCount", { count: impact.comments }),
      events: t("settings.lifecycle.activityCount", { count: impact.events }),
      name: deletedAccountName,
    }),
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
      description={t(
        own ? "settings.lifecycle.deleteOwnAccount" : "settings.lifecycle.deleteOtherAccount",
        {
          name: deletedAccountName,
        },
      )}
      label={t("settings.lifecycle.deleteAccount")}
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
