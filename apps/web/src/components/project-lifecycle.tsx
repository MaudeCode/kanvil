import { useState, type ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, ArrowRightLeft, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Project, ProjectImpact, Workspace } from "@kanvil/contracts";
import { api, useOperation, useProjectAccess } from "../data.tsx";
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
// What a deletion or move changes, as `get_project_impact` reports it; blockers come first.
function ImpactSummary({
  project,
  query,
}: {
  project: Project;
  query: UseQueryResult<ProjectImpact>;
}) {
  if (query.error) return <ErrorNotice error={query.error} />;
  if (!query.data) return <Loading />;
  const impact = query.data;
  const rows: [string, ReactNode][] = impact.transfer
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
  return (
    <>
      {impact.blockers.map((blocker) => (
        <ErrorNotice
          key={blocker.code}
          error={new Error(`${blocker.message}: ${blocker.tickets.join(", ")}`)}
        />
      ))}
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
    </>
  );
}
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
          <ImpactSummary project={project} query={impact} />
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
export function DeleteProjectRow({ project }: { project: Project }) {
  const navigate = useNavigate(),
    [open, setOpen] = useState(false),
    [typed, setTyped] = useState(""),
    // Leaves the project's pages before their reads refetch and find it gone.
    remove = useOperation("delete_project", () => navigate({ to: "/" }));
  const impact = useQuery({
    ...api.query("get_project_impact", { projectId: project.id }),
    enabled: open,
  });
  return (
    <SettingRow
      title="Delete"
      description={`Permanently removes tickets, comments, and files. Activity history stays, and ${project.key} is never reused.`}
    >
      <Button variant="destructive" onClick={() => setOpen(true)}>
        <Trash2 />
        Delete project
      </Button>
      <Modal
        title={`Delete ${project.name}`}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setTyped("");
            remove.reset();
          }
        }}
        busy={remove.isPending}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void remove
              .mutateAsync({
                projectId: project.id,
                expectedVersion: project.version,
                confirmKey: typed,
              })
              .then(() => toast.success(`${project.name} deleted`))
              .catch(() => {});
          }}
        >
          <ImpactSummary project={project} query={impact} />
          <Input
            label={`Type ${project.key} to confirm`}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono uppercase"
          />
          <FormActions
            danger
            error={remove.error}
            pending={remove.isPending}
            submitLabel="Delete project"
            pendingLabel="Deleting…"
            submitDisabled={
              typed.trim().toUpperCase() !== project.key ||
              !impact.data ||
              impact.data.blockers.length > 0
            }
            onCancel={() => setOpen(false)}
          />
        </form>
      </Modal>
    </SettingRow>
  );
}
