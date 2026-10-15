import type { ObjectStoreFactory } from "./ports.ts";
import { createS3ObjectStore } from "./s3.ts";
const providers: Record<
  string,
  (configuration: unknown) => ReturnType<typeof createS3ObjectStore>
> = { s3: createS3ObjectStore };
export const createObjectStore: ObjectStoreFactory = (configuration) => {
  const create = providers[configuration.provider];
  if (!create) throw new Error("Unsupported object storage provider");
  return create(configuration.config);
};
