// Watches the real boundaries test code reaches in this process: outbound sockets, listening
// sockets, DNS lookups, and child processes. Every attempt is counted; an attempt outside the
// allowed boundaries is refused and recorded, so a test fails even when the code under test
// catches the refusal. Installed once per process; callers switch the allowed set per family.
import childProcess from "node:child_process";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net, { isIP } from "node:net";

// database: the dedicated test PostgreSQL server; loopback: fakes and services on this machine;
// network: any other host; process: child processes.
export const boundaries = ["database", "loopback", "network", "process"] as const;
export type Boundary = (typeof boundaries)[number];
// Besides attempts per boundary: listening sockets, DNS lookups, and the disposable databases
// test fixtures create and migrate. Browser cases add their contexts, pages, and sign-in form
// submissions (e2e/test.ts).
export const countNames = [
  ...boundaries,
  "listen",
  "dns",
  "databases",
  "migrations",
  "contexts",
  "pages",
  "signInForms",
] as const;
export type Counts = Partial<Record<(typeof countNames)[number], number>>;
export interface Violation {
  boundary: Boundary;
  target: string;
}
interface State {
  allow: ReadonlySet<Boundary>;
  counts: Counts;
  violations: Violation[];
}
const key = Symbol.for("kanvil.test.boundaries");
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function classifyTarget(host: string | undefined, port: number | undefined): Boundary {
  const database = new URL(
      process.env.TEST_DATABASE_URL ?? "postgres://kanvil:kanvil@127.0.0.1:55462/kanvil",
    ),
    name = (host ?? "localhost").replace(/^\[|\]$/g, "");
  if (
    Number(port) === Number(database.port || 5432) &&
    (name === database.hostname || loopbackHosts.has(name))
  )
    return "database";
  return loopbackHosts.has(name) ? "loopback" : "network";
}

// Test files can load this module more than once per process, so the state lives on globalThis.
function isState(value: unknown): value is State {
  return typeof value === "object" && value !== null && "violations" in value;
}
function state(): State {
  const existing: unknown = Reflect.get(globalThis, key);
  if (isState(existing)) return existing;
  const current: State = { allow: new Set(boundaries), counts: {}, violations: [] };
  Reflect.set(globalThis, key, current);
  install(current);
  return current;
}
function attempt(
  current: State,
  boundary: Boundary,
  target: string,
  kind: (typeof countNames)[number] = boundary,
) {
  current.counts[kind] = (current.counts[kind] ?? 0) + 1;
  if (current.allow.has(boundary)) return undefined;
  current.violations.push({ boundary, target });
  return new Error(`Test boundary refused: ${boundary} ${target} is not allowed for this test`);
}
// Wraps a method or exported function in place, keeping its type.
function replace<T extends object>(owner: T, name: keyof T & string, handler: ProxyHandler<never>) {
  const original: unknown = Reflect.get(owner, name);
  if (typeof original === "function")
    Object.defineProperty(owner, name, {
      value: new Proxy(original, handler),
      writable: true,
      configurable: true,
    });
}
// Socket connect takes (options, callback), (port, host, callback), (path, callback), or the
// normalized [options, callback] array net.connect passes.
function connectTarget(args: unknown[]) {
  const head: unknown = args[0];
  const first: unknown = Array.isArray(head) ? head[0] : head;
  const callback: unknown = Array.isArray(head)
    ? head[1]
    : args.find((arg) => typeof arg === "function");
  if (typeof first === "string") return { path: first, options: {}, callback };
  if (typeof first === "number")
    return {
      port: first,
      host: typeof args[1] === "string" ? args[1] : undefined,
      options: {},
      callback,
    };
  const options: object = typeof first === "object" && first !== null ? first : {};
  const read = (name: string) => {
    const value: unknown = Reflect.get(options, name);
    return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  };
  return { port: Number(read("port")), host: read("host"), path: read("path"), options, callback };
}
// Lookup results are one address or, with `all`, a list of them.
function resolvedAddresses(address: unknown): string[] {
  if (typeof address === "string") return [address];
  if (!Array.isArray(address)) return [];
  return address.flatMap((entry: unknown) => {
    const value: unknown =
      typeof entry === "object" && entry !== null ? Reflect.get(entry, "address") : undefined;
    return typeof value === "string" ? [value] : [];
  });
}

