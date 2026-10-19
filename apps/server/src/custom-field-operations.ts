import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  customFieldFilterTokens,
  customFieldLimit,
  customFieldSchema,
  customFieldValueSchema,
  filterList,
  parseCustomFieldFilter,
  type CustomField,
  type CustomFieldValue,
} from "@kanvil/contracts";
import { customFields, tickets } from "./schema.ts";
import { customFieldPositions, endPosition, positionNear } from "./ordering.ts";
import { rememberLabelColor, rewriteViewFilters } from "./label-operations.ts";
import {
  assertVersion,
  assertWorkerClaim,
  fail,
  one,
  project,
  publish,
  publishMany,
  type Context,
  type Handlers,
  type PendingEvent,
} from "./domain.ts";

type Values = Record<string, CustomFieldValue>;
// Rows store the type as text; the contract narrows it and drops the storage-only position.
const toField = (row: typeof customFields.$inferSelect): CustomField =>
  customFieldSchema.parse(row);
const choices = (field: Pick<CustomField, "type">) =>
  field.type === "select" || field.type === "multiselect";
function invalid(path: string, message: string): never {
  return fail(400, "validation_error", message, [{ path, message }]);
}
function parseValue(field: CustomField, value: unknown, path: string) {
  const parsed = customFieldValueSchema(field).safeParse(value);
  if (!parsed.success)
    invalid(path, `${field.name}: ${parsed.error.issues[0]?.message ?? "Invalid value"}`);
  return parsed.data;
}

export async function projectCustomFields(ctx: Context) {
  const rows = await ctx.db
    .select()
    .from(customFields)
    .where(eq(customFields.projectId, project(ctx).id))
    .orderBy(asc(customFields.position), asc(customFields.name));
  return rows.map(toField);
}
async function getField(ctx: Context, fieldId: string, expectedVersion?: number) {
  const field = one(
    await ctx.db
      .select()
      .from(customFields)
      .where(
        and(
          eq(customFields.projectId, project(ctx).id),
          sql`${customFields.id}::text = ${fieldId}`,
        ),
      ),
  );
  if (expectedVersion !== undefined) assertVersion(field, expectedVersion, "field", "saving");
  return toField(field);
}
async function availableName(ctx: Context, name: string, exceptId?: string) {
  const taken = await ctx.db
    .select({ id: customFields.id })
    .from(customFields)
    .where(
      and(
        eq(customFields.projectId, project(ctx).id),
        sql`lower(${customFields.name}) = lower(${name})`,
        exceptId ? ne(customFields.id, exceptId) : undefined,
      ),
    );
  if (taken.length)
    fail(409, "duplicate_field", "A field with this name already exists in this project.");
}
// A definition the server accepts: options only on choice fields, no required checkbox (an
// unchecked box is no value), and a default the field itself could hold.
async function definition(
  ctx: Context,
  field: Omit<CustomField, "defaultValue" | "options"> & {
    options: { id?: string | undefined; name: string; color: string }[];
  },
  defaultValue: unknown,
): Promise<CustomField> {
  if (field.options.length && !choices(field))
    invalid("options", "Only select and multi-select fields have options");
  if (field.required && field.type === "checkbox")
    invalid("required", "A checkbox cannot be required");
  const options = field.options.map((option) => ({
    id: option.id ?? crypto.randomUUID(),
    name: option.name,
    color: option.color,
  }));
  for (const option of options) await rememberLabelColor(ctx, option.color);
  const next = customFieldSchema.parse({ ...field, options, defaultValue: null });
  return { ...next, defaultValue: parseValue(next, defaultValue, "defaultValue") };
}

// Applies a write's values to a ticket's current ones. Each named field must belong to the project
// and take its type; null or an empty value clears it. A new ticket (`current` null) takes the
// default of every field it omits, and a required field must end with a value.
export function applyCustomFieldValues(
  fields: CustomField[],
  current: Values | null,
  changes: Record<string, CustomFieldValue | null>,
): Values {
  const next: Values = { ...current };
  for (const [id, value] of Object.entries(changes)) {
    const field = fields.find((item) => item.id === id),
      path = `customFields.${id}`;
    if (!field) invalid(path, "This project has no such custom field");
    const parsed = parseValue(field, value, path);
    if (parsed !== null) next[id] = parsed;
    else if (field.required) invalid(path, `${field.name} is required`);
    else delete next[id];
  }
  if (!current)
    for (const field of fields)
      if (!Object.hasOwn(changes, field.id))
        if (field.defaultValue !== null) next[field.id] = field.defaultValue;
        else if (field.required) invalid(`customFields.${field.id}`, `${field.name} is required`);
  return next;
}

