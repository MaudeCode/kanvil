// Construction and shutdown share ownership; each acquired resource is attempted exactly once.
export function createCleanup() {
  const resources: { name: string; close: () => void | Promise<void> }[] = [];
  let closing: Promise<void> | undefined;
  function close() {
    return (closing ??= Promise.resolve().then(async () => {
      const failures: Error[] = [];
      for (const resource of resources.toReversed()) {
        try {
          await resource.close();
        } catch {
          // Adapter errors can contain credentials. Report only our resource names.
          failures.push(new Error(`Could not close ${resource.name}.`));
        }
      }
      if (failures.length) throw new AggregateError(failures, "Resource cleanup failed.");
    }));
  }
  return {
    add(name: string, release: () => void | Promise<void>) {
      resources.push({ name, close: release });
    },
    close,
    async fail(error: unknown): Promise<never> {
      try {
        await close();
      } catch (cleanupError) {
        console.error("Startup cleanup failed.", cleanupError);
      }
      throw error;
    },
  };
}
