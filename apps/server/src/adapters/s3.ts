import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { s3SettingsSchema } from "@kanvil/contracts/instance";
import type { ObjectStore } from "./ports.ts";

export function createS3ObjectStore(configuration: unknown): ObjectStore {
  const settings = s3SettingsSchema.parse(configuration);
  const client = new S3Client({
    region: settings.region,
    ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
    forcePathStyle: settings.forcePathStyle,
    maxAttempts: 2,
    ...(settings.accessKeyId && settings.secretAccessKey
      ? {
          credentials: {
            accessKeyId: settings.accessKeyId,
            secretAccessKey: settings.secretAccessKey,
          },
        }
      : {}),
  });
  return {
    keyFor: (id) => `${settings.prefix ? settings.prefix.replace(/\/?$/, "/") : ""}${id}`,
    async put(key, bytes, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: settings.bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          ContentMD5: createHash("md5").update(bytes).digest("base64"),
        }),
        { abortSignal: AbortSignal.timeout(15000) },
      );
    },
    async get(key, maxBytes) {
      const response = await client.send(
        new GetObjectCommand({ Bucket: settings.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(15000) },
      );
      if (!response.Body) throw new Error("Object content missing");
      const reader = response.Body.transformToWebStream().getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      const timeout = setTimeout(() => {
        void reader.cancel().catch(() => {});
      }, 15000);
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > maxBytes) throw new Error("Object size exceeds metadata");
          chunks.push(part.value);
        }
        return Buffer.concat(chunks);
      } finally {
        clearTimeout(timeout);
        await reader.cancel().catch(() => {});
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: settings.bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(15000),
      });
    },
    close() {
      client.destroy();
    },
  };
}
