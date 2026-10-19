import { expect, it } from "vite-plus/test";
import { createFixture } from "./test-fixture.ts";
import { createInstance } from "./instance.ts";
import { createBlobStorage } from "./blob-storage.ts";
import { createDomain } from "./domain.ts";
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
