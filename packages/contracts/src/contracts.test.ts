import { describe, expect, it } from "vite-plus/test";
import { formatEvent, operations } from "./index.ts";

describe("agent write contracts", () => {
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
    expect(formatEvent(event)).toBe("ticket · updated");
    expect(formatEvent(event, true)).toBe(`ticket · updated · ${event.ticketId}`);
    expect(formatEvent({ ...event, data: { key: "KAN-1", title: "A complete title" } }, true)).toBe(
      "ticket · updated · KAN-1 · A complete title",
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
