import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { customFieldFilter, type CustomField, type Project } from "@kanvil/contracts";
import { createFixture } from "./test-fixture.ts";
import { createDomain, type Actor, type Domain } from "./domain.ts";

const option = (field: CustomField, name: string) =>
  field.options.find((item) => item.name === name)!.id;
const without = (field: CustomField, removed: string) =>
  field.options.filter((item) => item.id !== removed);
describe("custom fields on PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    domain: Domain,
    owner: Actor,
    writer: Actor,
    project: Project;
  beforeAll(async () => {
    fixture = await createFixture();
    domain = createDomain(fixture.database);
    const people = await Promise.all(
      ["Owner", "Writer"].map((name) =>
        fixture.auth.api.createUser({
          body: {
            name,
            email: `${name.toLowerCase()}@fields.test`,
            password: "Isolated fixture password 42!",
            role: "user",
          },
        }),
      ),
    );
    owner = await domain.actor(people[0]!.user.id);
    writer = await domain.actor(people[1]!.user.id);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    project = await domain.execute(
      "create_project",
      { key: `F${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Fields project" },
      owner,
    );
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@fields.test", role: "writer" },
      owner,
    );
  });
  const define = (input: Record<string, unknown>) =>
    domain.execute("create_custom_field", { projectId: project.id, ...input }, owner);
  const select = (name = "Severity", input: Record<string, unknown> = {}) =>
    define({
      name,
      type: "select",
      options: [{ name: "High" }, { name: "Medium" }, { name: "Low" }],
      ...input,
    });
  const create = (title: string, customFields: Record<string, unknown> = {}) =>
    domain.execute("create_ticket", { projectId: project.id, title, customFields }, writer);
  const read = async (ticketId: string) =>
    (await domain.execute("get_ticket", { projectId: project.id, ticketId }, owner)).ticket;
  const ids = async (filter: Record<string, unknown>) =>
    (
      await domain.execute(
        "list_tickets",
        { projectId: project.id, sort: "number", ...filter },
        owner,
      )
    ).items.map((ticket) => ticket.title);

  it("lets administrators define, edit, reorder, and delete fields with versioned definitions", async () => {
    const severity = await select("Severity", { required: true });
    const notes = await define({ name: "Notes", type: "text" });
    const due = await define({ name: "Review day", type: "date" });
    expect(severity).toMatchObject({ type: "select", required: true, version: 1 });
    await expect(define({ name: "severity", type: "text" })).rejects.toMatchObject({
      status: 409,
      code: "duplicate_field",
    });
    await expect(
      domain.execute(
        "create_custom_field",
        { projectId: project.id, name: "Writer field", type: "text" },
        writer,
      ),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(
      define({ name: "Options on text", type: "text", options: [{ name: "A" }] }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      define({ name: "Agreed", type: "checkbox", required: true }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      define({ name: "Bad default", type: "number", defaultValue: "three" }),
    ).rejects.toMatchObject({ code: "validation_error" });

    const renamed = await domain.execute(
      "update_custom_field",
      {
        projectId: project.id,
        fieldId: severity.id,
        expectedVersion: 1,
        name: "Impact",
        options: [...severity.options, { name: "Critical", color: "red" }],
        defaultValue: option(severity, "Low"),
      },
      owner,
    );
    expect(renamed).toMatchObject({
      name: "Impact",
      version: 2,
      defaultValue: option(severity, "Low"),
    });
    expect(renamed.options.map((item) => item.name)).toEqual(["High", "Medium", "Low", "Critical"]);
    // A stale definition version never overwrites a newer one.
    await expect(
      domain.execute(
        "update_custom_field",
        { projectId: project.id, fieldId: severity.id, expectedVersion: 1, required: false },
        owner,
      ),
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    // An explicit null clears the default; omitting it keeps the saved one.
    const kept = await domain.execute(
      "update_custom_field",
      { projectId: project.id, fieldId: severity.id, expectedVersion: 2, required: false },
      owner,
    );
    expect(kept.defaultValue).toBe(option(severity, "Low"));
    const cleared = await domain.execute(
      "update_custom_field",
      { projectId: project.id, fieldId: severity.id, expectedVersion: 3, defaultValue: null },
      owner,
    );
    expect(cleared.defaultValue).toBeNull();

    await domain.execute(
      "move_custom_field",
      { projectId: project.id, fieldId: due.id, expectedVersion: 1, before: severity.id },
      owner,
    );
    const listed = await domain.execute("list_custom_fields", { projectId: project.id }, writer);
    expect(listed.map((field) => field.name)).toEqual(["Review day", "Impact", "Notes"]);

    await create("Noted", { [notes.id]: "Check the logs" });
    await domain.execute(
      "delete_custom_field",
      { projectId: project.id, fieldId: notes.id, expectedVersion: 1 },
      owner,
    );
    expect(
      (await domain.execute("list_custom_fields", { projectId: project.id }, owner)).map(
        (field) => field.name,
      ),
    ).toEqual(["Review day", "Impact"]);
    const events = await fixture.database.pool.query<{ type: string }>(
      "SELECT type FROM events WHERE project_id = $1 AND type LIKE 'custom_field.%' ORDER BY id",
      [project.id],
    );
    expect(events.rows.map((row) => row.type)).toEqual([
      "custom_field.created",
      "custom_field.created",
      "custom_field.created",
      "custom_field.updated",
      "custom_field.updated",
      "custom_field.updated",
      "custom_field.updated",
      "custom_field.deleted",
    ]);
  });

  it("validates ticket values by type, ownership, defaults, and required rules", async () => {
    const severity = await select("Severity", { required: true, defaultValue: undefined });
    const points = await define({ name: "Points", type: "number", defaultValue: 3 });
    const blocked = await define({ name: "Blocked", type: "checkbox" });
    const areas = await define({
      name: "Areas",
      type: "multiselect",
      options: [{ name: "Web" }, { name: "Server" }],
    });
    // A required field without a default needs a value.
    await expect(create("Missing")).rejects.toMatchObject({
      code: "validation_error",
      details: [{ path: `customFields.${severity.id}` }],
    });
    const ticket = await create("Valued", {
      [severity.id]: option(severity, "High"),
      [blocked.id]: true,
      [areas.id]: [option(areas, "Web"), option(areas, "Web")],
    });
    // Omitted fields take their default; duplicates collapse.
    expect(ticket.customFields).toEqual({
      [severity.id]: option(severity, "High"),
      [points.id]: 3,
      [blocked.id]: true,
      [areas.id]: [option(areas, "Web")],
    });
    for (const value of ["High", 2, crypto.randomUUID()])
      await expect(create("Bad value", { [severity.id]: value })).rejects.toMatchObject({
        code: "validation_error",
      });
    await expect(
      create("Bad date", { [severity.id]: option(severity, "Low"), [points.id]: "2026-02-31" }),
    ).rejects.toMatchObject({ code: "validation_error" });
    // A field of another project is not this ticket's field.
    const other = await domain.execute(
      "create_project",
      { key: `O${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Other project" },
      owner,
    );
    const foreign = await domain.execute(
      "create_custom_field",
      { projectId: other.id, name: "Foreign", type: "text" },
      owner,
    );
    await expect(
      create("Foreign", { [severity.id]: option(severity, "Low"), [foreign.id]: "x" }),
    ).rejects.toMatchObject({
      code: "validation_error",
      details: [{ path: `customFields.${foreign.id}` }],
    });
    // Updates change only the named fields; null clears one, but never a required one.
    const updated = await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: ticket.id,
        expectedVersion: ticket.version,
        changes: { customFields: { [points.id]: 8, [blocked.id]: null } },
      },
      writer,
    );
    expect(updated.customFields).toEqual({
      [severity.id]: option(severity, "High"),
      [points.id]: 8,
      [areas.id]: [option(areas, "Web")],
    });
    await expect(
      domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: ticket.id,
          expectedVersion: updated.version,
          changes: { customFields: { [severity.id]: null } },
        },
        writer,
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
    // Unchecking a box stores no value, like clearing it.
    const unchecked = await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: ticket.id,
        expectedVersion: updated.version,
        changes: { customFields: { [blocked.id]: false, [areas.id]: [] } },
      },
      writer,
    );
    expect(unchecked.customFields).not.toHaveProperty(blocked.id);
    expect(unchecked.customFields).not.toHaveProperty(areas.id);
    const copy = await domain.execute(
      "duplicate_ticket",
      { projectId: project.id, ticketId: ticket.id },
      writer,
    );
    expect(copy.customFields).toEqual(unchecked.customFields);
  });

  it("keeps existing tickets editable when a field becomes required and edits mixed selections", async () => {
    const before = await create("Before the field");
    const severity = await select("Severity");
    const later = await create("Later", { [severity.id]: option(severity, "Low") });
    await domain.execute(
      "update_custom_field",
      { projectId: project.id, fieldId: severity.id, expectedVersion: 1, required: true },
      owner,
    );
    // The rule applies to new tickets and to edits of the field, not to unrelated edits.
    const moved = await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: before.id,
        expectedVersion: before.version,
        changes: { status: "in_progress" },
      },
      writer,
    );
    expect(moved.customFields).toEqual({});
    const points = await define({ name: "Points", type: "number" });
    const pointed = await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: later.id,
        expectedVersion: later.version,
        changes: { customFields: { [points.id]: 5 } },
      },
      writer,
    );
    // One field set across tickets whose other values differ keeps each ticket's other values.
    const bulk = await domain.execute(
      "bulk_update_tickets",
      {
        projectId: project.id,
        tickets: [
          { ticketId: moved.id, expectedVersion: moved.version },
          { ticketId: pointed.id, expectedVersion: pointed.version },
        ],
        changes: { customFields: { [severity.id]: option(severity, "High") } },
      },
      writer,
    );
    expect(bulk.map((ticket) => ticket.customFields)).toEqual([
      { [severity.id]: option(severity, "High") },
      { [severity.id]: option(severity, "High"), [points.id]: 5 },
    ]);
    await expect(
      domain.execute(
        "bulk_update_tickets",
        {
          projectId: project.id,
          tickets: bulk.map((ticket) => ({ ticketId: ticket.id, expectedVersion: ticket.version })),
          changes: { customFields: { [severity.id]: null } },
        },
        writer,
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("removes options only with an explicit destination for their values", async () => {
    const areas = await define({
      name: "Areas",
      type: "multiselect",
      options: [{ name: "Web" }, { name: "Server" }, { name: "Mobile" }],
    });
    const severity = await select("Severity", { defaultValue: undefined });
    const web = option(areas, "Web"),
      server = option(areas, "Server"),
      mobile = option(areas, "Mobile"),
      high = option(severity, "High"),
      low = option(severity, "Low");
    const both = await create("Both", { [areas.id]: [web, mobile] });
    const mobileOnly = await create("Mobile only", { [areas.id]: [mobile], [severity.id]: low });
    await domain.execute(
      "update_custom_field",
      { projectId: project.id, fieldId: severity.id, expectedVersion: 1, defaultValue: high },
      owner,
    );
    const view = await domain.execute(
      "save_view",
      {
        projectId: project.id,
        name: "Mobile",
        filters: { customField: [customFieldFilter(areas.id, mobile)] },
      },
      owner,
    );
    // Removing a used option without saying where its values go fails and changes nothing.
    await expect(
      domain.execute(
        "update_custom_field",
        {
          projectId: project.id,
          fieldId: areas.id,
          expectedVersion: 1,
          options: without(areas, mobile),
        },
        owner,
      ),
    ).rejects.toMatchObject({
      code: "validation_error",
      details: [{ path: `reassign.${mobile}`, message: expect.stringContaining("2 tickets") }],
    });
    expect((await read(both.id)).version).toBe(both.version);
    await expect(
      domain.execute(
        "update_custom_field",
        {
          projectId: project.id,
          fieldId: areas.id,
          expectedVersion: 1,
          options: without(areas, mobile),
          reassign: { [mobile]: mobile },
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
    await domain.execute(
      "update_custom_field",
      {
        projectId: project.id,
        fieldId: areas.id,
        expectedVersion: 1,
        options: without(areas, mobile),
        reassign: { [mobile]: server },
      },
      owner,
    );
    expect((await read(both.id)).customFields[areas.id]).toEqual([web, server]);
    expect(await read(mobileOnly.id)).toMatchObject({
      version: mobileOnly.version + 1,
      customFields: { [areas.id]: [server] },
    });
    const views = await domain.execute("list_views", { projectId: project.id }, owner);
    expect(views.find((item) => item.id === view.id)?.filters.customField).toEqual([
      customFieldFilter(areas.id, server),
    ]);
    // Clearing to null removes the option from multi-selects and leaves no empty value.
    await domain.execute(
      "update_custom_field",
      {
        projectId: project.id,
        fieldId: areas.id,
        expectedVersion: 2,
        options: areas.options.filter((item) => item.id === web),
        reassign: { [server]: null },
      },
      owner,
    );
    expect((await read(both.id)).customFields[areas.id]).toEqual([web]);
    expect((await read(mobileOnly.id)).customFields).not.toHaveProperty(areas.id);
    // The default counts as a use: it follows the reassignment.
    await expect(
      domain.execute(
        "update_custom_field",
        {
          projectId: project.id,
          fieldId: severity.id,
          expectedVersion: 2,
          options: without(severity, high),
        },
        owner,
      ),
    ).rejects.toMatchObject({ details: [{ message: expect.stringContaining("default") }] });
    const moved = await domain.execute(
      "update_custom_field",
      {
        projectId: project.id,
        fieldId: severity.id,
        expectedVersion: 2,
        options: without(severity, high),
        reassign: { [high]: low },
      },
      owner,
    );
    expect(moved.defaultValue).toBe(low);
    expect((await create("After", {})).customFields[severity.id]).toBe(low);
  });

  it("filters by option, checkbox, and missing value, and rejects inaccessible fields", async () => {
    const severity = await select("Severity");
    const blocked = await define({ name: "Blocked", type: "checkbox" });
    const high = option(severity, "High"),
      low = option(severity, "Low");
    await create("High blocked", { [severity.id]: high, [blocked.id]: true });
    await create("High open", { [severity.id]: high });
    await create("Low", { [severity.id]: low });
    await create("Unset");
    const filter = (token: string, field = severity.id) => customFieldFilter(field, token);
    expect(await ids({ customField: [filter(high), filter(low)] })).toEqual([
      "High blocked",
      "High open",
      "Low",
    ]);
    // Different fields combine with AND.
    expect(await ids({ customField: [filter(high), filter("true", blocked.id)] })).toEqual([
      "High blocked",
    ]);
    expect(await ids({ customField: filter("none") })).toEqual(["Unset"]);
    // Excluding keeps tickets without a value.
    expect(await ids({ customFieldNot: filter(high) })).toEqual(["Low", "Unset"]);
    expect(await ids({ customFieldNot: filter("true", blocked.id) })).toEqual([
      "High open",
      "Low",
      "Unset",
    ]);
    const search = await domain.execute(
      "search_workspace",
      { q: "High", type: "ticket", customField: filter("true", blocked.id) },
      owner,
    );
    expect(search.items.map((item) => item.title)).toEqual(["High blocked"]);
    await expect(ids({ customField: filter("true") })).rejects.toMatchObject({
      code: "validation_error",
    });
    await expect(ids({ customField: filter(crypto.randomUUID()) })).rejects.toMatchObject({
      code: "validation_error",
    });
    const other = await domain.execute(
      "create_project",
      { key: `P${crypto.randomUUID().slice(0, 8).toUpperCase()}`, name: "Private project" },
      owner,
    );
    const hidden = await domain.execute(
      "create_custom_field",
      { projectId: other.id, name: "Hidden", type: "checkbox" },
      owner,
    );
    await expect(ids({ customField: filter("true", hidden.id) })).rejects.toMatchObject({
      code: "validation_error",
    });
    // The writer cannot read the other project, so its field does not exist for them.
    await expect(
      domain.execute(
        "search_workspace",
        { q: "High", customField: filter("true", hidden.id) },
        writer,
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      domain.execute("list_custom_fields", { projectId: other.id }, writer),
    ).rejects.toMatchObject({ status: 404 });
    const counts = await domain.execute("list_custom_fields", { projectId: project.id }, owner);
    expect(counts.map((field) => [field.name, field.count])).toEqual([
      ["Severity", 3],
      ["Blocked", 1],
    ]);
  });

  it("deletes a field's values from tickets and saved views", async () => {
    const severity = await select();
    const ticket = await create("Valued", { [severity.id]: option(severity, "High") });
    await domain.execute(
      "save_view",
      {
        projectId: project.id,
        name: "Severe",
        filters: { customField: customFieldFilter(severity.id, option(severity, "High")) },
      },
      owner,
    );
    await domain.execute(
      "delete_custom_field",
      { projectId: project.id, fieldId: severity.id, expectedVersion: 1 },
      owner,
    );
    expect(await read(ticket.id)).toMatchObject({
      customFields: {},
      version: ticket.version + 1,
    });
    const [view] = await domain.execute("list_views", { projectId: project.id }, owner);
    expect(view?.filters).not.toHaveProperty("customField");
  });

  it("migrates values on released machine work while any claim still blocks", async () => {
    const severity = await select("Severity"),
      area = await select("Area");
    const high = option(severity, "High"),
      low = option(severity, "Low");
    const manager = await domain.actor(owner.id, { ownerId: "fields-manager", scopes: ["admin"] });
    const worker = await domain.actor(owner.id, {
      ownerId: "fields-worker",
      scopes: ["read", "write", "claim"],
    });
    const detail = (ticketId: string) =>
      domain.execute("get_ticket", { projectId: project.id, ticketId }, owner);
    // Machine work holding both fields, completed and released unless `keep`, archived when asked.
    const finish = async (
      title: string,
      {
        keep = false,
        archive = false,
        by = worker,
      }: { keep?: boolean; archive?: boolean; by?: Actor } = {},
    ) => {
      const ticket = await domain.execute(
        "create_ticket",
        {
          projectId: project.id,
          title,
          description: "Synthetic claim-protected work.",
          acceptanceCriteria: "Keep ownership and readiness.",
          difficulty: "low",
          automationReady: true,
          customFields: { [severity.id]: high, [area.id]: option(area, "Low") },
        },
        owner,
      );
      const claim = await domain.execute(
        "claim_ticket",
        { projectId: project.id, ticketId: ticket.id, expectedVersion: 1, workerId: title },
        by,
      );
      await domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: ticket.id,
          expectedVersion: (await read(ticket.id)).version,
          changes: { status: "done" },
          claimId: claim.id,
        },
        by,
      );
      if (!keep)
        await domain.execute(
          "release_claim",
          { projectId: project.id, ticketId: ticket.id, claimId: claim.id },
          by,
        );
      if (archive)
        await domain.execute(
          "update_ticket",
          {
            projectId: project.id,
            ticketId: ticket.id,
            expectedVersion: (await read(ticket.id)).version,
            changes: { archived: true },
          },
          owner,
        );
      return claim;
    };
    const historical = [
      await finish("Historical"),
      await finish("Archived", { archive: true }),
      {
        ticketId: (await create("Plain", { [severity.id]: high, [area.id]: option(area, "Low") }))
          .id,
      },
      // Untouched by the reassignment, but still holds the deleted field.
      {
        ticketId: (
          await create("Medium", {
            [severity.id]: option(severity, "Medium"),
            [area.id]: option(area, "Low"),
          })
        ).id,
      },
    ];
    const before = await Promise.all(historical.map(({ ticketId }) => detail(ticketId)));
    expect(before.map(({ ticket }) => [ticket.claimRequired, ticket.archived])).toEqual([
      [true, false],
      [true, true],
      [false, false],
      [false, false],
    ]);
    const reassign = (actor: Actor, expectedVersion: number) =>
      domain.execute(
        "update_custom_field",
        {
          projectId: project.id,
          fieldId: severity.id,
          expectedVersion,
          options: without(severity, high),
          reassign: { [high]: low },
        },
        actor,
      );
    const remove = (actor: Actor, expectedVersion: number) =>
      domain.execute(
        "delete_custom_field",
        { projectId: project.id, fieldId: area.id, expectedVersion },
        actor,
      );

    // A live claim, an expired one, and the manager's own claim each block the whole migration.
    for (const kind of ["live", "expired", "own"]) {
      const claim = await finish(kind, { keep: true, by: kind === "own" ? manager : worker });
      if (kind === "expired")
        await fixture.database.pool.query(
          "UPDATE claims SET expires_at = '2000-01-01' WHERE id = $1",
          [claim.id],
        );
      const held = await detail(claim.ticketId);
      await expect(reassign(manager, severity.version)).rejects.toMatchObject({
        code: "claim_conflict",
      });
      await expect(remove(manager, area.version)).rejects.toMatchObject({
        code: "claim_conflict",
      });
      // Nothing changed and the claim was neither cancelled nor recovered.
      expect(await detail(claim.ticketId)).toEqual(held);
      for (const original of before) expect(await detail(original.ticket.id)).toEqual(original);
      const fields = await domain.execute("list_custom_fields", { projectId: project.id }, owner);
      expect(fields.map((field) => [field.id, field.version])).toEqual([
        [severity.id, severity.version],
        [area.id, area.version],
      ]);
      // People are not workers: the owner clears the blocker's values.
      await domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: claim.ticketId,
          expectedVersion: held.ticket.version,
          changes: { customFields: { [severity.id]: null, [area.id]: null } },
        },
        owner,
      );
    }

    await expect(reassign(writer, severity.version)).rejects.toMatchObject({ status: 403 });
    await expect(reassign(manager, severity.version + 1)).rejects.toMatchObject({
      code: "version_conflict",
    });
    await expect(remove(manager, area.version + 1)).rejects.toMatchObject({
      code: "version_conflict",
    });
    const cursor = (await domain.readEvents(owner, 0n, project.id)).cursor;
    await reassign(manager, severity.version);
    await remove(manager, area.version);
    const expected = before.map(({ ticket }, index) => {
      const reassigned = index < 3;
      return {
        ...ticket,
        customFields: { [severity.id]: reassigned ? low : option(severity, "Medium") },
        version: ticket.version + (reassigned ? 2 : 1),
      };
    });
    for (const want of expected) {
      const after = await detail(want.id);
      expect(after.ticket).toEqual({ ...want, updatedAt: after.ticket.updatedAt });
      expect(after.claim).toBeNull();
    }
    const published = (await domain.readEvents(owner, cursor, project.id)).items;
    expect(published.map((event) => event.type)).toEqual([
      ...[0, 1, 2].map(() => "ticket.updated"),
      "custom_field.updated",
      ...[0, 1, 2, 3].map(() => "ticket.updated"),
      "custom_field.deleted",
    ]);

    // Ordinary worker writes on historical work still need a matching claim.
    await expect(
      domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: expected[0]!.id,
          expectedVersion: expected[0]!.version,
          changes: { title: "Worker edit" },
        },
        manager,
      ),
    ).rejects.toMatchObject({ code: "claim_conflict" });
  });
});

