import { useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Upload } from "lucide-react";
import {
  importProviderDefinitions,
  importProviders,
  importStatusLabels,
  jiraEditionLabels,
  jiraEditions,
  ticketExportSchema,
  ticketImportSchema,
  type ImportProvider,
  type ImportRun,
  type ImportSource,
  type ImportSourceProject,
  type TicketExport,
} from "@kanvil/contracts";
import { api, useOperation } from "../data.tsx";
import {
  Button,
  Check,
  ErrorNotice,
  FormActions,
  Input,
  Loading,
  ModalActions,
  Modal,
  RelativeTime,
  Select,
  SelectItem,
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
      <SettingRow
        title="Import"
        description="Creates a project from a Kanvil ticket export, a Linear team, or a Jira project."
      >
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

type SourceKind = "file" | ImportProvider;
const sourceKindLabels: Record<SourceKind, string> = {
  file: "Kanvil export file",
  linear: importProviderDefinitions.linear.label,
  jira: importProviderDefinitions.jira.label,
};
type Credentials = {
  token: string;
  edition: (typeof jiraEditions)[number];
  baseUrl: string;
  email: string;
};
const noCredentials: Credentials = { token: "", edition: "cloud", baseUrl: "", email: "" };
// A source prefix when it is a valid one, otherwise a prefix suggested from the name.
const keyFrom = (key: string, name: string) =>
  /^[A-Z][A-Z0-9]{1,9}$/.test(key) ? key : suggestKey(name);

// Choose a file, or connect to Linear or Jira and pick a team or project; then name the project,
// preview, and import. The submit moves through these steps, and any change discards the steps
// after it. Credentials stay in this form and go out with the request that needs them.
function ImportForm({
  workspaceId,
  onStarted,
  onCancel,
}: {
  workspaceId: string;
  onStarted: (runId: string) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<SourceKind>("file"),
    [credentials, setCredentials] = useState(noCredentials),
    [projects, setProjects] = useState<ImportSourceProject[]>(),
    [sourceProject, setSourceProject] = useState(""),
    [includeComments, setIncludeComments] = useState(true),
    [bundle, setBundle] = useState<TicketExport>(),
    [fileError, setFileError] = useState<unknown>(),
    [name, setName] = useState(""),
    [key, setKey] = useState(""),
    [visibility, setVisibility] = useState<"workspace" | "private">("workspace"),
    [run, setRun] = useState<ImportRun>();
  const connect = useOperation("list_import_source_projects"),
    previewFile = useOperation("preview_import"),
    previewSource = useOperation("preview_source_import"),
    start = useOperation("start_import"),
    // Counts edits, so an answer to a request made before one is dropped rather than shown for
    // new values.
    edits = useRef(0);
  const discard = () => {
    edits.current += 1;
    setRun(undefined);
    previewFile.reset();
    previewSource.reset();
  };
  const changed =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      discard();
    };
  // New credentials or another source drop the connection and what was chosen through it.
  const disconnect = () => {
    discard();
    setProjects(undefined);
    setSourceProject("");
    connect.reset();
  };
  const pick = (picked: ImportSourceProject | undefined) => {
    if (!picked) return;
    setSourceProject(picked.ref);
    setName(picked.name);
    setKey(keyFrom(picked.key, picked.name));
    discard();
  };
  const credential = (field: keyof Credentials) => (value: string) => {
    setCredentials((current) => ({ ...current, [field]: value }));
    disconnect();
  };
  const source: ImportSource | undefined =
    kind === "linear"
      ? { provider: "linear", token: credentials.token }
      : kind === "jira"
        ? { provider: "jira", ...credentials }
        : undefined;
  const chosen = kind === "file" ? !!bundle : !!sourceProject,
    ready = !!run && !blocked(run),
    connecting = !!source && !projects;
  // An answer counts only if nothing changed since it was asked.
  const unchanged = (asked: number) => edits.current === asked;
  const preview = kind === "file" ? previewFile : previewSource;
  const definition = kind === "file" ? undefined : importProviderDefinitions[kind];
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const asked = edits.current;
        if (ready)
          void start
            .mutateAsync({ workspaceId, importId: run.id, expectedVersion: run.version })
            .then((started) => onStarted(started.id))
            .catch(() => {});
        else if (source && connecting)
          void connect
            .mutateAsync({ workspaceId, source })
            .then((listed) => {
              if (!unchanged(asked)) return;
              setProjects(listed);
              pick(listed[0]);
            })
            .catch(() => {});
        else if (source)
          void previewSource
            .mutateAsync({
              workspaceId,
              key,
              name,
              visibility,
              source,
              sourceProject,
              includeComments,
            })
            .then((staged) => {
              if (unchanged(asked)) setRun(staged);
            })
            .catch(() => {});
        else if (bundle)
          void previewFile
            .mutateAsync({ workspaceId, key, name, visibility, bundle })
            .then((staged) => {
              if (unchanged(asked)) setRun(staged);
            })
            .catch(() => {});
      }}
    >
      <Select
        label="Source"
        value={kind}
        onValueChange={(value) => {
          const next = (["file", ...importProviders] as const).find((item) => item === value);
          if (!next) return;
          setKind(next);
          setBundle(undefined);
          setFileError(undefined);
          setCredentials(noCredentials);
          disconnect();
        }}
      >
        {(["file", ...importProviders] as const).map((item) => (
          <SelectItem key={item} value={item}>
            {sourceKindLabels[item]}
          </SelectItem>
        ))}
      </Select>
      {kind === "file" ? (
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
            // A file chosen while an earlier one is still being read replaces it.
            const picked = edits.current;
            void file
              .text()
              .then((text) => {
                const data: unknown = JSON.parse(text);
                if (!ticketExportSchema.pick({ format: true }).safeParse(data).success)
                  throw new Error(notExport);
                const parsed = ticketImportSchema.parse(data);
                if (edits.current !== picked) return;
                setBundle(parsed);
                setName(parsed.project.name);
                setKey(keyFrom(parsed.project.key, parsed.project.name));
              })
              .catch((error: unknown) => {
                if (edits.current === picked)
                  setFileError(error instanceof SyntaxError ? new Error(notExport) : error);
              });
          }}
        />
      ) : (
        <>
          {kind === "jira" && (
            <>
              <Select
                label="Jira edition"
                value={credentials.edition}
                onValueChange={(value) => {
                  const next = jiraEditions.find((item) => item === value);
                  if (next) credential("edition")(next);
                }}
              >
                {jiraEditions.map((item) => (
                  <SelectItem key={item} value={item}>
                    {jiraEditionLabels[item]}
                  </SelectItem>
                ))}
              </Select>
              <Input
                label="Site URL"
                type="url"
                required
                placeholder={
                  credentials.edition === "cloud"
                    ? "https://example.atlassian.net"
                    : "https://jira.example.com"
                }
                value={credentials.baseUrl}
                onChange={(event) => credential("baseUrl")(event.target.value)}
              />
              {credentials.edition === "cloud" && (
                <Input
                  label="Account email"
                  type="email"
                  required
                  autoComplete="off"
                  value={credentials.email}
                  onChange={(event) => credential("email")(event.target.value)}
                />
              )}
            </>
          )}
          <Input
            label={
              kind === "linear"
                ? "API key"
                : credentials.edition === "cloud"
                  ? "API token"
                  : "Personal access token"
            }
            type="password"
            required
            autoComplete="off"
            value={credentials.token}
            onChange={(event) => credential("token")(event.target.value)}
          />
          <p className="-mt-2 mb-4 text-xs text-muted-foreground">{definition?.setup}</p>
          <ErrorNotice error={connect.error} />
          {projects && definition && (
            <>
              <Select
                label={definition.project}
                value={sourceProject}
                onValueChange={(value) => pick(projects.find((item) => item.ref === value))}
              >
                {projects.map((item) => (
                  <SelectItem key={item.ref} value={item.ref}>
                    {item.name}{" "}
                    <span className="font-mono text-xs text-muted-foreground">{item.key}</span>
                  </SelectItem>
                ))}
              </Select>
              {projects.length === 0 && (
                <p className="-mt-2 mb-4 text-sm text-muted-foreground">
                  These credentials cannot read any {definition.project.toLowerCase()}.
                </p>
              )}
              <Check
                label="Include comments"
                checked={includeComments}
                onCheckedChange={changed(setIncludeComments)}
              />
            </>
          )}
        </>
      )}
      <ErrorNotice error={fileError} />
      {chosen && (
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
        pending={connect.isPending || preview.isPending || start.isPending}
        submitLabel={ready ? "Import" : connecting ? "Connect" : "Preview"}
        pendingLabel={ready ? "Starting…" : connecting ? "Connecting…" : "Checking…"}
        submitDisabled={connecting ? false : !chosen || (!!run && !ready)}
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
