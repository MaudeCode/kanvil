import { useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Upload } from "lucide-react";
import {
  importStatusLabels,
  ticketExportSchema,
  ticketImportSchema,
  type ImportRun,
  type TicketExport,
} from "@kanvil/contracts";
import { api, useOperation } from "../data.tsx";
import {
  Button,
  ErrorNotice,
  FormActions,
  Input,
  Loading,
  ModalActions,
  Modal,
  RelativeTime,
} from "../ui.tsx";
import { SettingRow } from "./settings-layout.tsx";
import { PrefixInput, ProjectAccessField, suggestKey } from "./create-project.tsx";
import { SummaryList } from "./project-lifecycle.tsx";

const countLabels: [string, string][] = [
  ["tickets", "Tickets"],
  ["workflow", "Workflow states"],
  ["fields", "Custom fields"],
  ["labels", "Labels"],
  ["relations", "Relationships"],
  ["comments", "Comments"],
  ["evidence", "Evidence"],
  ["links", "Links"],
];
const notExport = "This file is not a Kanvil ticket export.";
const isRunning = (run: ImportRun | undefined) => run?.status === "running";
const blocked = (run: ImportRun) => run.issues.some((issue) => issue.severity === "error");
function progressText(run: ImportRun) {
  const { done, failed, total } = run.progress;
  return `${importStatusLabels[run.status]} · ${done} of ${total} records${failed ? ` · ${failed} failed` : ""}`;
}

