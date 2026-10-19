import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { RepositoryTrigger } from "@kanvil/contracts";
import type { RepositoryChange, RepositoryDriver } from "./ports.ts";

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
const issue = z.object({ action: z.string(), issue: z.object(item), repository });
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
    if (!["opened", "edited", "closed", "reopened"].includes(action)) return null;
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
      return { id, event, repository: githubNamed(payload), change: githubChange(event, payload) };
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
    }),
  };
}
