import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { RepositoryTrigger } from "@kanvil/contracts";
import type { RepositoryChange, RepositoryDriver } from "./ports.ts";

// The parts of GitHub webhook payloads Kanvil reads; everything else is ignored.
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
  repository,
});
const issue = z.object({ action: z.string(), issue: z.object(item), repository });
const pullRequestTriggers: Record<string, (draft: boolean) => RepositoryTrigger> = {
  opened: (draft) => (draft ? "pull_request_draft" : "pull_request_opened"),
  reopened: (draft) => (draft ? "pull_request_draft" : "pull_request_opened"),
  ready_for_review: () => "pull_request_opened",
  converted_to_draft: () => "pull_request_draft",
};

// Reads GitHub's signed `create`, `delete`, `pull_request`, and `issues` events.
function change(event: string, payload: unknown): RepositoryChange | null {
  if (event === "create" || event === "delete") {
    const parsed = reference.parse(payload);
    if (parsed.ref_type !== "branch") return null;
    const path = parsed.ref.split("/").map(encodeURIComponent).join("/");
    return {
      kind: "branch",
      url: `${parsed.repository.html_url}/tree/${path}`,
      title: parsed.ref,
      number: null,
      state: event === "create" ? "active" : "deleted",
      trigger: event === "create" ? "branch_created" : null,
      references: [parsed.ref],
      occurredAt: null,
      creates: event === "create",
    };
  }
  if (event === "pull_request") {
    const { action, pull_request: pr } = pullRequest.parse(payload);
    const merged = !!(pr.merged ?? pr.merged_at);
    if (action !== "closed" && action !== "edited" && !pullRequestTriggers[action]) return null;
    return {
      kind: "pull_request",
      url: pr.html_url,
      title: pr.title,
      number: pr.number,
      state: merged ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open",
      trigger:
        action === "closed"
          ? merged
            ? "pull_request_merged"
            : "pull_request_closed"
          : (pullRequestTriggers[action]?.(pr.draft) ?? null),
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
    signed(secret, received, body) {
      const signature = Buffer.from(received.get("x-hub-signature-256") ?? ""),
        expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
      return signature.length === expected.length && timingSafeEqual(signature, expected);
    },
    read(received, body) {
      const id = received.get("x-github-delivery"),
        event = received.get("x-github-event");
      if (!id || !event) throw new Error("Missing GitHub delivery headers");
      const payload: unknown = JSON.parse(body);
      const named = z.object({ repository: repository.optional() }).parse(payload);
      return {
        id,
        event,
        repository: named.repository?.full_name ?? null,
        change: change(event, payload),
      };
    },
    access: (name, token) => ({
      method: "GET",
      url: api(`repos/${name}`),
      headers: headers(token),
      body: "",
    }),
    comment: (name, token, number, text) => ({
      url: api(`repos/${name}/issues/${number}/comments`),
      headers: headers(token),
      body: JSON.stringify({ body: text }),
    }),
  };
}
