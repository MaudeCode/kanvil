import { lookup as resolve } from "node:dns";
import { request as plainRequest } from "node:http";
import { request as tlsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import nodemailer from "nodemailer";
import type { MailMessage, OutboundRequest } from "./ports.ts";

// A failed send; `retry` says whether a later attempt can succeed.
export class DeliveryError extends Error {
  readonly code: string;
  readonly retry: boolean;
  constructor(code: string, retry: boolean) {
    super(code);
    this.code = code;
    this.retry = retry;
  }
}
// Loopback, private, link-local, shared, documentation, multicast, and translated (NAT64, 6to4) ranges.
const reserved = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  reserved.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 127],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  reserved.addSubnet(network, prefix, "ipv6");
export function isReservedAddress(address: string) {
  const family = isIP(address);
  return family === 0 || reserved.check(address, family === 6 ? "ipv6" : "ipv4");
}

// Posts JSON to a configured endpoint. Every resolved address is checked and the connection uses
// the checked address, so DNS rebinding cannot reach an internal host; redirects are not followed.
export function createHttpSender({
  allowPrivate,
  timeout = 10_000,
}: {
  allowPrivate: boolean;
  timeout?: number;
}) {
  const allowed = (address: string) => allowPrivate || !isReservedAddress(address);
  const lookup: LookupFunction = (hostname, options, callback) => {
    resolve(hostname, { all: true, family: options.family }, (error, addresses) => {
      if (error) return callback(error, "", 4);
      const usable = addresses.filter((entry) => allowed(entry.address));
      const first = usable[0];
      if (!first || usable.length !== addresses.length)
        return callback(Object.assign(new Error("blocked"), { code: "EBLOCKED" }), "", 4);
      if (options.all) callback(null, usable);
      else callback(null, first.address, first.family);
    });
  };
  return (request: OutboundRequest) =>
    new Promise<{ status: number }>((done, reject) => {
      const url = new URL(request.url),
        host = url.hostname.replace(/^\[|\]$/g, "");
      if (url.protocol !== "https:" && url.protocol !== "http:")
        return reject(new DeliveryError("invalid_endpoint", false));
      if (isIP(host) && !allowed(host)) return reject(new DeliveryError("blocked_address", false));
      const send = url.protocol === "https:" ? tlsRequest : plainRequest;
      // One deadline covers DNS, connecting, and the response headers; the body is not read.
      const deadline = setTimeout(() => call.destroy(new DeliveryError("timeout", true)), timeout);
      const call = send(
        url,
        {
          method: "POST",
          lookup,
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Kanvil",
            ...request.headers,
            "Content-Length": Buffer.byteLength(request.body),
          },
        },
        (response) => {
          clearTimeout(deadline);
          response.destroy();
          done({ status: response.statusCode ?? 0 });
        },
      );
      call.on("error", (error: Error & { code?: string }) => {
        clearTimeout(deadline);
        reject(
          error instanceof DeliveryError
            ? error
            : error.code === "EBLOCKED"
              ? new DeliveryError("blocked_address", false)
              : new DeliveryError(error.code === "ENOTFOUND" ? "dns_error" : "network_error", true),
        );
      });
      call.end(request.body);
    });
}
// The instance's SMTP relay is operator configuration, so it is trusted like the database URL.
export function createMailSender(url: string, from: string) {
  const transport = nodemailer.createTransport(url);
  return async (message: MailMessage) => {
    try {
      await transport.sendMail({ from, ...message });
    } catch (error) {
      const code =
        error && typeof error === "object" && "responseCode" in error
          ? Number(error.responseCode)
          : 0;
      throw new DeliveryError(code ? `smtp_${code}` : "smtp_error", code < 500 || code >= 600);
    }
  };
}
