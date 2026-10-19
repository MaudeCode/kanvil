import { DeliveryError } from "./outbound.ts";
import {
  githubChange,
  githubComment,
  githubIssueBody,
  githubIssueEvent,
  githubNamed,
  hmacHex,
  readGitHubIssue,
  sameSecret,
} from "./github.ts";
import type { RepositoryDriver, RepositoryTarget } from "./ports.ts";

// The instance URL is the connection's own; the outbox's sender refuses private addresses unless
// the operator allows them, so a saved URL cannot reach an internal host.
export const instanceApi = ({ baseUrl }: RepositoryTarget, path: string) => {
  if (!baseUrl) throw new DeliveryError("invalid_endpoint", false);
  return `${baseUrl}/${path}`;
};
const headers = (token: string) => ({
  Accept: "application/json",
  Authorization: `token ${token}`,
});
// Gitea (and Forgejo, which sends the same headers) signs the raw body with HMAC-SHA256 in hex and
// sends GitHub-format payloads; drafts are pull requests whose title starts with a WIP prefix.
export function createGiteaDriver(): RepositoryDriver {
  return {
    signed: (secret, received, body) =>
      sameSecret(received.get("x-gitea-signature") ?? "", hmacHex(secret, body)),
    read(received, body) {
      const id = received.get("x-gitea-delivery"),
        sent = received.get("x-gitea-event");
      if (!id || !sent) throw new Error("Missing Gitea delivery headers");
      // Label edits arrive as their own event with the `issues` payload.
      const event = sent === "issue_label" ? "issues" : sent;
      const payload: unknown = JSON.parse(body);
      return {
        id,
        event,
        repository: githubNamed(payload),
        change: githubChange(event, payload, { branchPath: "src/branch", titleDrafts: true }),
        issue: githubIssueEvent(event, payload),
        comment: githubComment(event, payload),
      };
    },
    access: (target, token) => ({
      method: "GET",
      url: instanceApi(target, `api/v1/repos/${target.repository}`),
      headers: headers(token),
      body: "",
    }),
    // Pull requests take comments on the issue endpoint too.
    comment: (target, token, { number }, text) => ({
      url: instanceApi(target, `api/v1/repos/${target.repository}/issues/${number}/comments`),
      headers: headers(token),
      body: JSON.stringify({ body: text }),
      read: true,
    }),
    createIssue: (target, token, content) => ({
      url: instanceApi(target, `api/v1/repos/${target.repository}/issues`),
      headers: headers(token),
      body: githubIssueBody(content),
      read: true,
    }),
    updateIssue: (target, token, number, changes) => ({
      method: "PATCH",
      url: instanceApi(target, `api/v1/repos/${target.repository}/issues/${number}`),
      headers: headers(token),
      body: githubIssueBody(changes),
      read: true,
    }),
    issue: readGitHubIssue,
  };
}
