import { describe, expect, it } from "vite-plus/test";
import { createHttpSender, DeliveryError, type Resolve } from "./outbound.ts";

// The resolver answers in place of DNS, so these cases need no network. delivery.test.ts covers
// the same sender against loopback endpoints with PostgreSQL behind the outbox.
const answering =
  (outcome: { code: string } | string[]): Resolve =>
  (hostname, _options, callback) =>
    process.nextTick(() =>
      Array.isArray(outcome)
        ? callback(
            null,
            outcome.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
          )
        : callback(
            Object.assign(new Error(`getaddrinfo ${outcome.code} ${hostname}`), outcome),
            [],
          ),
    );
async function failure(resolve: Resolve, url = "https://hooks.kanvil.invalid/in") {
  const error: unknown = await createHttpSender({ allowPrivate: false, resolve })({
    url,
    body: "{}",
  }).catch((cause: unknown) => cause);
  if (!(error instanceof DeliveryError)) throw new Error("Expected a delivery error");
  return { code: error.code, retry: error.retry };
}

describe("outbound sender", () => {
  it("reports a host that does not resolve as a DNS error worth retrying", async () => {
    expect(await failure(answering({ code: "ENOTFOUND" }))).toEqual({
      code: "dns_error",
      retry: true,
    });
  });
  it("reports other resolver failures as network errors worth retrying", async () => {
    expect(await failure(answering({ code: "EAI_AGAIN" }))).toEqual({
      code: "network_error",
      retry: true,
    });
  });
  it("refuses a name that resolves to a private address without connecting", async () => {
    for (const addresses of [["10.0.0.7"], ["203.0.113.9", "127.0.0.1"], ["::1"]])
      expect(await failure(answering(addresses))).toEqual({
        code: "blocked_address",
        retry: false,
      });
  });
});
