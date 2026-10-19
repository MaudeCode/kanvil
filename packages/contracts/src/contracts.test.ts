import { describe, expect, it } from "vite-plus/test";
import {
  eventCategories,
  mentionLink,
  infoSchema,
  notificationPreferencesSchema,
  notificationsSchema,
  formatEvent,
  operations,
  parseRelationChoice,
  relationChoices,
  resourceHost,
  resourceProvider,
  ticketFilter,
  ticketPredicates,
  ticketFields,
  ticketSchema,
} from "./index.ts";
import { ticketDraftSchema } from "./drafts.ts";

describe("agent write contracts", () => {
  it("shares relationship choices without changing legacy mutation receipt payloads", () => {
    const legacy = {
      projectId: "p",
      ticketId: "t",
      targetId: "10000000-0000-4000-8000-000000000001",
      type: "blocks",
    };
    expect(operations.add_relation.input.parse(legacy)).toEqual(legacy);
    for (const choice of relationChoices)
      expect(parseRelationChoice(choice.value)).toEqual({
        type: choice.type,
        direction: choice.direction,
      });
    expect(() => parseRelationChoice("unknown:incoming")).toThrow();
    expect(() => parseRelationChoice("blocks:wrong")).toThrow();
  });
  it("formats historical and current event context consistently", () => {
    const event = {
      id: "1",
      projectId: "10000000-0000-4000-8000-000000000001",
      ticketId: "10000000-0000-4000-8000-000000000002",
      actorId: "a",
      type: "ticket.updated",
      createdAt: new Date().toISOString(),
      data: {},
    };
    expect(formatEvent(event)).toBe("Ticket updated");
    expect(formatEvent(event, true)).toBe(`Ticket updated · ${event.ticketId}`);
    expect(formatEvent({ ...event, data: { key: "KAN-1", title: "A complete title" } }, true)).toBe(
      "Ticket updated · KAN-1 · A complete title",
    );
  });
  it("preserves a full descriptive title and deduplicates labels", () => {
    const title =
      "Preserve reconnect checkpoints when independent agents change a ticket's blockers";
    const value = operations.create_ticket.input.parse({
      projectId: "project",
      title,
      labels: ["runtime", "runtime"],
    });
    expect(value.title).toBe(title);
    expect(value.labels).toEqual(["runtime"]);
    expect(value.automationReady).toBe(false);
  });
  it("rejects forged attribution and empty updates", () => {
    expect(
      operations.create_ticket.input.safeParse({
        projectId: "p",
        title: "A",
        createdBy: "another-user",
      }).success,
    ).toBe(false);
    expect(
      operations.update_ticket.input.safeParse({
        projectId: "p",
        ticketId: "t",
        expectedVersion: 1,
        changes: {},
      }).success,
    ).toBe(false);
    expect(
      operations.update_ticket.input.safeParse({
        projectId: "p",
        ticketId: "t",
        expectedVersion: 0,
        changes: { title: "A" },
      }).success,
    ).toBe(false);
  });
  it("keeps titles on one logical line across create and update operations", () => {
    const title = "  Keep\ncomplete\r\nrequirements\treadable\u2028across\u2029clients  ";
    const normalized = "Keep complete requirements readable across clients";
    expect(operations.create_ticket.input.parse({ projectId: "p", title }).title).toBe(normalized);
    expect(
      operations.update_ticket.input.parse({
        projectId: "p",
        ticketId: "t",
        expectedVersion: 1,
        changes: { title },
      }).changes.title,
    ).toBe(normalized);
    expect(
      operations.create_ticket.input.safeParse({ projectId: "p", title: " \n\r\n " }).success,
    ).toBe(false);
  });
  it("rejects duplicate tickets in an atomic bulk edit and unbounded searches", () => {
    expect(
      operations.bulk_update_tickets.input.safeParse({
        projectId: "p",
        tickets: [
          { ticketId: "t", expectedVersion: 1 },
          { ticketId: "t", expectedVersion: 1 },
        ],
        changes: { priority: "high" },
      }).success,
    ).toBe(false);
    expect(
      operations.list_tickets.input.safeParse({ projectId: "p", limit: 1_000_000 }).success,
    ).toBe(false);
  });
  it("requires explicit stopped-worker confirmation to recover ownership", () => {
    expect(
      operations.recover_claim.input.safeParse({
        projectId: "p",
        ticketId: "t",
        claimId: "10000000-0000-4000-8000-000000000000",
        reason: "Worker process has stopped",
      }).success,
    ).toBe(false);
  });
  it("rejects executable evidence URLs", () => {
    expect(
      operations.add_evidence.input.safeParse({
        projectId: "p",
        ticketId: "t",
        kind: "other",
        title: "Result",
        url: "javascript:alert(1)",
      }).success,
    ).toBe(false);
  });
});

