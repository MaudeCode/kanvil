import { createJiraReader } from "./jira.ts";
import { createLinearReader } from "./linear.ts";
import type { ImportSources } from "./ports.ts";
import type { SourceHttp } from "./source-bundle.ts";

// The trackers an import reads. `linearUrl` is the Linear GraphQL endpoint; Jira sites come with
// each request.
export function createImportSources(http: SourceHttp, linearUrl: string): ImportSources {
  const linear = createLinearReader(http, linearUrl),
    jira = createJiraReader(http);
  return {
    projects: (source) =>
      source.provider === "linear" ? linear.projects(source.token) : jira.projects(source),
    bundle: (source, project, { includeComments }) =>
      source.provider === "linear"
        ? linear.bundle(source.token, project, includeComments)
        : jira.bundle(source, project, includeComments),
  };
}
