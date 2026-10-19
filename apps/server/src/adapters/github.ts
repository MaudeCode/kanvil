import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { RepositoryTrigger } from "@kanvil/contracts";
import type { RemoteComment, RemoteIssue, RepositoryChange, RepositoryDriver } from "./ports.ts";

// Compares a received secret or signature without leaking its length or content through timing.
export const sameSecret = (received: string, expected: string) =>
  timingSafeEqual(
    createHash("sha256").update(received).digest(),
    createHash("sha256").update(expected).digest(),
  );
export const hmacHex = (secret: string, body: string) =>
  createHmac("sha256", secret).update(body).digest("hex");

// The parts of GitHub-format webhook payloads Kanvil reads; everything else is ignored. Gitea sends
// the same shape.
const repository = z.object({ full_name: z.string(), html_url: z.url({ protocol: /^https?$/ }) });
const reference = z.object({ ref: z.string().min(1), ref_type: z.string(), repository });
const item = {
  number: z.number().int().positive(),
  html_url: z.url({ protocol: /^https?$/ }),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  updated_at: z.iso.datetime({ offset: true }),
};
const pullRequest = z.object({
  action: z.string(),
  pull_request: z.object({
    ...item,
    draft: z.boolean().default(false),
    merged: z.boolean().nullish(),
    merged_at: z.string().nullish(),
    head: z.object({ ref: z.string() }),
  }),
  changes: z.object({ title: z.object({ from: z.string() }).optional() }).optional(),
  repository,
});
const issueFields = z.object({
  ...item,
  body: z.string().nullish(),
  labels: z.array(z.object({ name: z.string() })).nullish(),
  // Present on the issue side of a pull request.
  pull_request: z.unknown().optional(),
});
const issue = z.object({ action: z.string(), issue: issueFields, repository });
const issueComment = z.object({
  action: z.string(),
  issue: issueFields,
  comment: z.object({
    id: z.union([z.number(), z.string()]),
    body: z.string().nullish(),
    user: z.object({ login: z.string() }).nullish(),
    created_at: z.iso.datetime({ offset: true }).nullish(),
  }),
  // Gitea marks comments on pull requests here.
  is_pull: z.boolean().optional(),
  repository,
});
// An issue in GitHub's format, from a webhook or an API response; Gitea sends the same shape.
export const githubIssue = (found: z.output<typeof issueFields>): RemoteIssue => ({
  number: found.number,
  url: found.html_url,
  title: found.title,
  description: found.body ?? "",
  open: found.state === "open",
  labels: (found.labels ?? []).map((label) => label.name),
  updatedAt: new Date(found.updated_at),
});
// Issue actions that change what sync reads; Gitea reports label edits as `label_updated` and
// `label_cleared`.
const issueActions = [
  "opened",
  "edited",
  "closed",
  "reopened",
  "labeled",
  "unlabeled",
  "label_updated",
  "label_cleared",
];
// The issue an `issues` event reports, or null for pull requests and other actions.
export function githubIssueEvent(event: string, payload: unknown): RemoteIssue | null {
  if (event !== "issues") return null;
  const parsed = issue.parse(payload);
  return parsed.issue.pull_request || !issueActions.includes(parsed.action)
    ? null
    : githubIssue(parsed.issue);
}
// A comment an `issue_comment` event creates on an issue.
export function githubComment(event: string, payload: unknown): RemoteComment | null {
  if (event !== "issue_comment") return null;
  const parsed = issueComment.parse(payload);
  if (parsed.action !== "created" || parsed.issue.pull_request || parsed.is_pull) return null;
  return {
    id: String(parsed.comment.id),
    issue: parsed.issue.number,
    body: parsed.comment.body ?? "",
    author: parsed.comment.user?.login ?? "",
    createdAt: parsed.comment.created_at ? new Date(parsed.comment.created_at) : null,
  };
}
export const readGitHubIssue = (body: string) => githubIssue(issueFields.parse(JSON.parse(body)));
// Issue writes in GitHub's format; Gitea's API takes the same fields.
export const githubIssueBody = (changes: {
  title?: string;
  description?: string;
  open?: boolean;
}) =>
  JSON.stringify({
    ...(changes.title !== undefined && { title: changes.title }),
    ...(changes.description !== undefined && { body: changes.description }),
    ...(changes.open !== undefined && { state: changes.open ? "open" : "closed" }),
  });
