import { useState } from "react";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { useQuery } from "@tanstack/react-query";
import {
  importProviders,
  importProviderDefinitions,
  importSourceSchema,
  importStatusLabels,
  ticketImportSchema,
  type ImportRun,
  type ImportSourceProject,
  type TicketExport,
} from "@kanvil/contracts";
import { noCredentials, sourceFields } from "@kanvil/contracts/configuration";
import { formatNumber, t } from "@kanvil/contracts/i18n";
import { useConnection, useOperation } from "./data.tsx";
import {
  Body,
  Button,
  Check,
  Choice,
  ErrorNotice,
  Field,
  Loading,
  Row,
  Screen,
  Section,
} from "./ui.tsx";
import type { ScreenProps } from "./navigation.ts";

export function ImportProject({ route, navigation }: ScreenProps<"Import">) {
  const { workspaceId } = route.params,
    { api } = useConnection();
  const kinds = ["file", ...importProviders] as const;
  const [kind, setKind] = useState<(typeof kinds)[number]>("file"),
    [credentials, setCredentials] = useState(noCredentials),
    [projects, setProjects] = useState<ImportSourceProject[]>([]),
    [sourceProject, setSourceProject] = useState(""),
    [name, setName] = useState(""),
    [key, setKey] = useState(""),
    [includeComments, setIncludeComments] = useState(true),
    [visibility, setVisibility] = useState<"workspace" | "private">("private"),
    [bundle, setBundle] = useState<TicketExport>(),
    [runId, setRunId] = useState<string>(),
    [error, setError] = useState<unknown>();
  const connect = useOperation("list_import_source_projects"),
    previewFile = useOperation("preview_import"),
    previewSource = useOperation("preview_source_import"),
    start = useOperation("start_import"),
    cancel = useOperation("cancel_import");
  const history = useQuery({
    ...api.query("list_imports", { workspaceId }),
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === "running") ? 1500 : false,
  });
  const run = useQuery({
    ...api.query("get_import", { workspaceId, importId: runId ?? "" }),
    enabled: !!runId,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 1000 : false),
  });
  const pending =
    connect.isPending ||
    previewFile.isPending ||
    previewSource.isPending ||
    start.isPending ||
    cancel.isPending;
  function source() {
    if (kind === "file") throw new Error(t("admin.import.source"));
    return importSourceSchema.parse({
      provider: kind,
      ...Object.fromEntries(
        sourceFields[kind](credentials).map((field) => [field.name, credentials[field.name]]),
      ),
    });
  }
  async function chooseFile() {
    setError(undefined);
    setBundle(undefined);
    setRunId(undefined);
    try {
      const selected = await DocumentPicker.getDocumentAsync({
        type: "application/json",
        copyToCacheDirectory: true,
      });
      const asset = selected.canceled ? undefined : selected.assets[0];
      if (!asset) return;
      const file = new File(asset.uri);
      try {
        const parsed = ticketImportSchema.parse(JSON.parse(await file.text()));
        setBundle(parsed);
        setName(parsed.project.name);
        setKey(parsed.project.key);
      } finally {
        if (file.exists) file.delete();
      }
    } catch (cause) {
      setError(cause instanceof SyntaxError ? new Error(t("admin.import.notExport")) : cause);
    }
  }
  function preview() {
    setError(undefined);
    try {
      const promise =
        kind === "file" && bundle
          ? previewFile.mutateAsync({ workspaceId, name, key, visibility, bundle })
          : previewSource.mutateAsync({
              workspaceId,
              name,
              key,
              visibility,
              source: source(),
              sourceProject,
              includeComments,
            });
      void promise
        .then((staged) => {
          setRunId(staged.id);
          setCredentials(noCredentials);
        })
        .catch(() => {});
    } catch (cause) {
      setError(cause);
    }
  }
  return (
    <Screen>
      <Choice
        label={t("admin.import.source")}
        value={kind}
        options={kinds.map((value) => ({
          value,
          label:
            value === "file"
              ? t("admin.import.exportFile")
              : importProviderDefinitions[value].label,
        }))}
        onChange={(value) => {
          const next = kinds.find((item) => item === value);
          if (next) {
            setKind(next);
            setCredentials(noCredentials);
            setProjects([]);
            setSourceProject("");
            setBundle(undefined);
            setRunId(undefined);
          }
        }}
      />
      {kind === "file" ? (
        <Button
          title={t("admin.import.file")}
          disabled={pending}
          onPress={() => {
            void chooseFile();
          }}
        />
      ) : (
        <>
          {sourceFields[kind](credentials).map((field) =>
            field.choices ? (
              <Choice
                key={field.name}
                label={field.label}
                value={credentials[field.name]}
                options={Object.entries(field.choices).map(([value, label]) => ({ value, label }))}
                onChange={(value) => {
                  setCredentials((previous) => ({ ...previous, [field.name]: value }));
                  setRunId(undefined);
                  setProjects([]);
                }}
              />
            ) : (
              <Field
                key={field.name}
                label={field.label}
                value={credentials[field.name]}
                onChangeText={(value) => {
                  setCredentials((previous) => ({ ...previous, [field.name]: value }));
                  setRunId(undefined);
                  setProjects([]);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={field.type === "password"}
                keyboardType={
                  field.type === "email"
                    ? "email-address"
                    : field.type === "url"
                      ? "url"
                      : "default"
                }
                {...(field.placeholder ? { placeholder: field.placeholder } : {})}
              />
            ),
          )}
          <Button
            title={t("admin.import.checkConnection")}
            disabled={pending}
            onPress={() => {
              try {
                void connect
                  .mutateAsync({ workspaceId, source: source() })
                  .then(setProjects)
                  .catch(() => {});
              } catch (cause) {
                setError(cause);
              }
            }}
          />
          {!!projects.length && (
            <Choice
              label={importProviderDefinitions[kind].project}
              value={sourceProject}
              options={[
                { value: "", label: t("admin.import.source") },
                ...projects.map((project) => ({ value: project.ref, label: project.name })),
              ]}
              onChange={(value) => {
                setSourceProject(value);
                const project = projects.find((item) => item.ref === value);
                if (project) {
                  setName(project.name);
                  setKey(project.key.toUpperCase());
                }
                setRunId(undefined);
              }}
            />
          )}
          <Check
            label={t("admin.import.includeComments")}
            checked={includeComments}
            onChange={(value) => {
              setIncludeComments(value);
              setRunId(undefined);
            }}
          />
        </>
      )}
      <Field
        label={t("admin.import.projectName")}
        value={name}
        onChangeText={(value) => {
          setName(value);
          setRunId(undefined);
        }}
        maxLength={120}
      />
      <Field
        label={t("native.projects.prefix")}
        value={key}
        onChangeText={(value) => {
          setKey(value.toUpperCase());
          setRunId(undefined);
        }}
        maxLength={10}
        autoCapitalize="characters"
        autoCorrect={false}
      />
      <Choice
        label={t("settings.project.access")}
        value={visibility}
        options={[
          { value: "private", label: t("settings.project.visibility.private") },
          { value: "workspace", label: t("settings.project.visibility.workspace") },
        ]}
        onChange={(value) => {
          setVisibility(value === "workspace" ? "workspace" : "private");
          setRunId(undefined);
        }}
      />
      <ErrorNotice
        error={
          error ??
          connect.error ??
          previewFile.error ??
          previewSource.error ??
          start.error ??
          cancel.error ??
          run.error
        }
      />
      {!runId && (
        <Button
          title={t("admin.import.previewLabel")}
          primary
          disabled={
            pending ||
            !name.trim() ||
            !/^[A-Z][A-Z0-9]{1,9}$/.test(key) ||
            (kind === "file" ? !bundle : !sourceProject)
          }
          onPress={preview}
        />
      )}
      {runId && !run.data && <Loading />}
      {run.data && (
        <ImportDetails
          run={run.data}
          onStart={() => {
            if (run.data)
              void start
                .mutateAsync({
                  workspaceId,
                  importId: run.data.id,
                  expectedVersion: run.data.version,
                })
                .catch(() => {});
          }}
          onStop={() => {
            if (run.data)
              cancel.mutate({
                workspaceId,
                importId: run.data.id,
                expectedVersion: run.data.version,
              });
          }}
          onOpen={(projectId) => navigation.navigate("Tickets", { projectId })}
          pending={pending}
        />
      )}
      <Section title={t("admin.import.title")}>
        {history.data?.map((item) => (
          <Row
            key={item.id}
            title={item.name}
            caption={importStatusLabels[item.status]}
            onPress={() => setRunId(item.id)}
          />
        ))}
        <ErrorNotice error={history.error} />
      </Section>
    </Screen>
  );
}

function ImportDetails({
  run,
  onStart,
  onStop,
  onOpen,
  pending,
}: {
  run: ImportRun;
  onStart: () => void;
  onStop: () => void;
  onOpen: (id: string) => void;
  pending: boolean;
}) {
  return (
    <Section title={t("admin.import.details")}>
      <Body>{importStatusLabels[run.status]}</Body>
      <Body>
        {t(run.progress.failed ? "admin.import.progressFailed" : "admin.import.progress", {
          done: formatNumber(run.progress.done),
          total: formatNumber(run.progress.total),
          failed: formatNumber(run.progress.failed),
        })}
      </Body>
      {run.issues.map((issue, index) => (
        <Body key={`${issue.code}:${index}`}>{issue.message}</Body>
      ))}
      {run.members.map((member) => (
        <Body key={member.ref}>
          {t("native.labelValue", {
            label: member.name,
            value: member.userId ? t("admin.import.matched") : t("admin.import.unmatched"),
          })}
        </Body>
      ))}
      {run.status === "previewed" && (
        <Button
          title={t("admin.import.start")}
          primary
          disabled={pending || run.issues.some((issue) => issue.severity === "error")}
          onPress={onStart}
        />
      )}
      {(run.status === "previewed" || run.status === "running") && (
        <Button title={t("admin.import.stop")} danger disabled={pending} onPress={onStop} />
      )}
      {run.errors.map((item, index) => (
        <Body key={`${item.kind}:${index}`}>
          {t("admin.import.notImported", { label: item.label, message: item.message })}
        </Body>
      ))}
      {run.projectId && (
        <Button
          title={t("admin.import.openProject")}
          onPress={() => {
            if (run.projectId) onOpen(run.projectId);
          }}
        />
      )}
    </Section>
  );
}