function install(current: State) {
  replace(net.Socket.prototype, "connect", {
    apply(target: () => unknown, socket: net.Socket, args: unknown[]) {
      const { path, host, port, options, callback } = connectTarget(args);
      if (host && !isIP(host) && !loopbackHosts.has(host)) {
        // A host name crosses a boundary when it resolves to an address the socket connects to;
        // an injected resolver that answers without DNS reaches nothing.
        const custom: unknown = Reflect.get(options, "lookup");
        const resolve = typeof custom === "function" ? custom : dns.lookup;
        const lookup = (
          hostname: string,
          lookupOptions: unknown,
          done: (...result: unknown[]) => void,
        ) =>
          Reflect.apply(resolve, undefined, [
            hostname,
            lookupOptions,
            (error: unknown, address: unknown, family: unknown) => {
              if (error) return done(error, address, family);
              const refused = resolvedAddresses(address)
                .map((resolved) =>
                  attempt(
                    current,
                    classifyTarget(resolved, port),
                    `${hostname} (${resolved}):${port}`,
                  ),
                )
                .find(Boolean);
              done(refused ?? null, address, family);
            },
          ]);
        return Reflect.apply(target, socket, [{ ...options, host, port, lookup }, callback]);
      }
      // A Unix socket is this machine's database server or a local fake, never another host.
      const boundary = path
        ? path.includes(".s.PGSQL.")
          ? "database"
          : "loopback"
        : classifyTarget(host, port);
      const refused = attempt(current, boundary, path ?? `${host ?? "localhost"}:${port}`);
      if (!refused) return Reflect.apply(target, socket, args);
      process.nextTick(() => socket.destroy(refused));
      return socket;
    },
  });
  replace(net.Server.prototype, "listen", {
    apply(target: () => unknown, server: net.Server, args: unknown[]) {
      const first: unknown = args[0];
      const option: unknown =
        typeof first === "object" && first !== null ? Reflect.get(first, "host") : undefined;
      const host = typeof args[1] === "string" ? args[1] : typeof option === "string" ? option : "";
      const refused = attempt(
        current,
        !host || loopbackHosts.has(host) ? "loopback" : "network",
        `listen ${host || "*"}`,
        "listen",
      );
      if (refused) throw refused;
      return Reflect.apply(target, server, args);
    },
  });
  const lookupAttempt = (hostname: unknown) =>
    typeof hostname === "string" && loopbackHosts.has(hostname)
      ? undefined
      : attempt(current, "network", `dns ${String(hostname)}`, "dns");
  replace(dns, "lookup", {
    apply(target: () => unknown, owner: unknown, args: unknown[]) {
      const refused = lookupAttempt(args[0]);
      const callback: unknown = args.at(-1);
      if (!refused) return Reflect.apply(target, owner, args);
      if (typeof callback === "function")
        process.nextTick(() => Reflect.apply(callback, undefined, [refused]));
      return undefined;
    },
  });
  replace(dns.promises, "lookup", {
    apply(target: () => unknown, owner: unknown, args: unknown[]) {
      const refused = lookupAttempt(args[0]);
      return refused ? Promise.reject(refused) : Reflect.apply(target, owner, args);
    },
  });
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ] as const)
    replace(childProcess, name, {
      apply(target: () => unknown, owner: unknown, args: unknown[]) {
        const refused = attempt(current, "process", `${name} ${String(args[0])}`);
        if (refused) throw refused;
        return Reflect.apply(target, owner, args);
      },
    });
  // ES module imports of these built-ins read the replaced functions too.
  syncBuiltinESMExports();
}

// Counts fixture work that sockets alone do not reveal.
export function recordBoundary(kind: "databases" | "migrations") {
  const current = state();
  current.counts[kind] = (current.counts[kind] ?? 0) + 1;
}

// Sets the boundaries the current family may reach and returns a recorder for its activity.
export function watchBoundaries(allow: Iterable<Boundary>) {
  const current = state();
  current.allow = new Set(allow);
  current.counts = {};
  current.violations = [];
  return {
    // Everything recorded since the last take, left in place.
    peek: () => ({ counts: { ...current.counts }, violations: [...current.violations] }),
    // Returns and clears what happened since the last call.
    take() {
      const taken = { counts: current.counts, violations: current.violations };
      current.counts = {};
      current.violations = [];
      return taken;
    },
  };
}