// Filters may only name fields of the given projects, with a value their type can hold.
export async function assertCustomFieldFilters(
  ctx: Context,
  projectIds: string[],
  filter: Partial<Record<"customField" | "customFieldNot", string | string[] | undefined>>,
) {
  const values = [...filterList(filter.customField), ...filterList(filter.customFieldNot)];
  if (!values.length) return;
  const ids = [...new Set(values.map((value) => parseCustomFieldFilter(value).fieldId))];
  const fields = (
    await ctx.db
      .select()
      .from(customFields)
      .where(
        and(
          inArray(sql`${customFields.id}::text`, ids),
          inArray(customFields.projectId, projectIds),
        ),
      )
  ).map(toField);
  for (const value of values) {
    const { fieldId, token } = parseCustomFieldFilter(value),
      field = fields.find((item) => item.id === fieldId);
    if (!field) invalid("customField", "Filter on a custom field of an accessible project");
    const fits =
      token === customFieldFilterTokens.empty ||
      (token === customFieldFilterTokens.checked
        ? field.type === "checkbox"
        : field.options.some((option) => option.id === token));
    if (!fits) invalid("customField", `${field.name} has no such value`);
  }
}
// One filter value: no stored value, a checked box, or an option the value is or contains.
function customFieldMatch(value: string) {
  const { fieldId, token } = parseCustomFieldFilter(value),
    stored = sql`${tickets.customFields} -> ${fieldId}`;
  if (token === customFieldFilterTokens.empty) return sql`${stored} IS NULL`;
  if (token === customFieldFilterTokens.checked)
    return sql`coalesce(${stored} = 'true'::jsonb, false)`;
  return sql`coalesce(${stored} @> to_jsonb(${token}::text), false)`;
}
// Values of one field match any of theirs; different fields must all match. Excluding a value
// keeps tickets without one, like the other filters.
export function customFieldPredicate(operator: "any" | "none", values: string[]) {
  if (operator === "none")
    return and(...values.map((value) => sql`NOT (${customFieldMatch(value)})`));
  const byField = new Map<string, string[]>();
  for (const value of values) {
    const { fieldId } = parseCustomFieldFilter(value);
    byField.set(fieldId, [...(byField.get(fieldId) ?? []), value]);
  }
  return and(...[...byField.values()].map((group) => or(...group.map(customFieldMatch))));
}

// Rewrites one field's value on every ticket of the project that holds it, with the version bump
// and event of a ticket edit. `map` returns the new value, or null to clear it.
async function rewriteTicketValues(
  ctx: Context,
  fieldId: string,
  map: (value: CustomFieldValue) => CustomFieldValue | null,
) {
  const affected = await ctx.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, project(ctx).id), sql`${tickets.customFields} ? ${fieldId}`));
  const pending: PendingEvent[] = [];
  for (const ticket of affected) {
    const value = ticket.customFields[fieldId];
    if (value === undefined) continue;
    const next = map(value);
    if (JSON.stringify(next) === JSON.stringify(value)) continue;
    await assertWorkerClaim(ctx, ticket);
    const values = { ...ticket.customFields };
    if (next === null) delete values[fieldId];
    else values[fieldId] = next;
    const row = one(
      await ctx.db
        .update(tickets)
        .set({ customFields: values, version: ticket.version + 1, updatedAt: new Date() })
        .where(eq(tickets.id, ticket.id))
        .returning(),
    );
    pending.push({
      type: "ticket.updated",
      ticketId: row.id,
      data: { version: row.version, changedFields: ["customFields"] },
    });
  }
  await publishMany(ctx, pending);
}
// Moves values off removed options: each goes to its `reassign` target, or away when that is null.
function reassigned(value: CustomFieldValue, reassign: Map<string, string | null>) {
  const move = (id: string) => (reassign.has(id) ? (reassign.get(id) ?? null) : id);
  if (Array.isArray(value)) {
    const ids = [...new Set(value.map(move).filter((id): id is string => id !== null))];
    return ids.length ? ids : null;
  }
  return typeof value === "string" ? move(value) : value;
}
const holds = (value: CustomFieldValue | null | undefined, optionId: string) =>
  Array.isArray(value) ? value.includes(optionId) : value === optionId;
const usageRow = z.object({ id: z.string(), count: z.coerce.number().int() });
const event = (field: CustomField, data: Record<string, unknown> = {}) => ({
  fieldId: field.id,
  name: field.name,
  version: field.version,
  ...data,
});

export const customFieldHandlers: Pick<
  Handlers,
  | "list_custom_fields"
  | "create_custom_field"
  | "update_custom_field"
  | "move_custom_field"
  | "delete_custom_field"
