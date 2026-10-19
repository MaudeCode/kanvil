import { z } from "zod";
import type { RepositoryTrigger } from "@kanvil/contracts";
import { instanceApi } from "./gitea.ts";
import { sameSecret } from "./github.ts";
import type { RepositoryChange, RepositoryDriver, RepositoryTarget } from "./ports.ts";

// The parts of GitLab webhook payloads Kanvil reads; everything else is ignored.
const project = z.object({
  path_with_namespace: z.string(),
  web_url: z.url({ protocol: /^https?$/ }),
});
const push = z.object({ ref: z.string(), before: z.string(), after: z.string(), project });
const item = {
  iid: z.number().int().positive(),
  url: z.url({ protocol: /^https?$/ }),
  title: z.string(),
  state: z.string(),
  // Missing on some older events, which count as edits.
  action: z.string().default("update"),
  updated_at: z.string(),
};
const mergeRequest = z.object({
  object_attributes: z.object({
    ...item,
    draft: z.boolean().optional(),
    work_in_progress: z.boolean().optional(),
    source_branch: z.string(),
  }),
  changes: z.object({ draft: z.object({ current: z.boolean() }).optional() }).optional(),
  project,
});
const issue = z.object({ object_attributes: z.object(item), project });
const absent = /^0+$/;
// GitLab sends ISO 8601 times, and `YYYY-MM-DD HH:MM:SS UTC` on older versions. An unreadable time
// counts as receipt time.
function hostTime(value: string) {
  const time = new Date(value.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC$/, "$1T$2Z"));
  return Number.isNaN(time.getTime()) ? null : time;
}
const mergeRequestTriggers: Record<string, (draft: boolean) => RepositoryTrigger> = {
  open: (draft) => (draft ? "pull_request_draft" : "pull_request_opened"),
  reopen: (draft) => (draft ? "pull_request_draft" : "pull_request_opened"),
  merge: () => "pull_request_merged",
  close: () => "pull_request_closed",
};

// Reads push (branch creation and deletion), merge request, and issue events by `object_kind`.
function change(payload: unknown): RepositoryChange | null {
  const kind = z.object({ object_kind: z.string() }).parse(payload).object_kind;
  if (kind === "push") {
    const parsed = push.parse(payload);
    const created = absent.test(parsed.before),
      deleted = absent.test(parsed.after);
    // Commits to an existing branch are not branch lifecycle events.
    if (!parsed.ref.startsWith("refs/heads/") || created === deleted) return null;
    const name = parsed.ref.slice("refs/heads/".length);
    return {
      kind: "branch",
      url: `${parsed.project.web_url}/-/tree/${name.split("/").map(encodeURIComponent).join("/")}`,
      title: name,
      number: null,
      state: created ? "active" : "deleted",
      trigger: created ? "branch_created" : null,
      references: [name],
      occurredAt: null,
      creates: created,
    };
  }
  if (kind === "merge_request") {
    const { object_attributes: mr, changes } = mergeRequest.parse(payload);
    const draft = mr.draft ?? mr.work_in_progress ?? false;
    // An update counts only when it marks the merge request draft or ready.
    if (mr.action !== "update" && !mergeRequestTriggers[mr.action]) return null;
    return {
      kind: "pull_request",
      url: mr.url,
      title: mr.title,
      number: mr.iid,
      // `locked` is the brief state while a merge runs.
      state: mr.state === "merged" || mr.state === "closed" ? mr.state : draft ? "draft" : "open",
      trigger:
        mr.action === "update"
          ? changes?.draft
            ? changes.draft.current
              ? "pull_request_draft"
              : "pull_request_opened"
            : null
          : (mergeRequestTriggers[mr.action]?.(draft) ?? null),
      references: [mr.source_branch, mr.title],
      occurredAt: hostTime(mr.updated_at),
      creates: true,
    };
  }
  if (kind === "issue") {
    const { object_attributes: found } = issue.parse(payload);
    if (!["open", "update", "close", "reopen"].includes(found.action)) return null;
    return {
      kind: "issue",
      url: found.url,
      title: found.title,
      number: found.iid,
      state: found.state === "opened" ? "open" : found.state,
      trigger: null,
      references: [found.title],
      occurredAt: hostTime(found.updated_at),
      creates: true,
    };
  }
  return null;
}

const headers = (token: string) => ({ Accept: "application/json", "PRIVATE-TOKEN": token });
const projectApi = (target: RepositoryTarget, path = "") =>
  instanceApi(target, `api/v4/projects/${encodeURIComponent(target.repository)}${path}`);
// Personal, group, and project access tokens all authenticate with PRIVATE-TOKEN. GitLab sends the
// webhook's secret token itself in X-Gitlab-Token rather than a signature.
export function createGitLabDriver(): RepositoryDriver {
  return {
    signed: (secret, received) => sameSecret(received.get("x-gitlab-token") ?? "", secret),
    read(received, body) {
      // `Idempotency-Key` stays the same across retries; older versions only send the event UUID.
      const id = received.get("idempotency-key") ?? received.get("x-gitlab-event-uuid"),
        event = received.get("x-gitlab-event");
      if (!id || !event) throw new Error("Missing GitLab delivery headers");
      const payload: unknown = JSON.parse(body);
      const named = z.object({ project: project.partial().optional() }).parse(payload);
      return {
        id,
        event,
        repository: named.project?.path_with_namespace ?? null,
        change: change(payload),
      };
    },
    access: (target, token) => ({
      method: "GET",
      url: projectApi(target),
      headers: headers(token),
      body: "",
    }),
    comment: (target, token, { kind, number }, text) => ({
      url: projectApi(
        target,
        `/${kind === "pull_request" ? "merge_requests" : "issues"}/${number}/notes`,
      ),
      headers: headers(token),
      body: JSON.stringify({ body: text }),
    }),
  };
}
