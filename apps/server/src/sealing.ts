import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { fail } from "./domain.ts";

// AES-256-GCM under a key derived from the instance secret; `purpose` keeps each store's key separate.
export function createSealer(secret: string, purpose: string) {
  const key = createHash("sha256").update(purpose).update(secret).digest();
  return {
    seal: (value: unknown) => {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64");
    },
    unseal: (value: string): unknown => {
      try {
        const bytes = Buffer.from(value, "base64"),
          decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return JSON.parse(
          Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
        );
      } catch {
        return fail(
          503,
          "configuration_key_changed",
          "Saved integration credentials cannot be decrypted. Restore the instance secret from your backup.",
        );
      }
    },
  };
}
export type Sealer = ReturnType<typeof createSealer>;
// Channel and destination settings, including their tokens and signing secrets.
export const deliverySecrets = (config: { BETTER_AUTH_SECRET: string }) =>
  createSealer(config.BETTER_AUTH_SECRET, "kanvil:delivery-secrets:v1:");
