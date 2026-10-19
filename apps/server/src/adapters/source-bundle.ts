// What the Linear and Jira readers share: reading one response with retries, the errors a source
// answers with, and assembling what they read into a `kanvil.tickets` bundle.
import {
  ApiError,
  defaultWorkflow,
  importLimits,
  importProviderDefinitions,
  ticketExportFormat,
  type ImportProvider,
  type TicketExport,
  type states,
} from "@kanvil/contracts";
import type { z } from "zod";
import { DeliveryError } from "./outbound.ts";
import type { OutboundRequest, OutboundResponse, OutboundSenders } from "./ports.ts";

export type SourceHttp = OutboundSenders["http"];
// How a reader judges one response: `limited` and `failing` are retried, the rest are final.
export type Outcome = "ok" | "limited" | "failing" | "invalid" | "rejected" | "not_found";
export const byStatus = (status: number): Outcome =>
  status >= 200 && status < 300
    ? "ok"
    : status === 401 || status === 403
      ? "rejected"
      : status === 404
        ? "not_found"
        : status === 429
          ? "limited"
          : status >= 500
            ? "failing"
            : "invalid";
const attempts = 4;
// The source's `Retry-After` when it sends one, up to 30 seconds; otherwise 1, 2, then 4 seconds.
function delay(response: OutboundResponse | undefined, attempt: number) {
  const header = response?.headers?.["retry-after"],
    value = Array.isArray(header) ? header[0] : header;
  const seconds =
    value === undefined
      ? Number.NaN
      : /^\d+$/.test(value)
        ? Number(value)
        : (Date.parse(value) - Date.now()) / 1000;
  return Math.min(Number.isFinite(seconds) ? Math.max(seconds, 0) : 2 ** (attempt - 1), 30) * 1000;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const unreadable = (provider: ImportProvider) =>
  new ApiError(
    502,
    "source_unavailable",
    `${importProviderDefinitions[provider].label} sent a response Kanvil cannot read`,
  );
// What a source sent, in the shape a reader expects; anything else is an unreadable answer.
export function readable<T extends z.ZodType>(
  provider: ImportProvider,
  schema: T,
  data: unknown,
): z.output<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw unreadable(provider);
  return parsed.data;
}