const pullRequestTriggers: Record<string, (draft: boolean) => RepositoryTrigger> = {
  opened: (draft) => (draft ? "pull_request_draft" : "pull_request_opened"),
  reopened: (draft) => (draft ? "pull_request_draft" : "pull_request_opened"),
  ready_for_review: () => "pull_request_opened",
  converted_to_draft: () => "pull_request_draft",
};
// Gitea's default work-in-progress title prefixes, which are how it marks a draft.
const workInProgress = (title: string) => /^\s*(?:wip:|\[wip\])/i.test(title);

export const githubNamed = (payload: unknown) =>
  z.object({ repository: repository.optional() }).parse(payload).repository?.full_name ?? null;
// Reads signed `create`, `delete`, `pull_request`, and `issues` events. `branchPath` is the web path
// of a branch under the repository; `titleDrafts` treats a WIP title prefix as a draft, so an edit
// that adds or removes it converts the pull request.
export function githubChange(
  event: string,
  payload: unknown,
  { branchPath = "tree", titleDrafts = false } = {},
): RepositoryChange | null {
  if (event === "create" || event === "delete") {
    const parsed = reference.parse(payload);
    if (parsed.ref_type !== "branch") return null;
    const name = parsed.ref.replace(/^refs\/heads\//, "");
    const path = name.split("/").map(encodeURIComponent).join("/");
    return {
      kind: "branch",
      url: `${parsed.repository.html_url}/${branchPath}/${path}`,
      title: name,
      number: null,
      state: event === "create" ? "active" : "deleted",
      trigger: event === "create" ? "branch_created" : null,
      references: [name],
      occurredAt: null,
      creates: event === "create",
    };
  }
  if (event === "pull_request") {
    const { action, pull_request: pr, changes } = pullRequest.parse(payload);
    const merged = !!(pr.merged ?? pr.merged_at),
      draft = pr.draft || (titleDrafts && workInProgress(pr.title));
    if (action !== "closed" && action !== "edited" && !pullRequestTriggers[action]) return null;
    const retitled =
      titleDrafts &&
      action === "edited" &&
      changes?.title &&
      workInProgress(changes.title.from) !== draft;
    return {
      kind: "pull_request",
      url: pr.html_url,
      title: pr.title,
      number: pr.number,
      state: merged ? "merged" : pr.state === "closed" ? "closed" : draft ? "draft" : "open",
      trigger:
        action === "closed"
          ? merged
            ? "pull_request_merged"
            : "pull_request_closed"
          : retitled
            ? draft
              ? "pull_request_draft"
              : "pull_request_opened"
            : (pullRequestTriggers[action]?.(draft) ?? null),
      references: [pr.head.ref, pr.title],
      occurredAt: new Date(pr.updated_at),
      creates: true,
    };
  }
  if (event === "issues") {
    const { action, issue: found } = issue.parse(payload);
    if (!issueActions.includes(action)) return null;
    return {
      kind: "issue",
      url: found.html_url,
      title: found.title,
      number: found.number,
      state: found.state,
      trigger: null,
      references: [found.title],
      occurredAt: new Date(found.updated_at),
      creates: true,
    };
  }
  return null;
}

const headers = (token: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
});
// `apiUrl` is operator configuration (GitHub Enterprise Server uses its own), never request data.
export function createGitHubDriver(apiUrl: string): RepositoryDriver {
  const api = (path: string) => new URL(path, apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`).href;
  return {
    signed: (secret, received, body) =>
      sameSecret(received.get("x-hub-signature-256") ?? "", `sha256=${hmacHex(secret, body)}`),
    read(received, body) {
      const id = received.get("x-github-delivery"),
        event = received.get("x-github-event");
      if (!id || !event) throw new Error("Missing GitHub delivery headers");
      const payload: unknown = JSON.parse(body);
      return {
        id,
        event,
        repository: githubNamed(payload),
        change: githubChange(event, payload),
        issue: githubIssueEvent(event, payload),
        comment: githubComment(event, payload),
      };
    },
    access: ({ repository: name }, token) => ({
      method: "GET",
      url: api(`repos/${name}`),
      headers: headers(token),
      body: "",
    }),
    comment: ({ repository: name }, token, { number }, text) => ({
      url: api(`repos/${name}/issues/${number}/comments`),
      headers: headers(token),
      body: JSON.stringify({ body: text }),
      read: true,
    }),
    createIssue: ({ repository: name }, token, content) => ({
      url: api(`repos/${name}/issues`),
      headers: headers(token),
      body: githubIssueBody(content),
      read: true,
    }),
    updateIssue: ({ repository: name }, token, number, changes) => ({
      method: "PATCH",
      url: api(`repos/${name}/issues/${number}`),
      headers: headers(token),
      body: githubIssueBody(changes),
      read: true,
    }),
    issue: readGitHubIssue,
  };
}