it("reads tickets and drafts from before start dates and keeps edits partial", () => {
  const legacy = ticketSchema.parse({
    title: "Older server",
    description: "",
    acceptanceCriteria: "",
    status: "todo",
    priority: "none",
    kind: "feature",
    difficulty: null,
    labels: [],
    scopes: [],
    assigneeId: null,
    parentId: null,
    automationReady: false,
    holdReason: null,
    dueAt: null,
    archived: false,
    claimRequired: false,
    id: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
    projectId: "7f9619ff-8b86-4011-b42d-00c04fc964ff",
    key: "OLD-1",
    number: 1,
    version: 1,
    createdBy: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  expect(legacy.startAt).toBeNull();
  // A draft saved before start dates existed still opens.
  const draft = ticketDraftSchema.parse({
    fields: ticketFields.strip().omit({ startAt: true }).parse(legacy),
  });
  expect(draft.fields.startAt).toBeNull();
  // A change that names only the due date never clears the start date.
  const update = operations.update_ticket.input.parse({
    projectId: "p",
    ticketId: "t",
    expectedVersion: 1,
    changes: { dueAt: "2026-03-09T03:59:59.999Z" },
  });
  expect(update.changes).toEqual({ dueAt: "2026-03-09T03:59:59.999Z" });
  expect(() =>
    operations.list_tickets.input.parse({ projectId: "p", scheduledFrom: "next week" }),
  ).toThrow();
  // The secret is never replayable, so feed creation takes no requestId.
  expect(() =>
    operations.create_calendar_feed.input.parse({
      projectId: "p",
      name: "Feed",
      timeZone: "UTC",
      requestId: "8f9619ff-8b86-4011-b42d-00c04fc964ff",
    }),
  ).toThrow();
});
it("takes a requestId on every write except those returning a one-time secret", () => {
  // A replay receipt would store the secret, so these writes are the only ones without one.
  const unreplayable = Object.entries(operations)
    .filter(([, spec]) => spec.method !== "GET" && !("requestId" in spec.input.shape))
    .map(([name]) => name);
  expect(new Set(unreplayable)).toEqual(
    new Set(["create_calendar_feed", "create_invitation", "resend_invitation"]),
  );
});
it("defaults legacy public authentication capabilities for web and native clients", () => {
  const legacy = {
    name: "Kanvil",
    description: "",
    version: "0.1.0",
    setupRequired: false,
    push: false,
    oidc: null,
  };
  expect(infoSchema.parse(legacy).authentication).toEqual({
    emailPasswordEnabled: true,
    ssoAutoProvision: false,
  });
  expect(
    infoSchema.parse({
      ...legacy,
      authentication: { emailPasswordEnabled: false, ssoAutoProvision: true },
    }).authentication,
  ).toEqual({ emailPasswordEnabled: false, ssoAutoProvision: true });
});

describe("ticket filter predicates", () => {
  it("normalizes single and repeated values into one predicate catalog", () => {
    const filter = ticketFilter.parse({
      status: "todo",
      statusNot: ["done", "cancelled", "done"],
      label: ["red,blue", "O'Reilly"],
      assigneeId: "none",
    });
    expect(ticketPredicates(filter)).toEqual([
      { field: "status", operator: "any", values: ["todo"] },
      { field: "status", operator: "none", values: ["done", "cancelled"] },
      { field: "label", operator: "any", values: ["red,blue", "O'Reilly"] },
      { field: "assigneeId", operator: "any", values: ["none"] },
    ]);
    expect(ticketPredicates(ticketFilter.parse({}))).toEqual([]);
  });
  it("rejects conflicting, empty, unknown, and oversized filters", () => {
    expect(
      ticketFilter.safeParse({ priority: ["high"], priorityNot: "high" }).error?.issues,
    ).toEqual([
      expect.objectContaining({ message: "Priority cannot both include and exclude high" }),
    ]);
    expect(ticketFilter.safeParse({ status: [] }).success).toBe(false);
    expect(ticketFilter.safeParse({ status: ["todo", "shipped"] }).success).toBe(false);
    expect(
      ticketFilter.safeParse({ label: Array.from({ length: 26 }, (_, index) => `l${index}`) })
        .success,
    ).toBe(false);
    expect(
      operations.list_tickets.input.safeParse({ projectId: "p", kind: "bug", kindNot: ["bug"] })
        .success,
    ).toBe(false);
  });
  it("requires an edited field when updating a link", () => {
    const base = {
      projectId: "p",
      resourceId: "10000000-0000-4000-8000-000000000001",
      expectedVersion: 1,
    };
    expect(operations.update_resource.input.safeParse(base).success).toBe(false);
    expect(operations.update_resource.input.safeParse({ ...base, title: "" }).success).toBe(true);
  });
  it("names a link's provider only for an exact recognized host", () => {
    expect(resourceProvider("https://www.GitHub.com/org/repo/pull/1")).toBe("GitHub");
    expect(resourceProvider("https://user@gitlab.com:8443/group/project")).toBe("GitLab");
    expect(resourceHost("https://user@Docs.Example.test:8443/a?b#c")).toBe("docs.example.test");
    // Browsers treat a backslash as a path delimiter and split credentials at the last @.
    expect(resourceHost("https://evil.example.test\\@github.com/x")).toBe("evil.example.test");
    expect(resourceProvider("https://a@b@github.com/org/repo")).toBe("GitHub");
    expect(resourceHost("https://[::1]:8080/x")).toBe("[::1]");
    const hostile = `http://[${"@[".repeat(20_000)}`,
      started = Date.now();
    expect(resourceHost(hostile)).toBeNull();
    expect(Date.now() - started).toBeLessThan(100);
    for (const url of [
      "https://github.com.example.test/org/repo",
      "https://example.test/?next=https://github.com",
      "https://constructor/",
      "https://evil.example.test\\@github.com/org/repo",
    ])
      expect(resourceProvider(url)).toBeNull();
  });
});
const updated = (changedFields: string[]) => ({
  type: "ticket.updated",
  data: { changedFields },
});
describe("notification categories", () => {
  it("lists the most specific categories of an event first", () => {
    expect(eventCategories(updated(["status", "assigneeId", "title"]))).toEqual([
      "assignment",
      "status",
      "update",
    ]);
    expect(eventCategories(updated(["status"]))).toEqual(["status"]);
    expect(eventCategories(updated([]))).toEqual(["update"]);
    // A manual reorder alone reaches no one; a move that changes status still does.
    expect(eventCategories(updated(["position"]))).toEqual([]);
    expect(eventCategories(updated(["status", "position"]))).toEqual(["status"]);
    expect(eventCategories({ type: "comment.created", data: {} })).toEqual(["comment"]);
    expect(eventCategories({ type: "ticket.overdue", data: {} })).toEqual(["overdue"]);
    expect(eventCategories({ type: "relation.added", data: {} })).toEqual(["update"]);
  });
  it("reads older preferences and Inbox entries with every category enabled", () => {
    expect(notificationPreferencesSchema.parse({ inApp: false, push: true })).toEqual({
      inApp: false,
      push: true,
      categories: {
        assignment: true,
        status: true,
        comment: true,
        mention: true,
        update: true,
        due_soon: true,
        overdue: true,
      },
      reminderLead: { amount: 1, unit: "days" },
    });
    const event = {
      id: "1",
      projectId: "10000000-0000-4000-8000-000000000001",
      ticketId: null,
      actorId: null,
      type: "ticket.overdue",
      data: {},
      createdAt: "2026-10-19T00:00:00.000Z",
    };
    expect(
      notificationsSchema
        .parse([
          { id: "10000000-0000-4000-8000-000000000002", readAt: null, event },
          {
            id: "10000000-0000-4000-8000-000000000003",
            readAt: null,
            category: "mentions",
            event,
          },
        ])
        .map((item) => item.category),
    ).toEqual(["update", "update"]);
  });
});
describe("mentions", () => {
  it("writes a Markdown link that still reads as the name", () => {
    expect(mentionLink("Ada Lovelace", "user_1")).toBe("[@Ada Lovelace](mention:user_1)");
    expect(mentionLink("[ops] \\ Ada", "user_2")).toBe("[@\\[ops\\] \\\\ Ada](mention:user_2)");
  });
});