> = {
  async list_custom_fields(ctx) {
    const fields = await projectCustomFields(ctx);
    const usage = (
      await ctx.db.execute(sql`SELECT field.id, count(*) AS count
        FROM ${tickets}, jsonb_object_keys(${tickets.customFields}) AS field(id)
        WHERE ${tickets.projectId} = ${project(ctx).id} GROUP BY field.id`)
    ).rows.map((row) => usageRow.parse(row));
    return fields.map((field) => ({
      ...field,
      count: usage.find((row) => row.id === field.id)?.count ?? 0,
    }));
  },
  async create_custom_field(ctx, input) {
    const projectId = project(ctx).id;
    const existing = await ctx.db
      .select({ id: customFields.id })
      .from(customFields)
      .where(eq(customFields.projectId, projectId));
    if (existing.length >= customFieldLimit)
      invalid("name", `A project holds at most ${customFieldLimit} custom fields`);
    await availableName(ctx, input.name);
    const field = await definition(
      ctx,
      {
        id: crypto.randomUUID(),
        projectId,
        name: input.name,
        type: input.type,
        options: input.options,
        required: input.required,
        version: 1,
      },
      input.defaultValue,
    );
    const row = toField(
      one(
        await ctx.db
          .insert(customFields)
          .values({
            ...field,
            position: endPosition(customFieldPositions, eq(customFields.projectId, projectId)),
          })
          .returning(),
      ),
    );
    await publish(ctx, "custom_field.created", null, event(row));
    return row;
  },
  async update_custom_field(ctx, input) {
    const current = await getField(ctx, input.fieldId, input.expectedVersion);
    if (input.name !== undefined) await availableName(ctx, input.name, current.id);
    const options = input.options ?? current.options,
      kept = new Set(options.flatMap((option) => (option.id ? [option.id] : []))),
      removed = current.options.filter((option) => !kept.has(option.id)),
      reassign = new Map(Object.entries(input.reassign ?? {}));
    for (const [id, target] of reassign) {
      if (!removed.some((option) => option.id === id))
        invalid(`reassign.${id}`, "Reassign only options this change removes");
      if (target !== null && !kept.has(target))
        invalid(`reassign.${id}`, "Reassign to an option the field keeps");
    }
    // A removed option that values still hold needs an explicit destination, so nothing is lost
    // silently.
    const holders = removed.length
      ? await ctx.db
          .select({ values: tickets.customFields })
          .from(tickets)
          .where(
            and(
              eq(tickets.projectId, project(ctx).id),
              sql`${tickets.customFields} ? ${current.id}`,
            ),
          )
      : [];
    for (const option of removed) {
      if (reassign.has(option.id)) continue;
      const used = holders.filter((row) => holds(row.values[current.id], option.id)).length;
      if (used || (input.defaultValue === undefined && holds(current.defaultValue, option.id)))
        invalid(
          `reassign.${option.id}`,
          `${used ? `${used} ${used === 1 ? "ticket uses" : "tickets use"}` : "The default uses"} ${option.name}; reassign it to another option or to null to clear it`,
        );
    }
    const next = await definition(
      ctx,
      {
        ...current,
        name: input.name ?? current.name,
        options,
        required: input.required ?? current.required,
      },
      input.defaultValue !== undefined
        ? input.defaultValue
        : current.defaultValue === null
          ? null
          : reassigned(current.defaultValue, reassign),
    );
    const row = toField(
      one(
        await ctx.db
          .update(customFields)
          .set({
            name: next.name,
            options: next.options,
            required: next.required,
            defaultValue: next.defaultValue,
            version: current.version + 1,
          })
          .where(eq(customFields.id, current.id))
          .returning(),
      ),
    );
    if (reassign.size) {
      await rewriteTicketValues(ctx, current.id, (value) => reassigned(value, reassign));
      await rewriteViewFilters(ctx, "customField", (value) => {
        const { fieldId, token } = parseCustomFieldFilter(value);
        if (fieldId !== current.id || !reassign.has(token)) return value;
        const target = reassign.get(token);
        return target ? `${fieldId}:${target}` : null;
      });
    }
    await publish(ctx, "custom_field.updated", null, event(row, { previousName: current.name }));
    return row;
  },
  async move_custom_field(ctx, input) {
    const current = await getField(ctx, input.fieldId, input.expectedVersion);
    const anchor = await getField(ctx, input.before ?? input.after ?? "");
    if (anchor.id === current.id) invalid("before", "A field cannot be placed next to itself");
    const row = toField(
      one(
        await ctx.db
          .update(customFields)
          .set({
            position: await positionNear(
              ctx,
              customFieldPositions,
              current.id,
              anchor.id,
              input.before ? "before" : "after",
            ),
            version: current.version + 1,
          })
          .where(eq(customFields.id, current.id))
          .returning(),
      ),
    );
    await publish(ctx, "custom_field.updated", null, event(row, { changedFields: ["position"] }));
    return row;
  },
  async delete_custom_field(ctx, input) {
    const field = await getField(ctx, input.fieldId, input.expectedVersion);
    await rewriteTicketValues(ctx, field.id, () => null);
    await rewriteViewFilters(ctx, "customField", (value) =>
      parseCustomFieldFilter(value).fieldId === field.id ? null : value,
    );
    await ctx.db.delete(customFields).where(eq(customFields.id, field.id));
    await publish(ctx, "custom_field.deleted", null, event(field));
    return { ok: true };
  },
};
