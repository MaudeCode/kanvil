import { expect, it } from "vite-plus/test";
import { createFixture } from "./test-fixture.ts";
import { createInstance } from "./instance.ts";
import { createBlobStorage } from "./blob-storage.ts";
import { createDomain, intakeHoldReason } from "./domain.ts";
import type { JobScheduler, ObjectStoreFactory } from "./adapters/ports.ts";
const manualJobs: JobScheduler = (_name, _interval, run) => ({
  trigger: run,
  close: () => Promise.resolve(),
});
it("commits files locally before external transfer and retains readable bytes after transfer failure", async () => {
  const fixture = await createFixture(),
    instance = createInstance(fixture.database, fixture.config);
  let failTransfer = true,
    release: (() => void) | undefined,
    started: (() => void) | undefined;
  const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const files = new Map<string, Uint8Array>();
  const factory: ObjectStoreFactory = () => ({
    keyFor: (id) => id,
    async put(key, bytes) {
      started?.();
      await gate;
      if (failTransfer) throw new Error("offline");
      files.set(key, bytes);
    },
    get: (key) => Promise.resolve(files.get(key) ?? new Uint8Array()),
    remove: (key) => {
      files.delete(key);
      return Promise.resolve();
    },
    close: () => {},
  });
  const blobs = createBlobStorage(fixture.database, instance, factory, manualJobs),
    domain = createDomain(fixture.database, { blobs });
  try {
    const row = await instance.read();
    await instance.update({
      expectedVersion: row.version,
      name: row.name,
      description: row.description,
      storage: { provider: "s3", bucket: "fixture-bucket" },
      search: { provider: "postgres" },
    });
    const owner = await fixture.auth.api.createUser({
        body: {
          name: "Blob owner",
          email: "blob-owner@example.test",
          password: "Test-only-blob-password-234",
          role: "admin",
        },
      }),
      actor = await domain.actor(owner.user.id);
    const project = await domain.execute(
        "create_project",
        { key: "QUEUE", name: "Queued uploads" },
        actor,
      ),
      ticket = await domain.execute(
        "create_ticket",
        { projectId: project.id, title: "Before transfer" },
        actor,
      ),
      bytes = Buffer.from("Durable pending attachment");
    const attachment = await domain.execute(
      "upload_attachment",
      {
        projectId: project.id,
        ticketId: ticket.id,
        name: "pending.txt",
        contentType: "text/plain",
        data: bytes.toString("base64"),
      },
      actor,
    );
    const transfer = blobs.sync();
    await inFlight;
    // An external transfer holds only its own blob row, never the ticket write lock.
    const changed = await domain.execute(
      "update_ticket",
      {
        projectId: project.id,
        ticketId: ticket.id,
        expectedVersion: ticket.version,
        changes: { title: "Updated while transfer is blocked" },
      },
      actor,
    );
    expect(changed.title).toBe("Updated while transfer is blocked");
    expect((await blobs.get(attachment.id)).data).toEqual(bytes);
    release?.();
    await expect(transfer).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(await blobs.status()).toMatchObject({ pending: 1, status: "unavailable" });
    expect((await blobs.get(attachment.id)).data).toEqual(bytes);
    failTransfer = false;
    // Project images transfer like attachments.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXpUAAAAASUVORK5CYII=",
      "base64",
    );
    await domain.execute(
      "set_project_background",
      {
        projectId: project.id,
        expectedVersion: project.version,
        background: { contentType: "image/png", data: png.toString("base64") },
      },
      actor,
    );
    await blobs.sync();
    expect(await blobs.status()).toMatchObject({ pending: 0, status: "ready" });
    expect((await blobs.get(attachment.id)).data).toEqual(bytes);
    expect(files.size).toBe(2);
    const background = await fixture.database.pool.query<{ id: string }>(
      "SELECT background_object_id AS id FROM projects WHERE id = $1",
      [project.id],
    );
    expect((await blobs.get(background.rows[0]!.id)).data).toEqual(png);
  } finally {
    release?.();
    await blobs.close();
    await fixture.close();
  }
});

