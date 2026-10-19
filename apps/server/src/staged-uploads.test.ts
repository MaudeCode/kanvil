import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { stagedUploadLifetime, type Project } from "@kanvil/contracts";
import { createFixture } from "./test-fixture.ts";
import { createInstance } from "./instance.ts";
import { createBlobStorage } from "./blob-storage.ts";
import { createDomain, type Actor, type Domain } from "./domain.ts";
import { blobObjects, events, stagedUploads } from "./schema.ts";
import type { JobScheduler } from "./adapters/ports.ts";

const manualJobs: JobScheduler = (_name, _interval, run) => ({
  trigger: run,
  close: () => Promise.resolve(),
});
describe("staged inline uploads", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>,
    blobs: ReturnType<typeof createBlobStorage>,
    domain: Domain,
    owner: Actor,
    writer: Actor,
    project: Project,
    other: Project;
  const stage = (actor = owner, target = project) =>
    domain.execute(
      "stage_upload",
      {
        projectId: target.id,
        name: "diagram.png",
        contentType: "image/png",
        data: Buffer.from(`inline bytes ${crypto.randomUUID()}`).toString("base64"),
      },
      actor,
    );
  const blobExists = async (id: string) =>
    (await fixture.database.db.select().from(blobObjects).where(eq(blobObjects.id, id))).length ===
    1;
  beforeAll(async () => {
    fixture = await createFixture();
    blobs = createBlobStorage(
      fixture.database,
      createInstance(fixture.database, fixture.config),
      undefined,
      manualJobs,
    );
    domain = createDomain(fixture.database, { blobs });
    const person = async (name: string) =>
      domain.actor(
        (
          await fixture.auth.api.createUser({
            body: {
              name,
              email: `${name.toLowerCase()}@uploads.example.test`,
              password: "Isolated upload password 42!",
              role: "user",
            },
          })
        ).user.id,
      );
    owner = await person("Owner");
    writer = await person("Writer");
    project = await domain.execute("create_project", { key: "STAGE", name: "Staging" }, owner);
    other = await domain.execute("create_project", { key: "AWAY", name: "Elsewhere" }, owner);
    await domain.execute(
      "set_member",
      { projectId: project.id, email: "writer@uploads.example.test", role: "writer" },
      owner,
    );
  });
  afterAll(async () => {
    await blobs?.close();
    await fixture?.close();
  });

  it("attaches staged uploads exactly once when the ticket is created", async () => {
    const first = await stage(),
      second = await stage();
    expect(Date.parse(first.expiresAt) - Date.parse(first.createdAt)).toBe(stagedUploadLifetime);
    // Staging is private: nothing reaches the project feed before the ticket exists.
    const before = await fixture.database.db
      .select()
      .from(events)
      .where(eq(events.projectId, project.id));
    const input = {
      projectId: project.id,
      requestId: crypto.randomUUID(),
      title: "Inline screenshots",
      description: `![diagram.png](/api/v1/projects/${project.id}/attachments/${first.id}/content)`,
      uploads: [first.id, second.id, first.id],
    };
    const ticket = await domain.execute("create_ticket", input, owner);
    const retried = await domain.execute("create_ticket", input, owner);
    expect(retried.id).toBe(ticket.id);
    const attached = await domain.execute(
      "list_attachments",
      { projectId: project.id, ticketId: ticket.id },
      owner,
    );
    expect(attached.map((item) => item.id).toSorted()).toEqual([first.id, second.id].toSorted());
    expect(attached[0]).toMatchObject({ ticketId: ticket.id, name: "diagram.png" });
    const published = (
      await fixture.database.db.select().from(events).where(eq(events.projectId, project.id))
    ).slice(before.length);
    expect(published.map((event) => event.type)).toEqual([
      "ticket.created",
      "attachment.created",
      "attachment.created",
    ]);
    expect(await fixture.database.db.select().from(stagedUploads)).toEqual([]);
    await expect(
      domain.execute(
        "create_ticket",
        { projectId: project.id, title: "Claim again", uploads: [first.id] },
        owner,
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("refuses uploads staged by someone else or in another project", async () => {
    const mine = await stage(owner),
      elsewhere = await stage(owner, other),
      count = async () =>
        (await domain.execute("list_tickets", { projectId: project.id }, owner)).total;
    const tickets = await count();
    await expect(
      domain.execute(
        "create_ticket",
        { projectId: project.id, title: "Not mine", uploads: [mine.id] },
        writer,
      ),
    ).rejects.toMatchObject({ status: 404, details: { uploads: [mine.id] } });
    await expect(
      domain.execute(
        "create_ticket",
        { projectId: project.id, title: "Wrong project", uploads: [elsewhere.id] },
        owner,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      domain.execute("discard_upload", { projectId: project.id, uploadId: mine.id }, writer),
    ).rejects.toMatchObject({ status: 404 });
    // A failed claim creates no ticket and leaves the upload with its owner.
    expect(await count()).toBe(tickets);
    expect(await blobExists(mine.id)).toBe(true);
  });

  it("removes discarded and expired uploads with their bytes", async () => {
    const discarded = await stage(),
      expired = await stage(),
      live = await stage();
    await domain.execute(
      "discard_upload",
      { projectId: project.id, uploadId: discarded.id },
      owner,
    );
    expect(await blobExists(discarded.id)).toBe(false);
    const old = new Date(Date.now() - stagedUploadLifetime - 60_000);
    await fixture.database.db
      .update(stagedUploads)
      .set({ createdAt: old })
      .where(eq(stagedUploads.id, expired.id));
    await fixture.database.db
      .update(blobObjects)
      .set({ createdAt: old })
      .where(eq(blobObjects.id, expired.id));
    await expect(
      domain.execute(
        "create_ticket",
        { projectId: project.id, title: "Too late", uploads: [expired.id] },
        owner,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await blobs.collect();
    expect(await blobExists(expired.id)).toBe(false);
    expect(await blobExists(live.id)).toBe(true);
    const staged = await fixture.database.db.select().from(stagedUploads);
    expect(staged.map((row) => row.id)).toEqual(expect.arrayContaining([live.id]));
    expect(staged.map((row) => row.id)).not.toContain(expired.id);
  });
});
