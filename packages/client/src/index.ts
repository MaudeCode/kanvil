import {
  ApiError,
  errorSchema,
  operations,
  parseOutput,
  type Input,
  type Operation,
  type Output,
} from "@kanvil/contracts";
export { ApiError } from "@kanvil/contracts";

export function createClient(options: {
  baseUrl: string;
  headers?: () =>
    | ConstructorParameters<typeof Headers>[0]
    | Promise<ConstructorParameters<typeof Headers>[0]>;
  fetch?: typeof fetch;
  requestId?: () => string;
}) {
  const request = options.fetch ?? fetch;
  return {
    async call<K extends Operation>(name: K, input: Input<K>): Promise<Output<K>> {
      const spec = operations[name];
      const values: Record<string, unknown> = { ...spec.input.parse(input) };
      const path = spec.path.replace(/\{(\w+)\}/g, (_, key: string) => {
        const value = values[key];
        delete values[key];
        if (typeof value !== "string")
          throw new ApiError(400, "invalid_path", `Missing path parameter ${key}`);
        return encodeURIComponent(value);
      });
      const url = new URL(`${options.baseUrl.replace(/\/$/, "")}/api/v1${path}`);
      const headers = new Headers(await options.headers?.());
      const init: RequestInit = { method: spec.method, credentials: "include", headers };
      if (spec.method === "GET")
        for (const [key, value] of Object.entries(values)) {
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
            url.searchParams.set(key, String(value));
        }
      else {
        headers.set("Content-Type", "application/json");
        values.requestId ??= (options.requestId ?? (() => crypto.randomUUID()))();
        init.body = JSON.stringify(values);
      }
      const response = await request(url, init);
      const data: unknown = await response.json();
      if (!response.ok) {
        const error = errorSchema.safeParse(data);
        throw new ApiError(
          response.status,
          error.success ? error.data.error.code : "request_failed",
          error.success ? error.data.error.message : `Request failed (${response.status})`,
          error.success ? error.data.error.details : undefined,
        );
      }
      return parseOutput(name, data);
    },
  };
}