// Reads one JSON response. Rate limits, server errors, and dropped connections wait and retry;
// what is still failing after four attempts, and every refusal, ends the read with an error that
// names the source but never repeats the credentials or what the source answered.
export async function readSource(
  http: SourceHttp,
  provider: ImportProvider,
  request: OutboundRequest,
  judge: (status: number, data: unknown) => Outcome = byStatus,
): Promise<unknown> {
  const { label, project } = importProviderDefinitions[provider];
  for (let attempt = 1; ; attempt++) {
    let response: OutboundResponse;
    try {
      response = await http({ ...request, read: true });
    } catch (error) {
      if (!(error instanceof DeliveryError)) throw error;
      // A host that does not answer or resolve would only make the person wait longer.
      if (error.code === "network_error" && attempt < attempts) {
        await wait(delay(undefined, attempt));
        continue;
      }
      throw new ApiError(
        502,
        "source_unavailable",
        `${label} could not be reached (${error.code})`,
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(response.body ?? "");
    } catch {
      data = undefined;
    }
    const outcome = judge(response.status, data);
    if (outcome === "ok") {
      if (data === undefined) throw unreadable(provider);
      return data;
    }
    if ((outcome === "limited" || outcome === "failing") && attempt < attempts) {
      await wait(delay(response, attempt));
      continue;
    }
    if (outcome === "rejected")
      throw new ApiError(
        422,
        "source_rejected",
        `${label} refused these credentials, or they cannot read this ${project.toLowerCase()}`,
      );
    if (outcome === "not_found")
      throw new ApiError(404, "not_found", `${label} has no such ${project.toLowerCase()}`);
    if (outcome === "limited")
      throw new ApiError(
        429,
        "source_rate_limited",
        `${label} is limiting requests; try again later`,
      );
    throw new ApiError(
      502,
      "source_unavailable",
      `${label} answered with an error (${response.status})`,
    );
  }
}

// A source state named like a default state takes that state's category, so it maps onto it.
export const category = (name: string, fallback: (typeof states)[number]) =>
  defaultWorkflow.find((state) => state.name.toLowerCase() === name.trim().toLowerCase())
    ?.category ?? fallback;
// A source date (YYYY-MM-DD) is due at the end of that day.
export const dueAt = (date: string | null | undefined) =>
  date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T23:59:59.999Z` : null;
// Source timestamps in UTC; Jira writes offsets without a colon, such as +0000.
export const isoTime = (value: string) =>
  new Date(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")).toISOString();
// Issues of a bug type or with a bug label are bugs; the rest are features.
export const kindOf = (names: string[]) =>
  names.some((name) => name.trim().toLowerCase() === "bug") ? "bug" : "feature";
export const hexOrGray = (color: string | null | undefined) =>
  color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : "gray";
export interface Person {
  ref: string;
  name: string;
  email: string;
}
type Omitted = TicketExport["completeness"]["omitted"][number];

// Collects what a reader translates and assembles the bundle. What Kanvil cannot hold is counted
// with `note` and listed among the preview's warnings, and an item over an import limit stops the
// read, so nothing is dropped silently.
export function bundleBuilder(provider: ImportProvider) {
  const { label, project } = importProviderDefinitions[provider];
  const people = new Map<string, Person>(),
    labels = new Map<string, TicketExport["labels"][number]>(),
    notes = new Map<string, Omitted>();
  const tickets: TicketExport["tickets"] = [],
    relations: TicketExport["relations"] = [],
    comments: TicketExport["comments"] = [];
  const within = (size: number, limit: number, what: string) => {
    if (size >= limit)
      throw new ApiError(
        400,
        "validation_error",
        `This ${project.toLowerCase()} has more ${what} than an import holds (${limit})`,
      );
  };
  // Counts content the import leaves out or changes; a null count says the source was not counted.
  const note = (content: string, reason: string, count: number | null = 1) => {
    const entry = notes.get(content) ?? { content, count: count === null ? null : 0, reason };
    if (entry.count !== null && count !== null) entry.count += count;
    notes.set(content, entry);
  };
  const clip = (value: string, max: number) => {
    if (value.length <= max) return value;
    note(
      "shortened text",
      "Titles, descriptions, comments, or label names longer than Kanvil holds were cut at its limit.",
    );
    return value.slice(0, max);
  };
  return {
    note,
    clip,
    // The ref of a person a record names, or null for none.
    person(person: Person | null | undefined) {
      if (!person) return null;
      if (!people.has(person.ref)) {
        within(people.size, importLimits.members, "people");
        people.set(person.ref, person);
      }
      return person.ref;
    },
    // A ticket's label names; each label keeps the color of its first use.
    labels(items: { name: string; color?: string | null }[]) {
      const names: string[] = [];
      for (const item of items) {
        const name = clip(item.name.trim(), 40);
        if (!name || names.includes(name)) continue;
        if (!labels.has(name)) {
          within(labels.size, importLimits.labels, "labels");
          labels.set(name, { name, color: hexOrGray(item.color) });
        }
        names.push(name);
      }
      if (names.length > 30)
        note("labels past 30", "A ticket holds 30 labels; issues with more keep their first 30.");
      return names.slice(0, 30);
    },
    ticket(ticket: TicketExport["tickets"][number]) {
      within(tickets.length, importLimits.tickets, "issues");
      tickets.push(ticket);
    },
    relation(relation: TicketExport["relations"][number]) {
      within(relations.length, importLimits.relations, "relationships");
      relations.push(relation);
    },
    comment(comment: TicketExport["comments"][number]) {
      within(comments.length, importLimits.comments, "comments");
      comments.push(comment);
    },
    build(
      source: { ref: string; key: string; name: string; description: string },
      workflow: TicketExport["workflow"],
    ): TicketExport {
      return {
        format: ticketExportFormat,
        version: 1,
        exportedAt: new Date().toISOString(),
        project: {
          ref: source.ref,
          key: source.key.slice(0, 20),
          name: clip(source.name.trim(), 120) || label,
          description: clip(source.description, 5000),
        },
        completeness: { omitted: [...notes.values()] },
        members: [...people.values()],
        workflow,
        customFields: [],
        labels: [...labels.values()],
        tickets,
        relations,
        comments,
        evidence: [],
        resources: [],
      };
    },
  };
}
export type BundleBuilder = ReturnType<typeof bundleBuilder>;
// A ticket with the fields no source sets.
export const sourceTicket = (
  ticket: Pick<
    TicketExport["tickets"][number],
    | "ref"
    | "key"
    | "title"
    | "description"
    | "priority"
    | "kind"
    | "labels"
    | "stateRef"
    | "assigneeRef"
    | "parentRef"
    | "createdByRef"
    | "createdAt"
    | "dueAt"
    | "archived"
  >,
): TicketExport["tickets"][number] => ({
  acceptanceCriteria: "",
  difficulty: null,
  scopes: [],
  automationReady: false,
  holdReason: null,
  startAt: null,
  customFields: {},
  ...ticket,
});
