import { createPollingJob } from "./adapters/polling-jobs.ts";
import type { JobScheduler } from "./adapters/ports.ts";
import { createHash } from "node:crypto";
import { and, eq, isNull, isNotNull, lt, or, sql, count } from "drizzle-orm";
import { stagedUploadLifetime } from "@kanvil/contracts";
import { blobObjects, attachments, profilePhotos, projects, stagedUploads } from "./schema.ts";
import type { Database, Connection, Transaction } from "./database.ts";
import type { Instance } from "./instance.ts";
import { fail, requireRow, one } from "./domain.ts";
import { createObjectStore } from "./adapters/object-stores.ts";
import type {
  ObjectStoreFactory,
  ObjectStore,
  ObjectStoreConfiguration,
} from "./adapters/ports.ts";
// Staged uploads created before this instant have expired: nobody can read, claim, or discard them.
export const stagedUploadCutoff = () => new Date(Date.now() - stagedUploadLifetime);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function decodeBlobData(value: string, limit: number) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > limit || bytes.toString("base64") !== value)
    fail(400, "invalid_attachment", `Provide valid base64 data of at most ${limit} bytes`);
  return bytes;
}
export async function writeLocalBlob(
  db: Connection | Transaction,
  id: string,
  bytes: Buffer,
  contentType: string,
) {
  await db
    .insert(blobObjects)
    .values({ id, data: bytes, contentType, size: bytes.length, sha256: digest(bytes) });
}
export type BlobWriter = {
  put: (
    db: Connection | Transaction,
    id: string,
    bytes: Buffer,
    contentType: string,
  ) => Promise<void>;
};
export function createBlobStorage(
  database: Database,
  instance: Instance,
  factory: ObjectStoreFactory = createObjectStore,
  schedule: JobScheduler = createPollingJob,
) {
  async function transfer<T>(
    configuration: ObjectStoreConfiguration,
    run: (store: ObjectStore) => Promise<T>,
  ) {
    const store = factory(configuration);
    try {
      return await run(store);
    } catch {
      return fail(
        503,
        "storage_unavailable",
        "Object storage is unavailable. Check the instance storage settings.",
      );
    } finally {
      store.close();
    }
  }
  async function put(db: Connection | Transaction, id: string, bytes: Buffer, contentType: string) {
    const active = await instance.storage();
    if (!active) {
      await writeLocalBlob(db, id, bytes, contentType);
      return;
    }
    const backend = await instance.backend(active.id),
      store = factory(backend.spec);
    try {
      await db.insert(blobObjects).values({
        id,
        data: bytes,
        backendId: backend.id,
        objectKey: store.keyFor(id),
        contentType,
        size: bytes.length,
        sha256: digest(bytes),
      });
    } finally {
      store.close();
    }
  }
  let transferError: string | null = null;
  async function flushBatch() {
    try {
      await database.db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(blobObjects)
          .where(
            and(
              isNotNull(blobObjects.data),
              isNotNull(blobObjects.backendId),
              sql`(EXISTS (SELECT 1 FROM attachments a WHERE a.object_id=${blobObjects.id}) OR EXISTS (SELECT 1 FROM profile_photos p WHERE p.object_id=${blobObjects.id}) OR EXISTS (SELECT 1 FROM projects pr WHERE ${blobObjects.id} IN (pr.icon_object_id, pr.background_object_id)))`,
            ),
          )
          .orderBy(blobObjects.createdAt)
          .limit(10)
          .for("update", { of: blobObjects, skipLocked: true });
        for (const row of rows) {
          const backend = await instance.backend(requireRow(row.backendId ?? undefined)),
            key = requireRow(row.objectKey ?? undefined),
            bytes = requireRow(row.data ?? undefined);
          await transfer(backend.spec, async (store) => {
            await store.put(key, bytes, row.contentType);
            const verified = await store.get(key, row.size);
            if (digest(verified) !== row.sha256) throw new Error("Storage readback failed");
          });
          await tx.update(blobObjects).set({ data: null }).where(eq(blobObjects.id, row.id));
        }
      });
      transferError = null;
    } catch (error) {
      transferError =
        "File transfer is unavailable. Pending files remain readable from the local database.";
      throw error;
    }
  }
  async function get(id: string) {
    const row = one(await database.db.select().from(blobObjects).where(eq(blobObjects.id, id)));
    let data = row.data;
    if (!data) {
      if (!row.backendId || !row.objectKey)
        fail(500, "blob_corrupt", "The stored file has no content location");
      const backend = await instance.backend(row.backendId),
        key = row.objectKey;
      data = Buffer.from(await transfer(backend.spec, (store) => store.get(key, row.size)));
    }
    if (data.length !== row.size || digest(data) !== row.sha256)
      fail(500, "blob_corrupt", "The stored file failed its integrity check");
    return { ...row, data };
  }
  async function test(configuration: ObjectStoreConfiguration) {
    return transfer(configuration, async (store) => {
      const key = store.keyFor(`connection-test-${crypto.randomUUID()}`),
        bytes = Buffer.from("Kanvil object storage test");
      try {
        await store.put(key, bytes, "text/plain");
        if (Buffer.from(await store.get(key, bytes.length)).compare(bytes))
          throw new Error("Readback failed");
      } finally {
        await store.remove(key);
      }
    });
  }
  async function collectBatch() {
    return database.db.transaction(async (tx) => {
      // An expired staged upload releases its bytes; the unreferenced object goes below.
      await tx.delete(stagedUploads).where(lt(stagedUploads.createdAt, stagedUploadCutoff()));
      const rows = await tx
        .select({ object: blobObjects })
        .from(blobObjects)
        .leftJoin(attachments, eq(attachments.objectId, blobObjects.id))
        .leftJoin(profilePhotos, eq(profilePhotos.objectId, blobObjects.id))
        .leftJoin(stagedUploads, eq(stagedUploads.id, blobObjects.id))
        .leftJoin(
          projects,
          or(
            eq(projects.iconObjectId, blobObjects.id),
            eq(projects.backgroundObjectId, blobObjects.id),
          ),
        )
        .where(
          and(
            isNull(attachments.id),
            isNull(profilePhotos.userId),
            isNull(stagedUploads.id),
            isNull(projects.id),
            lt(blobObjects.createdAt, new Date(Date.now() - 86400000)),
          ),
        )
        .limit(20)
        .for("update", { of: blobObjects, skipLocked: true });
      for (const { object } of rows) {
        if (object.backendId && object.objectKey) {
          const backend = await instance.backend(object.backendId),
            key = object.objectKey;
          await transfer(backend.spec, (store) => store.remove(key));
        }
        await tx.delete(blobObjects).where(eq(blobObjects.id, object.id));
      }
      return rows.length;
    });
  }
  const job = schedule("blob-cleanup", 60000, collectBatch);
  const uploads = schedule("blob-transfer", 1000, flushBatch);
  return {
    put,
    get,
    test,
    collect: job.trigger,
    sync: uploads.trigger,
    async status() {
      const [row] = await database.db
        .select({ pending: count() })
        .from(blobObjects)
        .where(and(isNotNull(blobObjects.data), isNotNull(blobObjects.backendId)));
      const pending = row?.pending ?? 0;
      return {
        pending,
        status: transferError ? "unavailable" : pending ? "transferring" : "ready",
        error: transferError,
      };
    },
    async close() {
      await uploads.close();
      await job.close();
    },
  };
}
export type BlobStorage = ReturnType<typeof createBlobStorage>;

export function decodeImage(input: { data: string; contentType: string }) {
  const bytes = decodeBlobData(input.data, 512000);
  const valid =
    input.contentType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : input.contentType === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : input.contentType === "image/webp" &&
          bytes.subarray(0, 4).toString() === "RIFF" &&
          bytes.subarray(8, 12).toString() === "WEBP";
  if (!valid) fail(400, "invalid_image", "Choose a PNG, JPEG, or WebP image");
  return bytes;
}
export function imageResponse(blob: { data: Buffer; contentType: string; sha256: string }) {
  return new Response(new Uint8Array(blob.data), {
    headers: {
      "Content-Type": blob.contentType,
      "Cache-Control": "private, max-age=300",
      ETag: `"${blob.sha256}"`,
    },
  });
}
