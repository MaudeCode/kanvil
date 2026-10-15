import type { JobScheduler } from "./ports.ts";
// Job records and checkpoints remain durable in PostgreSQL. Scheduling only wakes their processors.
export const createPollingJob: JobScheduler = <T>(
  name: string,
  intervalMs: number,
  run: () => Promise<T>,
) => {
  let pending: Promise<T> | undefined,
    closed = false,
    again = false;
  function trigger() {
    if (closed) return Promise.reject(new Error("The background job is closed"));
    again = true;
    return (pending ??= (async () => {
      let result: T;
      do {
        again = false;
        result = await run();
        if (closed) break;
      } while (again);
      return result;
    })().finally(() => {
      pending = undefined;
    }));
  }
  const timer = setInterval(() => {
    void trigger().catch(() => console.error("Background job failed", { job: name }));
  }, intervalMs);
  timer.unref();
  return {
    trigger,
    async close() {
      closed = true;
      clearInterval(timer);
      await pending?.catch(() => {});
    },
  };
};