it.each([false, true])(
  "expires only old quarantined intake attachments atomically, with event failure=%s",
  async (eventFailure) => {
    const fixture = await createFixture(),
      instance = createInstance(fixture.database, fixture.config),
      blobs = createBlobStorage(fixture.database, instance, undefined, manualJobs),
      domain = createDomain(fixture.database, { blobs });
    try {
      const person = await fixture.auth.api.createUser({
          body: {
            name: "Intake owner",
            email: "intake-owner@example.test",
            password: "Test-only-intake-password-234",
            role: "admin",
          },
        }),
        human = await domain.actor(person.user.id),
        project = await domain.execute("create_project", { key: "EXP", name: "Expiry" }, human),
        intake = await domain.actor(person.user.id, {
          ownerId: "test-intake-credential",
          scopes: ["intake"],
          projectIds: [project.id],
        });
      const report = await domain.execute(
          "create_ticket",
          { projectId: project.id, title: "Untriaged" },
          intake,
        ),
        triaged = await domain.execute(
          "create_ticket",
          { projectId: project.id, title: "Triaged" },
          intake,
        ),
        ordinary = await domain.execute(
          "create_ticket",
          {
            projectId: project.id,
            title: "Human with the same hold",
            holdReason: intakeHoldReason,
          },
          human,
        );
      const attach = (ticketId: string, name: string, actor = intake) =>
        domain.execute(
          "upload_attachment",
          { projectId: project.id, ticketId, name, data: btoa(name) },
          actor,
        );
      const expired = await attach(report.id, "expired"),
        alsoExpired = await attach(report.id, "also-expired"),
        young = await attach(report.id, "young"),
        keptAfterTriage = await attach(triaged.id, "triaged"),
        keptHuman = await attach(ordinary.id, "human", human);
      await domain.execute(
        "update_ticket",
        {
          projectId: project.id,
          ticketId: triaged.id,
          expectedVersion: triaged.version,
          changes: { holdReason: null },
        },
        human,
      );
      const old = new Date(Date.now() - 31 * 86_400_000);
      for (const row of [expired, alsoExpired, keptAfterTriage, keptHuman]) {
        await fixture.database.pool.query("UPDATE attachments SET created_at = $1 WHERE id = $2", [
          old,
          row.id,
        ]);
        await fixture.database.pool.query("UPDATE blob_objects SET created_at = $1 WHERE id = $2", [
          old,
          row.id,
        ]);
      }
      await fixture.database.pool.query("UPDATE attachments SET size = $1 WHERE id = $2", [
        1_000_000_000 - young.size - alsoExpired.size,
        expired.id,
      ]);
      await expect(attach(report.id, "over-quota")).rejects.toMatchObject({
        code: "attachment_limit",
      });
      const deletedEvents = async () =>
        (
          await domain.execute(
            "list_activity",
            { projectId: project.id, ticketId: report.id },
            human,
          )
        ).items.filter((event) => event.type === "attachment.deleted");
      if (eventFailure) {
        await fixture.database.pool.query(
          "ALTER TABLE events ADD CONSTRAINT refuse_expiry CHECK (type <> 'attachment.deleted') NOT VALID",
        );
        await expect(blobs.collect()).rejects.toThrow();
        expect(
          await domain.execute(
            "list_attachments",
            {
              projectId: project.id,
              ticketId: report.id,
            },
            intake,
          ),
        ).toHaveLength(3);
        expect((await blobs.get(expired.id)).data.toString()).toBe("expired");
        expect(await deletedEvents()).toEqual([]);
        await fixture.database.pool.query("ALTER TABLE events DROP CONSTRAINT refuse_expiry");
      }
      await blobs.collect();
      expect(
        await domain.execute(
          "list_attachments",
          {
            projectId: project.id,
            ticketId: report.id,
          },
          intake,
        ),
      ).toEqual([young]);
      for (const [ticketId, attachment] of [
        [triaged.id, keptAfterTriage],
        [ordinary.id, keptHuman],
      ] as const)
        expect(
          await domain.execute("list_attachments", { projectId: project.id, ticketId }, human),
        ).toMatchObject([{ id: attachment.id }]);
      const deletion = await deletedEvents();
      expect(deletion).toHaveLength(2);
      expect(deletion.map((event) => event.data.attachmentId)).toEqual(
        expect.arrayContaining([expired.id, alsoExpired.id]),
      );
      expect(deletion).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            projectId: project.id,
            ticketId: report.id,
            actorId: null,
            data: expect.objectContaining({
              key: report.key,
              title: report.title,
              source: { kind: "system", id: "blob-cleanup" },
            }),
          }),
        ]),
      );
      for (const row of [expired, alsoExpired])
        await expect(blobs.get(row.id)).rejects.toMatchObject({ code: "not_found" });
      expect((await blobs.get(young.id)).data.toString()).toBe("young");
      expect(await attach(report.id, "quota-recovered")).toMatchObject({ ticketId: report.id });
      expect((await domain.execute("list_tickets", { projectId: project.id }, human)).total).toBe(
        3,
      );
      await blobs.collect();
      expect(await deletedEvents()).toHaveLength(2);
    } finally {
      await blobs.close();
      await fixture.close();
    }
  },
);
