import type { ImportSource, ImportSourceProject, TicketExport } from "@kanvil/contracts";
import { createJiraReader } from "./jira.ts";
import { createKaneoReader } from "./kaneo.ts";
import { createLinearReader } from "./linear.ts";
import { createPlaneReader } from "./plane.ts";
import { createPlankaReader } from "./planka.ts";
import { createTrelloReader } from "./trello.ts";
import type { ImportSources } from "./ports.ts";
import type { SourceHttp } from "./source-bundle.ts";

// The trackers an import reads. Linear and Trello serve one API, whose address is configured;
// every other source names its own site with each request.
export function createImportSources(
  http: SourceHttp,
  urls: { linear: string; trello: string },
): ImportSources {
  const linear = createLinearReader(http, urls.linear),
    jira = createJiraReader(http),
    trello = createTrelloReader(http, urls.trello),
    plane = createPlaneReader(http),
    planka = createPlankaReader(http),
    kaneo = createKaneoReader(http);
  // The reader of a source, holding its credentials.
  const reader = (
    source: ImportSource,
  ): {
    projects: () => Promise<ImportSourceProject[]>;
    bundle: (project: string, includeComments: boolean) => Promise<TicketExport>;
  } => {
    switch (source.provider) {
      case "linear":
        return {
          projects: () => linear.projects(source.token),
          bundle: (project, comments) => linear.bundle(source.token, project, comments),
        };
      case "jira":
        return {
          projects: () => jira.projects(source),
          bundle: (project, comments) => jira.bundle(source, project, comments),
        };
      case "trello":
        return {
          projects: () => trello.projects(source),
          bundle: (project, comments) => trello.bundle(source, project, comments),
        };
      case "plane":
        return {
          projects: () => plane.projects(source),
          bundle: (project, comments) => plane.bundle(source, project, comments),
        };
      case "planka":
        return {
          projects: () => planka.projects(source),
          bundle: (project, comments) => planka.bundle(source, project, comments),
        };
      // Kaneo; a new provider fails to type-check here.
      default:
        return {
          projects: () => kaneo.projects(source),
          bundle: (project, comments) => kaneo.bundle(source, project, comments),
        };
    }
  };
  return {
    projects: (source) => reader(source).projects(),
    bundle: (source, project, { includeComments }) =>
      reader(source).bundle(project, includeComments),
  };
}