// Workspace writers create projects from ticket exports; their recent runs list below the action.
export function ImportProjects({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false),
    [runId, setRunId] = useState<string | null>(null);
  const runs = useQuery({
    ...api.query("list_imports", { workspaceId }),
    refetchInterval: (query) => (query.state.data?.some(isRunning) ? 2000 : false),
  });
  const show = (id: string | null) => {
    setRunId(id);
    setOpen(true);
  };
  return (
    <>
      <SettingRow title="Import" description="Creates a project from a Kanvil ticket export.">
        <Button onClick={() => show(null)}>
          <Upload />
          Import project
        </Button>
      </SettingRow>
      {runs.data?.map((run) => (
        <SettingRow
          key={run.id}
          compact
          title={
            <>
              {run.name} <span className="font-mono text-xs text-muted-foreground">{run.key}</span>
            </>
          }
          description={
            <>
              {progressText(run)} · <RelativeTime value={run.updatedAt} />
            </>
          }
        >
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Details of ${run.name}`}
            onClick={() => show(run.id)}
          >
            Details
          </Button>
        </SettingRow>
      ))}
      <Modal title="Import project" open={open} onOpenChange={setOpen}>
        {runId ? (
          <ImportRunView workspaceId={workspaceId} runId={runId} onClose={() => setOpen(false)} />
        ) : (
          <ImportForm
            workspaceId={workspaceId}
            onStarted={setRunId}
            onCancel={() => setOpen(false)}
          />
        )}
      </Modal>
    </>
  );
}

// Choose a file, name the project, preview, then import. Any change discards the preview.
function ImportForm({
  workspaceId,
  onStarted,
  onCancel,
}: {
  workspaceId: string;
  onStarted: (runId: string) => void;
  onCancel: () => void;
}) {
  const [bundle, setBundle] = useState<TicketExport>(),
    [fileError, setFileError] = useState<unknown>(),
    [name, setName] = useState(""),
    [key, setKey] = useState(""),
    [visibility, setVisibility] = useState<"workspace" | "private">("workspace"),
    [run, setRun] = useState<ImportRun>();
  const preview = useOperation("preview_import"),
    start = useOperation("start_import"),
    // Counts edits, so a preview answered after one is dropped rather than shown for new values.
    edits = useRef(0);
  const discard = () => {
    edits.current += 1;
    setRun(undefined);
    preview.reset();
  };
  const changed =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      discard();
    };
  const ready = !!run && !blocked(run);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!bundle) return;
        if (ready)
          void start
            .mutateAsync({ workspaceId, importId: run.id, expectedVersion: run.version })
            .then((started) => onStarted(started.id))
            .catch(() => {});
        else {
          const asked = edits.current;
          void preview
            .mutateAsync({ workspaceId, key, name, visibility, bundle })
            .then((staged) => {
              if (edits.current === asked) setRun(staged);
            })
            .catch(() => {});
        }
      }}
    >
      <Input
        label="Export file"
        type="file"
        accept="application/json,.json"
        required
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          setBundle(undefined);
          discard();
          setFileError(undefined);
          if (!file) return;
          void file
            .text()
            .then((text) => {
              const data: unknown = JSON.parse(text);
              if (!ticketExportSchema.pick({ format: true }).safeParse(data).success)
                throw new Error(notExport);
              const parsed = ticketImportSchema.parse(data);
              setBundle(parsed);
              setName(parsed.project.name);
              setKey(
                /^[A-Z][A-Z0-9]{1,9}$/.test(parsed.project.key)
                  ? parsed.project.key
                  : suggestKey(parsed.project.name),
              );
            })
            .catch((error: unknown) =>
              setFileError(error instanceof SyntaxError ? new Error(notExport) : error),
            );
        }}
      />
      <ErrorNotice error={fileError} />
      {bundle && (
        <>
          <Input
            label="Project name"
            value={name}
            onChange={(event) => changed(setName)(event.target.value)}
            required
            maxLength={120}
          />
          <PrefixInput value={key} onChange={changed(setKey)} />
          <ProjectAccessField value={visibility} onChange={changed(setVisibility)} />
        </>
      )}
      {run && <ImportPreview run={run} />}
      <FormActions
        error={preview.error ?? start.error}
        pending={preview.isPending || start.isPending}
        submitLabel={ready ? "Import" : "Preview"}
        pendingLabel={ready ? "Starting…" : "Checking…"}
        submitDisabled={!bundle || (!!run && !ready)}
        onCancel={onCancel}
      />
    </form>
  );
}

// What the bundle holds, who keeps their assignments, and what the import changes or leaves out.
function ImportPreview({ run }: { run: ImportRun }) {
  const matched = run.members.filter((person) => person.userId),
    unmatched = run.members.filter((person) => !person.userId);
  const rows: [string, ReactNode][] = [
    ...countLabels.map(([key, label]): [string, ReactNode] => [
      label,
      run.counts[key] ? String(run.counts[key]) : "",
    ]),
    ["Matched people", matched.map((person) => person.name).join(", ")],
    ["Unmatched people", unmatched.map((person) => person.name).join(", ")],
  ];
  return (
    <section aria-label="Import preview" className="mt-2 border-t pt-3">
      <SummaryList rows={rows} />
      {run.issues.length > 0 && (
        <ul className="m-0 list-none space-y-1.5 p-0 text-sm">
          {run.issues.map((issue) => (
            <li
              key={issue.message}
              className={issue.severity === "error" ? "text-destructive" : "text-muted-foreground"}
            >
              <span className="sr-only">{issue.severity === "error" ? "Error: " : "Note: "}</span>
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// A started run: progress while it writes, then its result and any failed records.
function ImportRunView({
  workspaceId,
  runId,
  onClose,
}: {
  workspaceId: string;
  runId: string;
  onClose: () => void;
}) {
  const query = useQuery({
    ...api.query("get_import", { workspaceId, importId: runId }),
    refetchInterval: (current) => (isRunning(current.state.data) ? 1000 : false),
  });
  const cancel = useOperation("cancel_import");
  if (query.error) return <ErrorNotice error={query.error} />;
  const run = query.data;
  if (!run) return <Loading />;
  const { done, failed, total } = run.progress,
    percent = total ? Math.round(((done + failed) / total) * 100) : 0;
  return (
    <>
      <p className="mt-0 mb-2 text-sm">
        {run.name} <span className="font-mono text-xs text-muted-foreground">{run.key}</span>
      </p>
      <div className="my-3">
        <div
          role="progressbar"
          aria-label="Import progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1.5 overflow-hidden rounded-full bg-border"
        >
          <div
            className="h-full bg-primary transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p role="status" className="mt-2 mb-0 text-sm text-muted-foreground tabular-nums">
          {progressText(run)}
        </p>
      </div>
      {run.errors.length > 0 && (
        <ul aria-label="Records not imported" className="m-0 list-none space-y-1 p-0 text-sm">
          {run.errors.map((error, index) => (
            <li key={index} className="text-destructive">
              {error.label}: {error.message}
            </li>
          ))}
        </ul>
      )}
      <ErrorNotice error={cancel.error} />
      <ModalActions>
        {run.status === "running" && (
          <Button
            disabled={cancel.isPending}
            onClick={() =>
              void cancel
                .mutateAsync({ workspaceId, importId: run.id, expectedVersion: run.version })
                .catch(() => {})
            }
          >
            Stop import
          </Button>
        )}
        {run.projectId && run.status !== "running" && (
          <Button
            variant="default"
            render={<Link to="/projects/$projectId" params={{ projectId: run.projectId }} />}
            onClick={onClose}
          >
            Open project
          </Button>
        )}
      </ModalActions>
    </>
  );
}
