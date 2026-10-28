import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  capabilitiesOf,
  credentialInput,
  credentialProjectsSchema,
  operationPermission,
  roleCategory,
  roleId,
  workspaceSchema,
  customFieldFilterText,
  customFieldValueSchema,
  formatCustomFieldValue,
  eventCategories,
  mentionLink,
  memberName,
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
  ticketSummarySchema,
} from "./index.ts";
import { createTicketDraft, ticketDefaults, ticketDraftSchema } from "./drafts.ts";

// A minimal exported ticket, for bundles over the import limits.
const bigTicket = (index: number) => ({
  ref: `t${index}`,
  key: `BIG-${index}`,
  title: `Ticket ${index}`,
  description: "",
  acceptanceCriteria: "",
  priority: "medium",
  kind: "feature",
  difficulty: null,
  labels: [],
  scopes: [],
  automationReady: false,
  holdReason: null,
  startAt: null,
  dueAt: null,
  archived: false,
  stateRef: "todo",
});

describe("agent write contracts", () => {
  it("requires an explicit global or nonempty project scope when creating credentials", () => {
    const input = { name: "Consumer", scopes: ["read"] };
    expect(credentialInput.parse({ ...input, projectIds: null }).projectIds).toBeNull();
    const ids = ["10000000-0000-4000-8000-000000000001"];
    expect(credentialInput.parse({ ...input, projectIds: ids }).projectIds).toEqual(ids);
    for (const scope of [
      {},
      { projectIds: [] },
      { projectIds: "all" },
      { projectIds: ["invalid"] },
    ])
      expect(credentialInput.safeParse({ ...input, ...scope }).success).toBe(false);
    expect(credentialProjectsSchema.safeParse({}).success).toBe(false);
    expect(credentialProjectsSchema.parse({ projectIds: [] }).projectIds).toEqual([]);
  });
  it("preserves omitted time-entry patch fields and rejects server-owned values", () => {
    const subject = {
      projectId: "project",
      ticketId: "ticket",
      timeEntryId: "10000000-0000-4000-8000-000000000001",
      expectedVersion: 1,
    };
    expect(operations.update_time_entry.input.parse({ ...subject, note: "Observed" })).toEqual({
      ...subject,
      note: "Observed",
    });
    expect(operations.update_time_entry.input.parse({ ...subject, endAt: null })).toEqual({
      ...subject,
      endAt: null,
    });
    expect(() => operations.update_time_entry.input.parse(subject)).toThrow();
    for (const field of ["actorId", "durationMs", "version"])
      expect(() =>
        operations.create_time_entry.input.parse({
          projectId: "project",
          ticketId: "ticket",
          startAt: "2026-10-01T09:00:00.000Z",
          [field]: 1,
        }),
      ).toThrow();
  });
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
  it("names members, deleted accounts, and people who left", () => {
    const people = [{ userId: "member", name: "Morgan" }];
    expect(memberName(people, ["gone"], "member")).toBe("Morgan");
    expect(memberName(people, ["gone"], "gone")).toBe("Deleted account");
    expect(memberName(people, undefined, "gone")).toBe("Former member");
    expect(memberName(undefined, [], "left")).toBe("Former member");
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
  it("carries each selected ticket's worker claim through a bulk edit, HTTP, and MCP", () => {
    const claimId = "10000000-0000-4000-8000-000000000000";
    const changes = { priority: "high" as const };
    const tickets = [
      { ticketId: "a", expectedVersion: 2, claimId },
      { ticketId: "b", expectedVersion: 1 },
    ];
    expect(
      operations.bulk_update_tickets.input.parse({ projectId: "p", tickets, changes }).tickets,
    ).toEqual(tickets);
    expect(
      operations.bulk_update_tickets.input.safeParse({
        projectId: "p",
        tickets: [{ ticketId: "a", expectedVersion: 2, claimId: "not-a-claim" }],
        changes,
      }).success,
    ).toBe(false);
    const schema = z.toJSONSchema(operations.bulk_update_tickets.input, { io: "input" });
    expect(JSON.stringify(schema)).toContain('"claimId":{"type":"string","format":"uuid"');
  });
  it("leaves claim duration policy to the server and grants recovery through claim scope", () => {
    const input = {
      projectId: "p",
      ticketId: "t",
      workerId: "worker",
      expectedVersion: 1,
      claimId: "10000000-0000-4000-8000-000000000000",
    };
    for (const leaseSeconds of [86400, 172800]) {
      const { claimId, ...acquire } = input;
      expect(operations.claim_ticket.input.parse({ ...acquire, leaseSeconds }).leaseSeconds).toBe(
        leaseSeconds,
      );
      expect(
        operations.renew_claim.input.parse({ projectId: "p", ticketId: "t", claimId, leaseSeconds })
          .leaseSeconds,
      ).toBe(leaseSeconds);
    }
    expect(operations.recover_claim.scope).toBe("claim");
    expect(operationPermission("recover_claim")).toBe("ticket.write");
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
  it("requires a current version only for explicitly rescheduled recovery", () => {
    const input = {
      projectId: "p",
      ticketId: "t",
      claimId: "10000000-0000-4000-8000-000000000000",
      reason: "Worker process has stopped",
      confirmedStopped: true,
    };
    expect(operations.recover_claim.input.safeParse({ ...input, reschedule: true }).success).toBe(
      false,
    );
    expect(
      operations.recover_claim.input.safeParse({ ...input, reschedule: true, expectedVersion: 2 })
        .success,
    ).toBe(true);
    expect(operations.recover_claim.input.safeParse(input).success).toBe(true);
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

it("keeps whole tickets unless a ticket list or search asks for summary rows", () => {
  const ticket = ticketSchema.parse({
    title: "Whole ticket",
    description: "Body",
    acceptanceCriteria: "Criteria",
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
  const project = { id: ticket.projectId, key: "OLD", name: "Old" };
  expect(operations.list_tickets.input.parse({ projectId: "p" }).view).toBe("full");
  expect(operations.search_tickets.input.parse({ q: "x" }).view).toBe("full");
  expect(operations.search_workspace.input.parse({ q: "x" }).view).toBe("full");
  expect(operations.search_tickets.input.safeParse({ q: "x", view: "brief" }).success).toBe(false);
  expect(operations.list_tickets.output.parse({ items: [ticket], total: 1 }).items[0]).toEqual(
    ticket,
  );
  expect(operations.search_tickets.output.parse({ items: [{ ticket, project }] })).toEqual({
    items: [{ ticket, project }],
  });
  const summary = ticketSummarySchema.parse(ticket);
  expect(summary).not.toHaveProperty("description");
  expect(
    operations.search_tickets.output.parse({ items: [{ ticket: summary, project, snippet: "" }] })
      .items[0],
  ).toEqual({ ticket: summary, project, snippet: "" });
});
it("reads tickets and drafts from before start dates and workflows and keeps edits partial", () => {
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
  expect(legacy).toMatchObject({ startAt: null, stateId: null });
  // A draft saved before start dates and workflows existed still opens; its status decides.
  const draft = ticketDraftSchema.parse({
    fields: ticketFields.strip().omit({ startAt: true, stateId: true }).parse(legacy),
  });
  expect(draft.fields).toMatchObject({ startAt: null, stateId: null, status: "todo" });
  expect(createTicketDraft(legacy).fields.stateId).toBeNull();
  // A newer server's extra ticket fields are ignored rather than failing the whole read.
  expect(ticketSchema.parse({ ...legacy, futureField: true })).not.toHaveProperty("futureField");
  // Creation leaves the status open so a chosen state decides it.
  expect(
    operations.create_ticket.input.parse({
      projectId: "p",
      title: "Stateful",
      stateId: "8f9619ff-8b86-4011-b42d-00c04fc964ff",
    }),
  ).not.toHaveProperty("status");
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
it("takes a requestId on every write except those holding a one-time secret", () => {
  // A replay receipt would store the secret, so these writes are the only ones without one:
  // three return a secret, and listing a tracker's projects writes nothing to replay.
  const unreplayable = Object.entries(operations)
    .filter(([, spec]) => spec.method !== "GET" && !("requestId" in spec.input.shape))
    .map(([name]) => name);
  expect(new Set(unreplayable)).toEqual(
    new Set([
      "create_calendar_feed",
      "create_invitation",
      "resend_invitation",
      "list_import_source_projects",
    ]),
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
  expect(infoSchema.parse(legacy)).toMatchObject({ providers: [], emailCodes: false });
  expect(infoSchema.parse({ ...legacy, oidc: { id: "oidc", name: "PocketID" } }).providers).toEqual(
    [{ id: "oidc", name: "PocketID" }],
  );
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
const plain = (type: "text" | "number" | "date" | "checkbox") =>
  customFieldValueSchema({ type, options: [] });
describe("custom fields", () => {
  const high = "10000000-0000-4000-8000-000000000011",
    low = "10000000-0000-4000-8000-000000000012";
  const severity = {
    name: "Severity",
    type: "select" as const,
    options: [
      { id: high, name: "High", color: "red" as const },
      { id: low, name: "Low", color: "gray" as const },
    ],
  };
  it("narrows values to the field's type and reads empty values as none", () => {
    expect(customFieldValueSchema(severity).parse(high)).toBe(high);
    expect(
      customFieldValueSchema(severity).safeParse("10000000-0000-4000-8000-000000000099"),
    ).toMatchObject({ success: false });
    const areas = { ...severity, type: "multiselect" as const };
    expect(customFieldValueSchema(areas).parse([low, low])).toEqual([low]);
    expect(customFieldValueSchema(areas).parse([])).toBeNull();
    expect(plain("text").parse("  spaced  ")).toBe("spaced");
    expect(plain("text").parse("   ")).toBeNull();
    expect(plain("checkbox").parse(false)).toBeNull();
    expect(plain("number").safeParse("3").success).toBe(false);
    expect(plain("date").safeParse("2026-02-31").success).toBe(false);
    expect(plain("date").parse("2026-02-28")).toBe("2026-02-28");
  });
  it("formats values and filter choices the same way for every client", () => {
    expect(formatCustomFieldValue({ ...severity, type: "multiselect" }, [low, high])).toBe(
      "Low, High",
    );
    expect(formatCustomFieldValue(severity, "10000000-0000-4000-8000-000000000099")).toBe(
      "Removed option",
    );
    expect(formatCustomFieldValue({ type: "checkbox", options: [] }, true)).toBe("Yes");
    expect(formatCustomFieldValue(severity, undefined)).toBe("");
    expect(customFieldFilterText(severity, high)).toBe("Severity: High");
    expect(customFieldFilterText(severity, "none")).toBe("Severity: No value");
    expect(customFieldFilterText({ ...severity, type: "checkbox", options: [] }, "none")).toBe(
      "Severity: Not checked",
    );
  });
  it("keeps tickets and drafts from before custom fields readable", () => {
    const { customFields: _customFields, ...saved } = ticketDefaults;
    expect(ticketDraftSchema.parse({ fields: saved }).fields.customFields).toEqual({});
    expect(
      ticketFilter.safeParse({ customField: `${high}:${low}`, customFieldNot: `${high}:none` })
        .success,
    ).toBe(true);
    expect(ticketFilter.safeParse({ customField: "severity:high" }).success).toBe(false);
  });
  it("exports projects of any size while imports keep their collection limits", () => {
    const big = {
      format: "kanvil.tickets",
      version: 1,
      exportedAt: "2026-10-19T00:00:00.000Z",
      project: { ref: "p", key: "BIG", name: "Big" },
      workflow: [{ ref: "todo", name: "To do", category: "todo" }],
      tickets: Array.from({ length: 5001 }, (_, index) => bigTicket(index + 1)),
    };
    expect(operations.export_project.output.safeParse(big).success).toBe(true);
    expect(operations.preview_import.input.shape.bundle.safeParse(big).success).toBe(false);
  });
});

describe("roles and permissions", () => {
  it("reads workspaces from servers that predate custom roles", () => {
    const legacy = workspaceSchema.parse({
      id: "00000000-0000-4000-8000-000000000001",
      slug: "legacy",
      name: "Legacy",
      description: "",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      role: "writer",
    });
    expect(capabilitiesOf(legacy)).toEqual(["ticket.write"]);
    expect(capabilitiesOf({ role: "writer", capabilities: ["ticket.delete"] })).toEqual([
      "ticket.delete",
    ]);
    expect(capabilitiesOf({ role: null })).toEqual([]);
  });
  it("accepts seeded names and custom IDs as role IDs", () => {
    expect(roleId.safeParse("admin").success).toBe(true);
    expect(roleId.safeParse("00000000-0000-4000-8000-000000000001").success).toBe(true);
    expect(roleId.safeParse("owner").success).toBe(false);
  });
  it("projects a custom role onto a seeded one that never administers", () => {
    expect(roleCategory(["ticket.write", "member.manage"])).toBe("writer");
    expect(roleCategory(["project.manage", "workspace.manage"])).toBe("reader");
  });
  it("names the action every operation needs", () => {
    expect(operationPermission("get_ticket")).toBeNull();
    expect(operationPermission("claim_ticket")).toBe("ticket.write");
    expect(operationPermission("delete_ticket")).toBe("ticket.delete");
    expect(operationPermission("update_workflow_state")).toBe("project.manage");
    expect(operationPermission("set_member")).toBe("member.manage");
    expect(operationPermission("create_invitation")).toBe("invitation.manage");
    expect(operationPermission("create_calendar_feed")).toBe("sharing.manage");
    expect(operationPermission("update_workspace_label")).toBe("workspace.manage");
    expect(operationPermission("create_workspace_role")).toBe("workspace.manage");
    // Checked in the handler, which sees what changed.
    expect(operationPermission("update_project")).toBeNull();
  });
});