it("gives tickets from before custom fields an empty set of values", async () => {
  const folder = await mkdtemp(join(tmpdir(), "kanvil-fields-upgrade-"));
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    const source = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
    // An install from before workflows and custom fields; later migrations upgrade its ticket.
    journal.entries = journal.entries.filter(
      (entry: { tag: string }) => entry.tag < "0024_workflow_states",
    );
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries)
      await copyFile(join(source, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    fixture = await createFixture({
      beforeMigrate: async (database) => {
        await migrate(drizzle(database.pool), { migrationsFolder: folder });
        await database.pool.query(
          `INSERT INTO "user" (id, name, email, role) VALUES ('owner', 'Owner', 'owner@upgrade.test', 'user')`,
        );
        await database.pool.query(
          `INSERT INTO workspaces (id, slug, name) VALUES ('00000000-0000-4000-8000-000000000021', 'upgrade', 'Upgrade')`,
        );
        await database.pool.query(
          `INSERT INTO projects (id, workspace_id, key, name) VALUES ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000021', 'OLD', 'Old project')`,
        );
        await database.pool.query(
          `INSERT INTO project_members (project_id, user_id, role) VALUES ('00000000-0000-4000-8000-000000000022', 'owner', 'admin')`,
        );
        await database.pool.query(
          `INSERT INTO tickets (project_id, key, number, title, created_by) VALUES ('00000000-0000-4000-8000-000000000022', 'OLD-1', 1, 'Old ticket', 'owner')`,
        );
      },
    });
    const domain = createDomain(fixture.database),
      owner = await domain.actor("owner");
    const field = await domain.execute(
      "create_custom_field",
      { projectId: "OLD", name: "Points", type: "number", required: true },
      owner,
    );
    const old = (await domain.execute("get_ticket", { projectId: "OLD", ticketId: "OLD-1" }, owner))
      .ticket;
    expect(old.customFields).toEqual({});
    const valued = await domain.execute(
      "update_ticket",
      {
        projectId: "OLD",
        ticketId: "OLD-1",
        expectedVersion: old.version,
        changes: { customFields: { [field.id]: 2 } },
      },
      owner,
    );
    expect(valued.customFields).toEqual({ [field.id]: 2 });
  } finally {
    await fixture?.close();
    await rm(folder, { recursive: true, force: true });
  }
});
