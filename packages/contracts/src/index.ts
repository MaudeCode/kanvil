import { authenticationPolicySchema } from "./instance.ts";
import type { palettes } from "./theme.ts";
import { z } from "zod";
import {
  activeLocale,
  defaultLocale,
  formatDate,
  formatList,
  formatNumber,
  labelTable,
  t,
} from "./i18n/index.ts";

// The canonical statuses. A project's workflow states each map to one of them, and every rule that
// reads a ticket's `status` (open, closed, readiness, claims, filters) reads this category.
export const states = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"] as const;
// Statuses that end work; "open" everywhere means not one of these.
export const closedStates = ["done", "cancelled"] as const;
export const priorities = ["urgent", "high", "medium", "low", "none"] as const;
export const kinds = ["feature", "bug", "chore", "research", "documentation"] as const;
export const difficulties = ["low", "med", "high"] as const;
export const roles = ["reader", "writer", "admin"] as const;
export type Role = (typeof roles)[number];
export const roleLabels = labelTable(roles, (role) => t(`common.role.${role}`));
export const kindLabels = labelTable(kinds, (kind) => t(`common.kind.${kind}`));
export const difficultyLabels = labelTable(difficulties, (level) =>
  t(`common.difficulty.${level}`),
);
// The actions a role grants beyond reading. The seeded roles are fixed sets; a workspace defines
// custom roles as any subset. Credential scopes stay a ceiling: `ticket.write` needs `write`, every
// other action `admin`.
export const permissions = [
  "ticket.write",
  "ticket.delete",
  "project.manage",
  "member.manage",
  "invitation.manage",
  "sharing.manage",
  "workspace.manage",
] as const;
export type Permission = (typeof permissions)[number];
export const permissionLabels = labelTable(permissions, (permission) => ({
  label: t(`common.permission.${permission}.label`),
  description: t(`common.permission.${permission}.description`),
}));
// The seeded roles' actions. Their IDs are their names; a custom role's ID is a UUID.
export const seededPermissions: Record<Role, readonly Permission[]> = {
  reader: [],
  writer: ["ticket.write"],
  admin: permissions,
};
export const roleId = z.union([z.enum(roles), z.uuid()]);
export const isSeededRole = (id: string): id is Role => roles.some((role) => role === id);
// The seeded role a custom role stands in for wherever only the three are known: stored beside
// every assignment and rewritten with the role, so it never disagrees. Never `admin`, which alone
// reaches a workspace's private projects.
export const roleCategory = (granted: readonly Permission[]): Role =>
  granted.includes("ticket.write") ? "writer" : "reader";
// What a membership may do. Servers that predate custom roles report only the seeded role.
export const capabilitiesOf = (access: {
  role: Role | null | undefined;
  capabilities?: readonly Permission[] | undefined;
}): readonly Permission[] =>
  access.capabilities ?? (access.role ? seededPermissions[access.role] : []);
export const projectIconColors = [
  "default",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
  "gray",
] as const;
// A preset name or a custom hex color such as #1e90ff. Custom colors used on a label are kept in
// the site-wide palette (`list_label_colors`).
export const hexColor = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i)
  .overwrite((value) => value.toLowerCase());
export const labelColor = z.union([z.enum(projectIconColors), hexColor]);
export type LabelColor = z.output<typeof labelColor>;
export const isPresetColor = (value: string): value is (typeof projectIconColors)[number] =>
  projectIconColors.some((tone) => tone === value);
export const isHexColor = (value: string) => hexColor.safeParse(value).success;
export const hasAdminRole = (role: string | null | undefined) =>
  role?.split(",").includes("admin") ?? false;
export const scopes = ["read", "write", "claim", "admin"] as const;
export const attachmentLimit = 10_000_000;
// An inline upload staged before its ticket exists stays claimable for this long.
export const stagedUploadLifetime = 86_400_000;
export const stateLabels = labelTable(states, (value) => t(`common.status.${value}`));
export const priorityLabels = labelTable(priorities, (value) => t(`common.priority.${value}`));
export const stateTones: Record<(typeof states)[number], keyof typeof palettes.light> = {
  backlog: "muted",
  todo: "foreground",
  in_progress: "warning",
  in_review: "accent",
  done: "success",
  cancelled: "muted",
};

const id = z.string().min(1).max(80);
const timestamp = z.iso.datetime();
const version = z.number().int().positive();
// A signed 32-bit second count keeps even the largest lease within JavaScript's date range.
export const claimLeaseSecondsSchema = z.number().int().min(30).max(2_147_483_647);
export const defaultClaimMaxLeaseSeconds = 86400;
const text = z.string().trim().min(1);
// PostgreSQL rejects year 0, which the ISO grammar allows. Start and due dates share it.
export const dueDate = z.iso
  .datetime()
  .refine((value) => new Date(value).getUTCFullYear() >= 1, "Use a date in year 1 or later");
const tags = z
  .array(text.max(40))
  .max(30)
  .overwrite((values) => [...new Set(values)]);
const labelFields = { id: z.uuid(), name: text.max(40), color: labelColor, version };
export const projectLabelSchema = z.object({ ...labelFields, projectId: z.uuid() });
export type ProjectLabel = z.output<typeof projectLabelSchema>;
// One named state of a project's workflow. Every category keeps at least one state, so a client
// that writes only `status` always lands on one: the first state of that category.
export const workflowStateSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  // Derived from the first name and never changed, so automation can name a state stably.
  slug: z.string(),
  name: text.max(40),
  category: z.enum(states),
  // "default" uses the category's own tint.
  color: labelColor,
  // The state's place within its category.
  position: z.number().int().nonnegative(),
  version,
});
export type WorkflowState = z.output<typeof workflowStateSchema>;
// The states a new project starts with. Clients show them for servers that predate workflows.
export const defaultWorkflow = states.map((category) => ({
  slug: category,
  name: stateLabels[category],
  category,
}));
// A state that still has its default name reads in the interface language; a renamed state shows
// the name its project gave it. `defaultWorkflow` holds the English names the server stores.
export const workflowStateName = (state: {
  slug: string;
  name: string;
  category: (typeof states)[number];
}) =>
  state.slug === state.category &&
  state.name === defaultWorkflow.find((item) => item.slug === state.category)?.name
    ? stateLabels[state.category]
    : state.name;
export const presentWorkflow = <
  S extends { slug: string; name: string; category: (typeof states)[number] },
>(
  workflow: S[],
) => workflow.map((state) => ({ ...state, name: workflowStateName(state) }));
// Workflow states list by category in canonical order, then by position.
const categoryRank = (category: string) => states.findIndex((state) => state === category);
export const workflowOrder = (
  a: { category: string; position: number },
  b: { category: string; position: number },
) => categoryRank(a.category) - categoryRank(b.category) || a.position - b.position;
// Shared by every project in the workspace; a name is defined by the workspace or by projects,
// never both.
export const workspaceLabelSchema = z.object({ ...labelFields, workspaceId: z.uuid() });
const labelCount = { count: z.number().int().nonnegative() };
const workspaceCatalogLabel = workspaceLabelSchema.extend({
  scope: z.literal("workspace"),
  ...labelCount,
});
// A project's catalog: its own labels and its workspace's, with ticket counts; `scope` names the owner.
export const catalogLabelSchema = z.discriminatedUnion("scope", [
  projectLabelSchema.extend({ scope: z.literal("project"), ...labelCount }),
  workspaceCatalogLabel,
]);
export type CatalogLabel = z.output<typeof catalogLabelSchema>;
// Typed project fields. The server owns each definition; a ticket keeps its values by field ID.
export const customFieldTypes = [
  "text",
  "number",
  "date",
  "checkbox",
  "select",
  "multiselect",
] as const;
export type CustomFieldType = (typeof customFieldTypes)[number];
export const customFieldTypeLabels = labelTable(customFieldTypes, (type) =>
  t(`common.customFieldType.${type}`),
);
export const customFieldLimit = 50;
export const customFieldOptionLimit = 100;
// Any stored value; `customFieldValueSchema` narrows it to one field's type and options. Dates are
// calendar days (YYYY-MM-DD), so they read the same in every time zone.
export const customFieldValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
export type CustomFieldValue = z.output<typeof customFieldValue>;
// Writes name fields by ID; null clears a value. Unnamed fields keep theirs.
const customFieldValues = z.record(z.uuid(), customFieldValue.nullable());
export const customFieldOptionSchema = z.object({
  id: z.uuid(),
  name: text.max(60),
  color: labelColor,
});
export const customFieldSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: text.max(60),
  type: z.enum(customFieldTypes),
  // Choices of a select or multi-select field, in display order. Their IDs never change.
  options: z.array(customFieldOptionSchema),
  // New tickets must have a value; existing tickets keep theirs until edited.
  required: z.boolean(),
  // Applied when a new ticket omits the field.
  defaultValue: customFieldValue.nullable(),
  version,
});
export type CustomField = z.output<typeof customFieldSchema>;
// An option list as an administrator saves it; a new option may bring its own ID or get one.
const customFieldOptions = z
  .array(
    z
      .object({ id: z.uuid().optional(), name: text.max(60), color: labelColor.default("gray") })
      .strict(),
  )
  .max(customFieldOptionLimit)
  .refine(
    (options) =>
      new Set(options.map((option) => option.name.toLowerCase())).size === options.length,
    "Option names must be unique",
  )
  .refine((options) => {
    const ids = options.flatMap((option) => (option.id ? [option.id] : []));
    return new Set(ids).size === ids.length;
  }, "Option IDs must be unique");
// An empty value is no value: an unchecked box, blank text, or no chosen options.
const emptyToNull = (value: CustomFieldValue | null) =>
  value === false || value === "" || (Array.isArray(value) && !value.length) ? null : value;
// The values one field accepts. Server validation, editors, and imports share it.
export function customFieldValueSchema(field: Pick<CustomField, "type" | "options">) {
  const option = z
    .string()
    .refine(
      (optionId) => field.options.some((choice) => choice.id === optionId),
      "Choose one of its options",
    );
  const typed: z.ZodType<CustomFieldValue> =
    field.type === "text"
      ? z.string().trim().max(1000)
      : field.type === "number"
        ? z.number()
        : field.type === "date"
          ? z.iso.date()
          : field.type === "checkbox"
            ? z.boolean()
            : field.type === "select"
              ? option
              : z
                  .array(option)
                  .max(customFieldOptionLimit)
                  .overwrite((ids) => [...new Set(ids)]);
  return typed.nullable().transform(emptyToNull);
}
const optionNames = (field: Pick<CustomField, "options">, value: CustomFieldValue) =>
  (Array.isArray(value) ? value : [value]).map(
    (optionId) =>
      field.options.find((choice) => choice.id === optionId)?.name ??
      t("common.customField.removedOption"),
  );
// One reading of a value for every client: lists, details, chips, and native screens.
export function formatCustomFieldValue(
  field: Pick<CustomField, "type" | "options">,
  value: CustomFieldValue | null | undefined,
): string {
  if (value === null || value === undefined) return "";
  switch (field.type) {
    case "number":
      return typeof value === "number" ? formatNumber(value) : String(value);
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? formatDate(`${value}T00:00:00`)
        : String(value);
    case "checkbox":
      return value === true ? t("common.customField.checked") : "";
    case "select":
    case "multiselect":
      return formatList(optionNames(field, value));
    default:
      return String(value);
  }
}
// A custom field filter names the field and one value: an option ID, `true` for a checked box, or
// `none` for no value.
export const customFieldFilterTokens = { empty: "none", checked: "true" } as const;
export const customFieldFilter = (fieldId: string, token: string) => `${fieldId}:${token}`;
export function parseCustomFieldFilter(value: string) {
  const at = value.indexOf(":");
  return { fieldId: value.slice(0, at), token: value.slice(at + 1) };
}
// The value half of a filter choice, and the whole choice as chips and pickers name it.
export function customFieldFilterChoice(
  field: Pick<CustomField, "type" | "options">,
  token: string,
) {
  if (token === customFieldFilterTokens.empty)
    return field.type === "checkbox" ? "Not checked" : "No value";
  if (token === customFieldFilterTokens.checked && field.type === "checkbox") return "Checked";
  return optionNames(field, token).join("");
}
export const customFieldFilterText = (
  field: Pick<CustomField, "name" | "type" | "options">,
  token: string,
) => `${field.name}: ${customFieldFilterChoice(field, token)}`;
const pagination = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};
const mutation = { requestId: z.uuid().optional() };
// Manual placement names one neighbor in the shared order, never a numeric position.
const placement = { before: id.optional(), after: id.optional() };
const oneNeighbor = (input: { before?: string | undefined; after?: string | undefined }) =>
  input.before === undefined || input.after === undefined;
const projectInput = z.object({ projectId: id });
const ticketInput = projectInput.extend({ ticketId: id });
// A ticket prefix. Each one a project ever had stays reserved for it, so issued keys keep resolving.
const projectKey = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/);
// Why a ticket is not ready, or cannot move; `ticketId` names the related ticket involved.
const readinessCodes = [
  "project_archived",
  "not_open",
  "not_enabled",
  "missing_description",
  "missing_acceptance_criteria",
  "missing_difficulty",
  "duplicate",
  "claim_recovery_required",
] as const;
// A readiness reason in the interface language; codes without wording keep the server's message.
export function readinessReasonText(
  reason: { code: string; message: string; ticketKey?: string | undefined },
  worker?: string,
) {
  const code = readinessCodes.find((known) => known === reason.code);
  if (code) return t(`common.readinessReason.${code}`);
  if (reason.code === "claimed" && worker) return t("common.readinessReason.claimed", { worker });
  if (reason.code === "dependency" && reason.ticketKey)
    return t("common.readinessReason.dependency", { key: reason.ticketKey });
  return reason.message;
}
const reason = z.object({
  code: z.string(),
  message: z.string(),
  ticketId: z.uuid().optional(),
  // The related ticket's key, so clients can word the reason themselves.
  ticketKey: z.string().optional(),
});
const projectRef = z.object({ id: z.uuid(), key: z.string(), name: z.string() });
// Filterable ticket fields. Each takes one value or a list (any of them), and its `Not` twin
// excludes values; the filters combine with AND. A legacy single value parses to a one-item list,
// so saved views and links keep their meaning. A new filterable field joins this catalog and gets
// both operators, its predicate, and its chip.
export const filterFieldNames = [
  "status",
  "priority",
  "kind",
  "difficulty",
  "label",
  "assigneeId",
  "customField",
] as const;
export type FilterField = (typeof filterFieldNames)[number];
export const filterFields = {
  status: z.enum(states),
  priority: z.enum(priorities),
  kind: z.enum(kinds),
  difficulty: z.enum(difficulties),
  label: z.string().max(40),
  // A user id, or "none" for unassigned tickets.
  assigneeId: z.union([id, z.literal("none")]),
  // `<field id>:<option id | true | none>`; values of one field match any, fields combine with AND.
  customField: z.string().regex(/^[0-9a-f-]{36}:(?:none|true|[0-9a-f-]{36})$/),
} satisfies Record<FilterField, z.ZodType<string>>;
export const filterFieldLabels = labelTable(filterFieldNames, (field) =>
  t(`common.filterField.${field}`),
);
export const filterOperators = ["any", "none"] as const;
export type FilterOperator = (typeof filterOperators)[number];
export const filterValueLimit = 25;
const filterValues = <T extends z.ZodType<string>>(value: T) =>
  z.union([value, z.array(value).min(1).max(filterValueLimit)]).optional();
// The distinct values of one filter, whether it holds a single value or a list.
export const filterList = <T extends string>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : [...new Set(Array.isArray(value) ? value : [value])];
const filterShape = {
  status: filterValues(filterFields.status),
  statusNot: filterValues(filterFields.status),
  priority: filterValues(filterFields.priority),
  priorityNot: filterValues(filterFields.priority),
  kind: filterValues(filterFields.kind),
  kindNot: filterValues(filterFields.kind),
  difficulty: filterValues(filterFields.difficulty),
  difficultyNot: filterValues(filterFields.difficulty),
  label: filterValues(filterFields.label),
  labelNot: filterValues(filterFields.label),
  assigneeId: filterValues(filterFields.assigneeId),
  assigneeIdNot: filterValues(filterFields.assigneeId),
  customField: filterValues(filterFields.customField),
  customFieldNot: filterValues(filterFields.customField),
};
export type FilterKey = keyof typeof filterShape;
export const filterKey = (field: FilterField, operator: FilterOperator): FilterKey =>
  operator === "any" ? field : `${field}Not`;
export type TicketPredicate = { field: FilterField; operator: FilterOperator; values: string[] };
type FilterValues = Partial<Record<FilterKey, string | string[] | undefined>>;
// The normalized predicates every consumer evaluates: the server query, chips, and counts.
export function ticketPredicates(filter: FilterValues): TicketPredicate[] {
  return filterFieldNames.flatMap((field) =>
    filterOperators.flatMap((operator) => {
      const values = filterList(filter[filterKey(field, operator)]);
      return values.length ? [{ field, operator, values }] : [];
    }),
  );
}
// A value cannot be both included and excluded.
function rejectConflicts(filter: FilterValues, context: z.RefinementCtx) {
  for (const field of filterFieldNames) {
    const excluded = new Set(filterList(filter[filterKey(field, "none")]));
    const both = filterList(filter[field]).filter((value) => excluded.has(value));
    if (both.length)
      context.addIssue({
        code: "custom",
        path: [field],
        message: `${filterFieldLabels[field]} cannot both include and exclude ${both.join(", ")}`,
      });
  }
}
// Up to 100 distinct tickets, each with the version the caller last saw.
const ticketSelection = z
  .array(z.object({ ticketId: id, expectedVersion: version }))
  .min(1)
  .max(100)
  .refine(
    (values) => new Set(values.map((v) => v.ticketId)).size === values.length,
    "Tickets must be unique",
  );
export const ticketFilter = z
  .object({
    q: z.string().trim().max(200).optional(),
    ...filterShape,
    parentId: id.optional(),
    archived: z.enum(["include", "only", "exclude"]).default("exclude"),
    due: z.enum(["overdue", "today", "week", "scheduled", "none"]).optional(),
    sort: z
      .enum([
        "priority",
        "updated",
        "created",
        "title",
        "labels",
        "due",
        "start",
        "number",
        "status",
        "difficulty",
        "kind",
        "assignee",
        "manual",
      ])
      .default("priority"),
    order: z.enum(["asc", "desc"]).optional(),
  })
  .strict()
  .superRefine(rejectConflicts);
export const sortLabels = labelTable(ticketFilter.shape.sort.unwrap().options, (sort) =>
  t(`common.sort.${sort}`),
);
// The direction each sort uses unless the caller sets `order`.
export const defaultOrder: Record<z.output<typeof ticketFilter>["sort"], "asc" | "desc"> = {
  priority: "asc",
  updated: "desc",
  created: "desc",
  title: "asc",
  labels: "asc",
  due: "asc",
  start: "asc",
  number: "asc",
  status: "asc",
  difficulty: "asc",
  kind: "asc",
  assignee: "asc",
  manual: "asc",
};
export const dueFilterLabels = labelTable(ticketFilter.shape.due.unwrap().options, (due) =>
  t(`common.due.${due}`),
);
export const ticketFields = z
  .object({
    title: text.max(500).overwrite((value) => value.replace(/\s+/gu, " ")),
    description: z.string().max(100_000),
    acceptanceCriteria: z.string().max(50_000),
    // The category of the ticket's workflow state. Writing it alone moves the ticket to that
    // category's first state, or keeps its state when the category is unchanged.
    status: z.enum(states),
    // The ticket's workflow state; its category must match `status` when both are written.
    stateId: z.uuid(),
    priority: z.enum(priorities),
    kind: z.enum(kinds),
    difficulty: z.enum(difficulties).nullable(),
    labels: tags,
    scopes: tags,
    assigneeId: z.string().nullable(),
    parentId: z.uuid().nullable(),
    automationReady: z.boolean(),
    holdReason: z.string().trim().max(2000).nullable(),
    // Clients store a start as the beginning of the chosen day and a due date as its end, both in
    // the author's zone, so either date is a whole day. A start may not follow the due date.
    startAt: dueDate.nullable(),
    dueAt: dueDate.nullable(),
    archived: z.boolean(),
    customFields: customFieldValues,
  })
  .strict();
export const ticketChanges = ticketFields
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one change");
export const workspaceSchema = z.object({
  id: z.uuid(),
  slug: text.max(80),
  name: text.max(120),
  description: z.string(),
  // The administrator who alone transfers or deletes the workspace; null until an instance
  // administrator assigns one. Servers that predate ownership omit it.
  ownerId: z.string().nullable().default(null),
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
  role: z.enum(roles).nullable(),
  // The membership's role and what it may do here, capped by the credential's scopes. `role` is
  // the seeded role a custom one stands in for. Older servers omit both; see `capabilitiesOf`.
  roleId: z.string().nullable().optional(),
  capabilities: z.array(z.enum(permissions)).optional(),
});
export type Workspace = z.output<typeof workspaceSchema>;
// A seeded role or one the workspace defined. `assigned` counts the workspace and project
// memberships that hold it; deleting an assigned role names the role they move to.
export const workspaceRoleSchema = z.object({
  id: roleId,
  name: z.string(),
  permissions: z.array(z.enum(permissions)),
  seeded: z.boolean(),
  assigned: z.number().int().nonnegative(),
  version,
});
export type WorkspaceRole = z.output<typeof workspaceRoleSchema>;
export const memberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(roles),
  // The role held, seeded or custom; `role` is its seeded stand-in for older clients.
  roleId: z.string().optional(),
  image: z.string().nullable().optional(),
  source: z.enum(["project", "workspace"]).optional(),
  inheritedRole: z.enum(roles).nullable().optional(),
  inheritedRoleId: z.string().nullable().optional(),
  // Workspace member lists flag disabled accounts, which cannot receive ownership.
  disabled: z.boolean().optional(),
});
// A pending invitation grants its role on the whole workspace, or only on the listed projects.
// The token itself is never readable; create and resend return its link once.
const invitedProject = projectRef;
export const invitationStatuses = ["pending", "expired", "accepted", "revoked"] as const;
export const invitationSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  email: z.string(),
  role: z.enum(roles),
  projects: z.array(invitedProject).nullable(),
  status: z.enum(invitationStatuses),
  invitedBy: z.string().nullable(),
  expiresAt: timestamp,
  sentAt: timestamp,
  version,
});
export type Invitation = z.output<typeof invitationSchema>;
const sentInvitationSchema = z.object({
  invitation: invitationSchema,
  url: z.url(),
  // True when the instance relay was asked to email the link.
  emailed: z.boolean(),
});
const invitationToken = z.string().min(20).max(200);
export const projectSchema = z.object({
  iconName: z.string().nullable().default(null),
  iconColor: z.enum(projectIconColors).default("default"),
  image: z.string().nullable().default(null),
  background: z.string().nullable().default(null),
  workspaceId: z.uuid(),
  visibility: z.enum(["workspace", "private"]),
  // Anyone with the project's public link can read its public projection. Servers that predate
  // public sharing omit it.
  publicReadEnabled: z.boolean().default(false),
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  version,
  // Set while the project is archived. Servers that predate archiving omit it.
  archivedAt: timestamp.nullable().default(null),
  createdAt: timestamp,
  updatedAt: timestamp,
});
// What deleting a project removes, and with `transfer`, what moving it to another workspace
// changes. `blockers` must be empty before either write proceeds.
const impactPerson = z.object({ userId: z.string(), name: z.string(), email: z.string() });
const count = z.number().int().nonnegative();
export const projectImpactSchema = z.object({
  tickets: count,
  comments: count,
  attachments: count,
  attachmentBytes: count,
  events: count,
  blockers: z.array(
    z.object({ code: z.string(), message: z.string(), tickets: z.array(z.string()) }),
  ),
  transfer: z
    .object({
      workspaceId: z.uuid(),
      losingAccess: z.array(impactPerson),
      gainingAccess: z.array(impactPerson),
      copiedLabels: z.array(z.string()),
      mergedLabels: z.array(z.string()),
      subscriptions: count,
      invitations: count,
    })
    .nullable(),
});
export type ProjectImpact = z.output<typeof projectImpactSchema>;
// What deleting a workspace removes: every project, archived ones included, with the totals the
// project deletion preview reports. `blockers` must be empty before the deletion proceeds.
export const workspaceImpactSchema = projectImpactSchema.omit({ transfer: true }).extend({
  projects: z.array(z.object({ ...projectRef.shape, archived: z.boolean(), tickets: count })),
  members: count,
  invitations: count,
  labels: count,
});
export type WorkspaceImpact = z.output<typeof workspaceImpactSchema>;
// Deleted accounts keep their ID on the history they wrote and the server stores this name on
// their tombstone; clients show `common.person.deleted` in the interface language.
export const deletedAccountName = "Deleted account";
// The name every client shows for an account ID on tickets and activity: a current member's name,
// `Deleted account` for an ID from list_deleted_accounts, and otherwise someone who left.
export function memberName(
  people: readonly { userId: string; name: string }[] | undefined,
  deleted: readonly string[] | undefined,
  userId: string,
) {
  return (
    people?.find((person) => person.userId === userId)?.name ??
    (deleted?.includes(userId) ? t("common.person.deleted") : t("common.person.former"))
  );
}
// What deleting an account removes, and the history that stays attributed to its tombstone.
// `blockers` must be empty before the deletion proceeds.
export const accountImpactSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  // Sign-in methods such as `credential` (local password) and `oidc`.
  providers: z.array(z.string()),
  sessions: count,
  // API keys and OAuth (MCP) grants.
  credentials: count,
  // Push devices and notification channels.
  devices: count,
  workspaces: count,
  projects: count,
  // Claims the deletion releases.
  claims: count,
  // Imports the deletion cancels.
  imports: count,
  tickets: count,
  comments: count,
  events: count,
  blockers: projectImpactSchema.shape.blockers,
});
export type AccountImpact = z.output<typeof accountImpactSchema>;
// Not strict like the editable fields: unknown fields, and storage-only columns such as the manual
// order's position, are dropped, so this client keeps reading tickets from newer servers.
export const ticketSchema = z.object({
  ...ticketFields.shape,
  // Servers that predate start dates, workflows, or custom fields omit these fields.
  startAt: dueDate.nullable().default(null),
  stateId: z.uuid().nullable().default(null),
  customFields: z.record(z.string(), customFieldValue).default({}),
  claimRequired: z.boolean(),
  id: z.uuid(),
  projectId: z.uuid(),
  key: z.string(),
  number: z.number().int().positive(),
  version,
  createdBy: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Ticket = z.output<typeof ticketSchema>;
export type Project = z.output<typeof projectSchema>;
export const snapshotSchema = z.object({
  project: projectSchema,
  tickets: z.array(ticketSchema),
  cursor: z.string().regex(/^\d+$/),
});
export const checkpointSchema = z.object({ cursor: z.string().regex(/^\d+$/) });
export const readinessSchema = z.object({
  ready: z.boolean(),
  reasons: z.array(reason),
});
export const claimSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  ticketId: z.uuid(),
  actorId: z.string(),
  workerId: z.string(),
  expiresAt: timestamp,
  createdAt: timestamp,
});
export const relationSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  sourceId: z.uuid(),
  targetId: z.uuid(),
  type: z.enum(["blocks", "related", "duplicate", "causes", "clones", "implements", "reviews"]),
  sourceKey: z.string().optional(),
  sourceTitle: z.string().optional(),
  targetKey: z.string().optional(),
  targetTitle: z.string().optional(),
});
export const relationDirections = z.enum(["outgoing", "incoming"]);
const relationLabel = (type: z.output<typeof relationSchema>["type"], outgoing: boolean) =>
  t(`common.relation.${type}.${outgoing ? "outgoing" : "incoming"}`);
export const relationChoices = relationSchema.shape.type.options.flatMap((type) =>
  (type === "related" ? ["outgoing" as const] : relationDirections.options).map((direction) => ({
    value: `${type}:${direction}`,
    get label() {
      return relationLabel(type, direction === "outgoing");
    },
    type,
    direction,
  })),
);
export function parseRelationChoice(value: unknown) {
  const [type, direction] = z
    .tuple([relationSchema.shape.type, relationDirections])
    .parse(z.string().parse(value).split(":"));
  return { type, direction };
}
export function relationReference(relation: z.output<typeof relationSchema>, ticketId: string) {
  const outgoing = relation.sourceId === ticketId;
  const referenceId = outgoing ? relation.targetId : relation.sourceId;
  const key = (outgoing ? relation.targetKey : relation.sourceKey) ?? referenceId;
  const title = outgoing ? relation.targetTitle : relation.sourceTitle;
  const label = relationLabel(relation.type, outgoing);
  return { id: referenceId, label, title: `${key}${title ? ` · ${title}` : ""}` };
}
export const commentSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  ticketId: z.uuid(),
  actorId: z.string(),
  body: z.string(),
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
});
// A comment mentions a member with a link to `mention:<user id>`; without a renderer that knows the
// scheme, the Markdown still reads as "@Name".
export const mentionScheme = "mention:";
export const mentionLink = (name: string, userId: string) =>
  `[@${name.replaceAll(/[\\[\]]/g, "\\$&")}](${mentionScheme}${userId})`;
export const attachmentSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  ticketId: z.uuid(),
  actorId: z.string(),
  name: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: timestamp,
});
export const stagedUploadSchema = attachmentSchema
  .omit({ ticketId: true })
  .extend({ expiresAt: timestamp });
// The authorized address of an attachment's bytes. A staged upload keeps this address once
// create_ticket claims it, so Markdown that embeds it needs no rewrite.
export const attachmentPath = (projectId: string, attachmentId: string) =>
  `/api/v1/projects/${projectId}/attachments/${attachmentId}/content`;
const httpUrl = z.url().regex(/^https?:\/\//i, "Use an HTTP or HTTPS URL");
export const evidenceFields = z.object({
  kind: z.enum(["pull_request", "test", "review", "deployment", "device", "other"]),
  title: text.max(200),
  url: httpUrl,
  commit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/i)
    .nullable()
    .default(null),
  outcome: z.enum(["reported", "pending", "passed", "failed"]).default("reported"),
  note: z.string().max(20_000).default(""),
});
export const evidenceKindLabels = labelTable(evidenceFields.shape.kind.options, (kind) =>
  t(`common.evidenceKind.${kind}`),
);
export const evidenceOutcomeLabels = labelTable(
  evidenceFields.shape.outcome.unwrap().options,
  (outcome) => t(`common.evidenceOutcome.${outcome}`),
);
export const evidenceSchema = evidenceFields.extend({
  id: z.uuid(),
  projectId: z.uuid(),
  ticketId: z.uuid(),
  actorId: z.string(),
  createdAt: timestamp,
});
// Observed timestamps, never an estimate of agent effort. Running entries have no duration.
export const timeEntryFields = z.object({
  startAt: timestamp,
  endAt: timestamp.nullable().default(null),
  note: z.string().max(20_000).default(""),
});
export const timeEntrySchema = timeEntryFields.extend({
  id: z.uuid(),
  projectId: z.uuid(),
  ticketId: z.uuid(),
  actorId: z.string(),
  durationMs: z.number().int().nonnegative().nullable(),
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
});
// Editable links on a ticket. Unlike evidence, they carry no reported outcome and can change.
const resourceTitle = z.string().trim().max(200);
export const resourceFields = z.object({ url: httpUrl, title: resourceTitle.default("") });
// Hosts whose links are shown as a provider row. Remote state is only ever written by a
// configured connection; without one it stays null and renders as unknown.
const resourceProviders: Record<string, string> = {
  "github.com": "GitHub",
  "gitlab.com": "GitLab",
  "bitbucket.org": "Bitbucket",
};
// Not URL: React Native's URL does not implement hostname, and older browsers lack URL.parse.
// Like a browser, the authority ends at a backslash and the host follows the last @, so the
// badge names the host a click opens. Plain slicing keeps this linear on hostile input.
export function resourceHost(url: string): string | null {
  const scheme = /^https?:\/\//i.exec(url)?.[0];
  if (!scheme) return null;
  const rest = url.slice(scheme.length),
    end = rest.search(/[/\\?#]/),
    authority = end === -1 ? rest : rest.slice(0, end),
    hostPort = authority.slice(authority.lastIndexOf("@") + 1),
    host = hostPort.startsWith("[")
      ? hostPort.slice(0, hostPort.indexOf("]") + 1)
      : hostPort.split(":")[0];
  return host ? host.toLowerCase() : null;
}
export function resourceProvider(url: string): string | null {
  const host = resourceHost(url)?.replace(/^www\./, "");
  return host && Object.hasOwn(resourceProviders, host) ? (resourceProviders[host] ?? null) : null;
}
// What a verified link points at on its code host.
export const remoteKinds = ["branch", "pull_request", "issue"] as const;
export const remoteKindLabels = labelTable(remoteKinds, (kind) => t(`common.remoteKind.${kind}`));
export const resourceSchema = resourceFields.extend({
  id: z.uuid(),
  projectId: z.uuid(),
  ticketId: z.uuid(),
  actorId: z.string(),
  provider: z.string().nullable(),
  // Set with the remote state when a repository connection verified the link.
  remoteKind: z.enum(remoteKinds).nullable(),
  remoteState: z.string().nullable(),
  remoteCheckedAt: timestamp.nullable(),
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
});
// A read-only iCalendar subscription to a project's scheduled open tickets. The secret token is
// returned once at creation; the server keeps only its hash.
export const calendarFeedSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: text.max(80),
  // Only tickets with any of these labels; empty means every label.
  labels: tags,
  // The IANA zone whose calendar days the feed's all-day events use.
  timeZone: z.string(),
  createdBy: z.string(),
  createdAt: timestamp,
  // False once the creator can no longer read the project; the link then stops working.
  active: z.boolean(),
});
export type CalendarFeed = z.output<typeof calendarFeedSchema>;
export const eventSchema = z.object({
  id: z.string().regex(/^\d+$/),
  projectId: z.uuid(),
  ticketId: z.uuid().nullable(),
  // Null for notices the server raises on its own clock, such as due-date reminders.
  actorId: z.string().nullable(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: timestamp,
});
export const searchResultTypes = ["project", "ticket", "comment", "activity"] as const;
export type SearchResultType = (typeof searchResultTypes)[number];
export const searchResultSchema = z.object({
  type: z.enum(searchResultTypes),
  // The stable reference: a project, ticket, or comment ID, or an event ID for activity.
  id: z.string(),
  project: projectRef,
  // The ticket a result belongs to; null for projects and activity without a live ticket.
  ticket: z
    .object({ id: z.uuid(), key: z.string(), title: z.string(), status: z.enum(states) })
    .nullable(),
  title: z.string(),
  // Matching text around the first occurrence of the query, when the result has body text.
  excerpt: z.string(),
  actorId: z.string().nullable(),
  at: timestamp,
});
export type SearchResult = z.output<typeof searchResultSchema>;
const signInProviderSchema = z.object({ id: z.string(), name: z.string() });
// Names for an account's sign-in methods; the deployment names its own OIDC provider.
// Product names stay as they are; the local password reads in the interface language.
export const signInMethodLabels: Record<string, string> = {
  get credential() {
    return t("common.signIn.localPassword");
  },
  oidc: "OIDC",
  github: "GitHub",
  google: "Google",
  discord: "Discord",
};
// Returns a Better Auth client result or throws its error. Wrong, used, and expired email codes
// fail apart; people see one message for them.
export function authResult<
  T extends { error: { code?: string | undefined; message?: string | undefined } | null },
>(result: T) {
  if (!result.error) return result;
  throw new Error(
    ["INVALID_OTP", "OTP_EXPIRED", "TOO_MANY_ATTEMPTS"].includes(result.error.code ?? "")
      ? t("common.signIn.invalidCode")
      : (result.error.message ?? t("common.error.fallback")),
  );
}
export const infoSchema = z
  .object({
    authentication: authenticationPolicySchema.default(() => authenticationPolicySchema.parse({})),
    name: z.string(),
    description: z.string().default(""),
    version: z.string(),
    setupRequired: z.boolean(),
    oidc: signInProviderSchema.nullable(),
    // Every configured sign-in provider in display order: the OIDC provider, then GitHub, Google,
    // and Discord. Servers before it report only `oidc`.
    providers: z.array(signInProviderSchema).optional(),
    push: z.boolean().default(false),
    // Whether the instance has SMTP configured for email notification channels.
    email: z.boolean().default(false),
    // Whether emailed codes sign people in and reset passwords.
    emailCodes: z.boolean().default(false),
  })
  .transform((info) => ({
    ...info,
    providers: info.providers ?? (info.oidc ? [info.oidc] : []),
  }));
// Every category starts enabled, so accounts saved before categories keep receiving every update.
export const notificationCategoriesSchema = z.object({
  assignment: z.boolean().default(true),
  status: z.boolean().default(true),
  comment: z.boolean().default(true),
  mention: z.boolean().default(true),
  update: z.boolean().default(true),
  due_soon: z.boolean().default(true),
  overdue: z.boolean().default(true),
});
export const notificationCategories = notificationCategoriesSchema.keyof().options;
export type NotificationCategory = (typeof notificationCategories)[number];
export const notificationCategoryLabels = labelTable(notificationCategories, (category) =>
  t(`common.notificationCategory.${category}`),
);
// The categories an event belongs to, most specific first. A follower receives the event when any
// of them is enabled and sees the first enabled one.
export function eventCategories(event: {
  type: string;
  data: Record<string, unknown>;
}): NotificationCategory[] {
  if (event.type === "ticket.due_soon") return ["due_soon"];
  if (event.type === "ticket.overdue") return ["overdue"];
  if (event.type.startsWith("comment.")) return ["comment"];
  if (event.type !== "ticket.updated" || !Array.isArray(event.data.changedFields))
    return ["update"];
  const fields = new Set<unknown>(event.data.changedFields);
  const found: NotificationCategory[] = [];
  // A manual reorder alone notifies nobody.
  const reordered = fields.delete("position");
  if (fields.delete("assigneeId")) found.push("assignment");
  if (fields.delete("status")) found.push("status");
  if (fields.size || (!found.length && !reordered)) found.push("update");
  return found;
}
export const reminderUnits = ["minutes", "hours", "days", "weeks"] as const;
export const reminderUnitSchema = z.enum(reminderUnits);
const reminderLead = z.object({
  amount: z.number().int().min(1).max(999),
  unit: reminderUnitSchema,
});
export const notificationsSchema = z.array(
  z.object({
    id: z.uuid(),
    readAt: timestamp.nullable(),
    // Older servers omit the category; unknown future categories read as a generic update.
    category: z.enum(notificationCategories).catch("update"),
    createdAt: timestamp.optional(),
    event: eventSchema,
  }),
);
// Inbox entries a signed-in account acts on. Omitting `read` marks them read, as older clients do.
export const notificationIdsInput = z.object({ ids: z.array(z.uuid()).min(1).max(100) }).strict();
export const notificationReadInput = notificationIdsInput
  .extend({ read: z.boolean().default(true) })
  .strict();
export const notificationPreferencesSchema = z.object({
  inApp: z.boolean().default(true),
  push: z.boolean().default(false),
  categories: notificationCategoriesSchema.prefault({}),
  reminderLead: reminderLead.prefault({ amount: 1, unit: "days" }),
});
// Omitted fields keep their saved value; `categories` merges with the saved flags.
export const notificationPreferencesInput = z
  .object({
    inApp: z.boolean(),
    push: z.boolean().optional(),
    categories: z.partialRecord(z.enum(notificationCategories), z.boolean()).optional(),
    reminderLead: reminderLead.strict().optional(),
  })
  .strict();
export type NotificationPreferences = z.output<typeof notificationPreferencesSchema>;
export type NotificationPreferencesInput = z.input<typeof notificationPreferencesInput>;
export const pushDeviceInput = z.object({ token: z.string().min(1).max(250) }).strict();
// Outbound delivery. Account channels carry one person's notifications; project destinations carry
// a project's ticket activity. Both start off and share one outbox, transport, and health record.
export const channelKinds = ["email", "ntfy", "gotify", "webhook"] as const;
export const destinationKinds = ["webhook", "slack", "discord", "mattermost", "telegram"] as const;
export const deliveryKinds = [...new Set([...channelKinds, ...destinationKinds])];
export type DeliveryKind = (typeof channelKinds)[number] | (typeof destinationKinds)[number];
// Product names stay as they are; the generic kinds read in the interface language.
export const deliveryKindLabels: Record<DeliveryKind, string> = {
  get email() {
    return t("common.deliveryKind.email");
  },
  ntfy: "ntfy",
  gotify: "Gotify",
  get webhook() {
    return t("common.deliveryKind.webhook");
  },
  slack: "Slack",
  discord: "Discord",
  mattermost: "Mattermost",
  telegram: "Telegram",
};
// Saved values that are never returned. On edit an omitted secret keeps its saved value and an
// empty string clears an optional one.
export const deliverySecretFields: Record<DeliveryKind, readonly string[]> = {
  email: [],
  ntfy: ["token"],
  gotify: ["token"],
  webhook: ["secret"],
  slack: ["url"],
  discord: ["url"],
  mattermost: ["url"],
  telegram: ["token"],
};
const endpoint = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .refine(
    (value) => !/^[a-z]+:\/\/[^/?#]*@/i.test(value),
    "Put credentials in their own field, not in the URL",
  );
const deliverySecret = z.string().trim().min(1).max(500);
export const deliverySettingsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email"), address: z.email().max(254) }),
  z.object({
    kind: z.literal("ntfy"),
    server: endpoint.default("https://ntfy.sh"),
    topic: z.string().regex(/^[\w-]{1,64}$/, "Use letters, digits, - or _"),
    token: deliverySecret.optional(),
  }),
  z.object({ kind: z.literal("gotify"), server: endpoint, token: deliverySecret }),
  z.object({ kind: z.literal("webhook"), url: endpoint, secret: deliverySecret.optional() }),
  z.object({ kind: z.literal("slack"), url: endpoint }),
  z.object({ kind: z.literal("discord"), url: endpoint }),
  z.object({
    kind: z.literal("mattermost"),
    url: endpoint,
    channel: z.string().trim().max(64).optional(),
  }),
  z.object({
    kind: z.literal("telegram"),
    token: z.string().regex(/^\d+:[\w-]{20,}$/, "Use the bot token from BotFather"),
    chatId: z.string().regex(/^(-?\d{1,20}|@\w{5,32})$/, "Use a numeric chat ID or @channel"),
    topicId: z.coerce.number().int().positive().optional(),
  }),
]);
export type DeliverySettings = z.output<typeof deliverySettingsSchema>;
// Field values by kind; the server merges them with saved secrets and validates the result.
export const deliverySettingsInput = z
  .object({ kind: z.enum(deliveryKinds) })
  .catchall(z.union([z.string().max(2000), z.number(), z.null()]));
export const channelRouteModes = ["off", "all", "selected"] as const;
// A workspace sends everything, chosen projects, or nothing. `off` keeps the chosen projects.
export const channelRouteSchema = z.object({
  workspaceId: z.uuid(),
  mode: z.enum(channelRouteModes),
  projectIds: z.array(z.uuid()).max(500).default([]),
});
export type ChannelRoute = z.output<typeof channelRouteSchema>;
export function channelRouteAllows(
  routes: readonly { workspaceId: string; mode: string; projectIds: readonly string[] }[],
  workspaceId: string | undefined,
  projectId: string,
) {
  const route = routes.find((item) => item.workspaceId === workspaceId);
  return (
    route?.mode === "all" || (route?.mode === "selected" && route.projectIds.includes(projectId))
  );
}
const channelRoutes = z
  .array(channelRouteSchema)
  .max(100)
  .refine(
    (routes) => new Set(routes.map((route) => route.workspaceId)).size === routes.length,
    "List each workspace once",
  );
// Project activity a destination can carry: ticket creation plus the event categories. Mentions are
// personal, so a project feed carries the comment instead.
const projectCategory = (
  category: NotificationCategory,
): category is Exclude<NotificationCategory, "mention"> => category !== "mention";
export const destinationEvents = [
  "created",
  ...notificationCategories.filter(projectCategory),
] as const;
export type DestinationEvent = (typeof destinationEvents)[number];
export const destinationEventLabels = labelTable(destinationEvents, (event) =>
  event === "created" ? t("common.destinationEvent.created") : notificationCategoryLabels[event],
);
export function destinationEventKeys(event: {
  type: string;
  data: Record<string, unknown>;
}): DestinationEvent[] {
  return event.type === "ticket.created"
    ? ["created"]
    : eventCategories(event).filter(projectCategory);
}
export const deliveryHealthSchema = z.object({
  // `idle` until the first attempt; `failing` while the latest attempt failed.
  status: z.enum(["idle", "ok", "failing"]),
  error: z.string().nullable(),
  lastAttemptAt: timestamp.nullable(),
  lastSuccessAt: timestamp.nullable(),
  pending: z.number().int().nonnegative(),
});
const deliveryTarget = {
  id: z.uuid(),
  name: z.string(),
  paused: z.boolean(),
  // Saved settings without secrets; `secrets` names the secret fields that hold a value.
  settings: z.record(z.string(), z.union([z.string(), z.number()])),
  secrets: z.array(z.string()),
  endpoint: z.string(),
  health: deliveryHealthSchema,
  version,
  createdAt: timestamp,
};
export const notificationChannelSchema = z.object({
  ...deliveryTarget,
  kind: z.enum(channelKinds),
  routes: z.array(channelRouteSchema),
});
export type NotificationChannel = z.output<typeof notificationChannelSchema>;
export const projectDestinationSchema = z.object({
  ...deliveryTarget,
  kind: z.enum(destinationKinds),
  projectId: z.uuid(),
  events: z.array(z.enum(destinationEvents)),
});
export type ProjectDestination = z.output<typeof projectDestinationSchema>;
// Repository connections. Signed webhooks from a connected repository attach verified issue,
// branch, and pull-request links to the tickets they name, and can move those tickets to a chosen
// workflow state. Access checks and link comments go through the delivery outbox.
export const repositoryProviders = ["github", "gitea", "gitlab"] as const;
export type RepositoryProvider = (typeof repositoryProviders)[number];
// Where code hosts differ. `baseUrl` is null when the server configures the API (GitHub and GitHub
// Enterprise Server); otherwise each connection names its instance, falling back to `default`.
// `nested` paths name groups and subgroups. `change` is the host's word for a pull request.
export const repositoryProviderDefinitions: Record<
  RepositoryProvider,
  {
    label: string;
    baseUrl: { default: string | null } | null;
    nested: boolean;
    // The catalog entry for the host's change requests; `change` is its name.
    changeKind: "pull_request" | "merge_request";
    readonly change: string;
  }
> = {
  github: {
    label: "GitHub",
    baseUrl: null,
    nested: false,
    changeKind: "pull_request",
    get change() {
      return t("common.change.pull_request.name");
    },
  },
  gitea: {
    label: "Gitea",
    baseUrl: { default: null },
    nested: false,
    changeKind: "pull_request",
    get change() {
      return t("common.change.pull_request.name");
    },
  },
  gitlab: {
    label: "GitLab",
    baseUrl: { default: "https://gitlab.com" },
    nested: true,
    changeKind: "merge_request",
    get change() {
      return t("common.change.merge_request.name");
    },
  },
};
export const repositoryTriggers = [
  "branch_created",
  "pull_request_opened",
  "pull_request_draft",
  "pull_request_merged",
  "pull_request_closed",
] as const;
export type RepositoryTrigger = (typeof repositoryTriggers)[number];
const triggerStates = {
  pull_request_opened: "opened",
  pull_request_draft: "draft",
  pull_request_merged: "merged",
  pull_request_closed: "closed",
} as const;
export function repositoryTriggerLabel(trigger: RepositoryTrigger, provider: RepositoryProvider) {
  if (trigger === "branch_created") return t("common.change.branchCreated");
  const kind = repositoryProviderDefinitions[provider].changeKind;
  return t(`common.change.${kind}.${triggerStates[trigger]}`);
}
// A verified link's kind in its host's words; `provider` is the link's provider label.
export function remoteKindLabel(kind: (typeof remoteKinds)[number], provider: string | null) {
  const host = Object.values(repositoryProviderDefinitions).find((item) => item.label === provider);
  return kind === "pull_request" && host ? host.change : remoteKindLabels[kind];
}
export const repositorySecretFields = ["token", "webhookSecret"] as const;
// Slash-separated path segments; each provider's handler checks how many it takes.
const repositoryName = z
  .string()
  .trim()
  .max(200)
  .regex(/^[\w.-]+(?:\/[\w.-]+)+$/, "Use owner/repository")
  .refine(
    (value) => value.split("/").every((segment) => segment !== "." && segment !== ".."),
    "Use owner/repository",
  );
// A self-managed instance's web address, without credentials, query, or a trailing slash. The host
// is lowercased and a default port dropped, so one instance has one spelling.
const repositoryBaseUrl = endpoint
  .refine((value) => !/[?#]/.test(value), "Use the server address without a query or fragment")
  .pipe(z.url({ normalize: true }))
  .transform((value) => value.replace(/\/+$/, ""));
const repositorySecret = z.string().trim().min(1).max(500);
// A trigger left out moves nothing.
const repositoryTransitions = z.partialRecord(z.enum(repositoryTriggers), z.uuid());
// Issue sync between tickets and a connected repository's issues. A rule names workspace labels by
// ID and matches tickets or issues carrying any or all of them; no labels matches every one.
export const syncRuleSchema = z
  .object({
    enabled: z.boolean(),
    labels: z.array(z.uuid()).max(50),
    match: z.enum(["any", "all"]),
  })
  .strict();
export type SyncRule = z.output<typeof syncRuleSchema>;
// `creating` waits for the host to confirm a new issue; `unknown` means that confirmation never
// arrived, so the issue may or may not exist. `paused` and `review` sync nothing until reconciled.
export const issueLinkStates = ["active", "paused", "review", "creating", "unknown"] as const;
export type IssueLinkState = (typeof issueLinkStates)[number];
export const issueLinkStateLabels = labelTable(issueLinkStates, (state) =>
  t(`common.issueLinkState.${state}`),
);
export const issueLinkSchema = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  ticketId: z.uuid(),
  ticketKey: z.string(),
  ticketTitle: z.string(),
  // Whether the ticket exported to the issue or the issue imported as the ticket; that side's rule
  // keeps the link syncing.
  origin: z.enum(["inbound", "outbound"]),
  state: z.enum(issueLinkStates),
  // Why the link stopped: `labels`, `conflict`, `changed_while_paused`, or a host or ticket error code.
  reason: z.string().nullable(),
  number: z.number().int().nullable(),
  url: z.string().nullable(),
  version,
  updatedAt: timestamp,
});
export type IssueLink = z.output<typeof issueLinkSchema>;
export const issueContentSchema = z.object({
  title: z.string(),
  description: z.string(),
  open: z.boolean(),
});
export type IssueContent = z.output<typeof issueContentSchema>;
// Both sides of a link now; `remote` is null until the host has reported the issue.
export const issueComparisonSchema = z.object({
  link: issueLinkSchema,
  ticketVersion: version,
  local: issueContentSchema,
  remote: issueContentSchema.nullable(),
  base: issueContentSchema.nullable(),
});
// What applying rules would do: links that keep syncing, tickets that export as new issues, links
// that pause, and paused links that qualify again and wait for review. Apply passes `fingerprint`
// back and is refused once any of these sets changed.
export const syncPreviewSchema = z.object({
  matching: z.number().int().nonnegative(),
  export: z.number().int().nonnegative(),
  pause: z.number().int().nonnegative(),
  review: z.number().int().nonnegative(),
  fingerprint: z.string(),
});
export type SyncPreview = z.output<typeof syncPreviewSchema>;
export const repositoryConnectionSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  provider: z.enum(repositoryProviders),
  repository: z.string(),
  // The self-managed instance; null for GitHub, whose API the server configures.
  baseUrl: z.string().nullable(),
  // Where the code host sends signed events for this connection.
  webhookUrl: z.string(),
  secrets: z.array(z.enum(repositorySecretFields)),
  paused: z.boolean(),
  commentOnLink: z.boolean(),
  transitions: repositoryTransitions,
  outbound: syncRuleSchema,
  inbound: syncRuleSchema,
  // Issue links by state; states without links are left out.
  issueLinks: z.partialRecord(z.enum(issueLinkStates), z.number().int()),
  // The latest access check, link comment, or issue sync.
  health: deliveryHealthSchema,
  lastEventAt: timestamp.nullable(),
  lastEventError: z.string().nullable(),
  version,
  createdAt: timestamp,
});
export type RepositoryConnection = z.output<typeof repositoryConnectionSchema>;
export const credentialsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string().nullable(),
    start: z.string().nullable(),
    enabled: z.boolean(),
    expiresAt: timestamp.nullable(),
    createdAt: timestamp,
    permissions: z.string().nullable(),
    metadata: z.string().nullable(),
  }),
);
// null explicitly follows the account; an array always remains a project allowlist.
export const credentialProjectsSchema = z.object({
  projectIds: z.array(z.uuid()).max(1000).nullable(),
});
export const credentialInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    projectIds: credentialProjectsSchema.shape.projectIds.refine(
      (ids) => ids === null || ids.length > 0,
    ),
    scopes: z.array(z.enum(scopes)).min(1),
    // Omitted means the 90-day default; null is an explicit request for a key that never expires.
    expiresIn: z.number().int().min(3600).max(31_536_000).nullable().default(7_776_000),
  })
  .strict();
export const createdCredentialSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string().nullable(),
  expiresAt: timestamp.nullable(),
});
export const okSchema = z.object({ ok: z.literal(true) });
export type ChangeEvent = z.output<typeof eventSchema>;
// Event types with a name of their own; any other reads as its type.
export const namedEvents = [
  "label.created",
  "label.updated",
  "label.deleted",
  "workflow.created",
  "workflow.updated",
  "workflow.deleted",
  "custom_field.created",
  "custom_field.updated",
  "custom_field.deleted",
  "ticket.created",
  "ticket.updated",
  "ticket.deleted",
  "ticket.moved",
  "ticket.moved_away",
  "ticket.due_soon",
  "ticket.overdue",
  "ticket.claimed",
  "claim.renewed",
  "claim.released",
  "claim.recovered",
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "relation.added",
  "relation.removed",
  "attachment.created",
  "attachment.deleted",
  "evidence.added",
  "time_entry.created",
  "time_entry.updated",
  "time_entry.deleted",
  "resource.added",
  "resource.updated",
  "resource.removed",
  "calendar_feed.created",
  "calendar_feed.revoked",
  "project.created",
  "project.updated",
  "project.archived",
  "project.restored",
  "project.transferred",
  "project.deleted",
  "membership.updated",
  "workspace.owner_changed",
  "role.created",
  "role.updated",
  "role.deleted",
  "invitation.updated",
  "destination.created",
  "destination.updated",
  "destination.deleted",
  "repository.connected",
  "repository.updated",
  "repository.disconnected",
  "repository.received",
  "issue_link.updated",
] as const;
export const eventLabels: Record<string, string> = labelTable(namedEvents, (type) =>
  t(`common.event.${type}`),
);
export function formatEvent(event: ChangeEvent, includeTicket = false): string {
  const fallback = event.type.replaceAll(".", " ").replaceAll("_", " "),
    label = eventLabels[event.type] ?? fallback.charAt(0).toUpperCase() + fallback.slice(1);
  if (!includeTicket || !event.ticketId) return label;
  const key = typeof event.data.key === "string" ? event.data.key : event.ticketId;
  return `${label} · ${key}${typeof event.data.title === "string" ? ` · ${event.data.title}` : ""}`;
}
// The versioned ticket export, and the one shape every import reads; sources from other trackers
// translate into it. Records name each other by `ref`, the source's stable ID, never by key, so
// links survive new keys. `completeness.omitted` lists what the export left out.
export const ticketExportFormat = "kanvil.tickets";
export const importLimits = {
  members: 1000,
  labels: 1000,
  tickets: 5000,
  relations: 20_000,
  comments: 20_000,
  evidence: 10_000,
  resources: 10_000,
} as const;
const sourceRef = z.string().min(1).max(200);
// Exports carry projects of any size; `capped` applies `importLimits` to what an import accepts.
const bundleSchema = (capped: boolean) => {
  const exported = <T extends z.ZodType>(item: T, max: number) => {
    const items = z.array(item);
    return (capped ? items.max(max) : items).default([]);
  };
  return z.object({
    format: z.literal(ticketExportFormat),
    version: z.literal(1),
    exportedAt: timestamp,
    project: z.object({
      ref: sourceRef,
      key: z.string().max(20),
      name: text.max(120),
      description: z.string().max(5000).default(""),
    }),
    completeness: z
      .object({
        omitted: z
          .array(
            z.object({
              content: z.string().max(80),
              // Null when the source did not count it.
              count: count.nullable(),
              reason: z.string().max(500),
            }),
          )
          .max(50),
      })
      .default({ omitted: [] }),
    // The people records name: assignees, ticket creators, and authors. Imports match them by email.
    members: exported(
      z.object({ ref: sourceRef, name: z.string().max(200), email: z.string().max(320) }),
      importLimits.members,
    ),
    workflow: z
      .array(
        z.object({
          ref: sourceRef,
          name: text.max(40),
          category: z.enum(states),
          color: labelColor.default("default"),
        }),
      )
      .min(1)
      .max(50),
    customFields: exported(
      customFieldSchema
        .pick({ name: true, type: true, options: true, required: true, defaultValue: true })
        .extend({ ref: sourceRef }),
      customFieldLimit,
    ),
    labels: exported(
      z.object({ name: text.max(40), color: labelColor.default("gray") }),
      importLimits.labels,
    ),
    tickets: exported(
      z.object({
        ...ticketFields.pick({
          title: true,
          description: true,
          acceptanceCriteria: true,
          priority: true,
          kind: true,
          difficulty: true,
          labels: true,
          scopes: true,
          automationReady: true,
          holdReason: true,
          startAt: true,
          dueAt: true,
          archived: true,
        }).shape,
        ref: sourceRef,
        // The key in the source; an import issues new keys.
        key: z.string().max(40),
        stateRef: sourceRef,
        assigneeRef: sourceRef.nullable().default(null),
        parentRef: sourceRef.nullable().default(null),
        // Values by field `ref`.
        customFields: z.record(sourceRef, customFieldValue).default({}),
        createdByRef: sourceRef.nullable().default(null),
        createdAt: timestamp.nullable().default(null),
      }),
      importLimits.tickets,
    ),
    relations: exported(
      z.object({ sourceRef, targetRef: sourceRef, type: relationSchema.shape.type }),
      importLimits.relations,
    ),
    comments: exported(
      z.object({
        ref: sourceRef,
        ticketRef: sourceRef,
        authorRef: sourceRef.nullable(),
        body: text.max(50_000),
        createdAt: timestamp,
      }),
      importLimits.comments,
    ),
    evidence: exported(
      evidenceFields.extend({
        ref: sourceRef,
        ticketRef: sourceRef,
        authorRef: sourceRef.nullable(),
        createdAt: timestamp,
      }),
      importLimits.evidence,
    ),
    resources: exported(
      resourceFields.extend({ ref: sourceRef, ticketRef: sourceRef, createdAt: timestamp }),
      importLimits.resources,
    ),
  });
};
export const ticketExportSchema = bundleSchema(false);
export const ticketImportSchema = bundleSchema(true);
export type TicketExport = z.output<typeof ticketExportSchema>;
// A staged import into a new project: previewed, then started, then written in the background.
export const importStatuses = ["previewed", "running", "completed", "failed", "cancelled"] as const;
export const importStatusLabels = labelTable(importStatuses, (status) =>
  t(`common.importStatus.${status}`),
);
export const importRunSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  // Set once the run has created its project.
  projectId: z.uuid().nullable(),
  key: z.string(),
  name: z.string(),
  visibility: z.enum(["workspace", "private"]),
  status: z.enum(importStatuses),
  // Records the bundle holds by content: tickets, comments, and so on.
  counts: z.record(z.string(), count),
  // The account each person's assignments go to; null leaves their tickets unassigned.
  members: z.array(
    z.object({
      ref: z.string(),
      name: z.string(),
      email: z.string(),
      userId: z.string().nullable(),
    }),
  ),
  // Errors block the start; warnings say what the import changes or leaves out.
  issues: z.array(
    z.object({ severity: z.enum(["error", "warning"]), code: z.string(), message: z.string() }),
  ),
  progress: z.object({ total: count, done: count, failed: count }),
  // Records that could not be written, in import order; the first 100.
  errors: z.array(
    z.object({ kind: z.string(), label: z.string(), code: z.string(), message: z.string() }),
  ),
  version,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type ImportRun = z.output<typeof importRunSchema>;
const importInput = z.object({ workspaceId: z.uuid(), importId: z.uuid() });
// Trackers an import reads directly. The server reads the source with the credentials of one
// request, only ever reading, and stages what it read like a `kanvil.tickets` bundle. Credentials
// are never stored or returned.
export const importProviders = ["linear", "jira", "trello", "plane", "planka", "kaneo"] as const;
export type ImportProvider = (typeof importProviders)[number];
// The product names stay as they are; what a provider calls a project and how to set it up read in
// the interface language.
const importProvider = (provider: ImportProvider, label: string) => ({
  label,
  get project() {
    return t(`common.importProvider.${provider}.project`);
  },
  get setup() {
    return t(`common.importProvider.${provider}.setup`);
  },
});
export const importProviderDefinitions: Record<
  ImportProvider,
  { label: string; readonly project: string; readonly setup: string }
> = {
  linear: importProvider("linear", "Linear"),
  jira: importProvider("jira", "Jira"),
  trello: importProvider("trello", "Trello"),
  plane: importProvider("plane", "Plane"),
  planka: importProvider("planka", "PLANKA"),
  kaneo: importProvider("kaneo", "Kaneo"),
};
export const jiraEditions = ["cloud", "data_center"] as const;
export const jiraEditionLabels = labelTable(jiraEditions, (edition) =>
  t(`common.jiraEdition.${edition}`),
);
export const plankaSignIns = ["password", "api_key"] as const;
export const plankaSignInLabels = labelTable(plankaSignIns, (signIn) =>
  t(`common.plankaSignIn.${signIn}`),
);
const sourceToken = z.string().trim().min(1).max(2000);
// Fields that hold a credential; receipts and logs never see them.
export const importSecretFields = ["token", "apiKey", "password"] as const;
export const importSourceSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("linear"), token: sourceToken }).strict(),
  z
    .object({
      provider: z.literal("jira"),
      edition: z.enum(jiraEditions),
      baseUrl: repositoryBaseUrl,
      // Cloud only: the account the API token belongs to.
      email: z.string().trim().max(320).default(""),
      token: sourceToken,
    })
    .strict()
    .refine((source) => source.edition !== "cloud" || source.email !== "", {
      message: "Jira Cloud needs the account email",
      path: ["email"],
    }),
  z.object({ provider: z.literal("trello"), apiKey: sourceToken, token: sourceToken }).strict(),
  z
    .object({
      provider: z.literal("plane"),
      baseUrl: repositoryBaseUrl,
      workspace: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .regex(/^[\w-]+$/, "Use the workspace slug from its web address"),
      token: sourceToken,
    })
    .strict(),
  z
    .object({
      provider: z.literal("planka"),
      baseUrl: repositoryBaseUrl,
      signIn: z.enum(plankaSignIns),
      // Password sign-in: the account's username or email and its password.
      username: z.string().trim().max(256).default(""),
      password: z.string().max(2000).default(""),
      // API key sign-in.
      token: z.string().trim().max(2000).default(""),
    })
    .strict()
    .refine(
      (source) =>
        source.signIn === "api_key"
          ? source.token !== ""
          : source.username !== "" && source.password !== "",
      { message: "PLANKA needs a username and password, or an API key" },
    ),
  z
    .object({ provider: z.literal("kaneo"), baseUrl: repositoryBaseUrl, token: sourceToken })
    .strict(),
]);
export type ImportSource = z.output<typeof importSourceSchema>;
// A Linear team, a Jira or Plane project, a Trello or PLANKA board, or a Kaneo project the
// credentials can read. `group` names what holds it when the source nests them, such as a PLANKA
// project or a Kaneo workspace.
export const importSourceProjectSchema = z.object({
  ref: z.string(),
  key: z.string(),
  name: z.string(),
  group: z.string().default(""),
});
export type ImportSourceProject = z.output<typeof importSourceProjectSchema>;
export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int().nonnegative() });
// One uploaded file: attachments and staged inline uploads accept the same bytes.
const fileFields = {
  name: text.max(255).refine((value) => {
    for (const character of value)
      if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) return false;
    return true;
  }, "Use a filename without control characters"),
  contentType: z
    .string()
    .max(120)
    .regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i)
    .default("application/octet-stream"),
  data: z.string().max(Math.ceil(attachmentLimit / 3) * 4),
};
const op = <I extends z.ZodObject, O extends z.ZodType>(
  input: I,
  output: O,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  scope: (typeof scopes)[number],
  description: string,
) => ({ input, output, method, path, scope, description });

export const operations = {
  list_workspaces: op(
    z.object({}),
    z.array(workspaceSchema),
    "GET",
    "/workspaces",
    "read",
    "List accessible workspaces and the current membership role.",
  ),
  create_workspace: op(
    z
      .object({
        ...mutation,
        name: text.max(120),
        slug: z
          .string()
          .trim()
          .regex(/^[a-z0-9][a-z0-9-]{1,79}$/),
        description: z.string().max(5000).default(""),
      })
      .strict(),
    workspaceSchema,
    "POST",
    "/workspaces",
    "write",
    "Create a workspace and become its administrator.",
  ),
  update_workspace: op(
    z
      .object({
        ...mutation,
        workspaceId: z.uuid(),
        expectedVersion: version,
        name: text.max(120),
        description: z.string().max(5000),
      })
      .strict(),
    workspaceSchema,
    "PATCH",
    "/workspaces/{workspaceId}",
    "admin",
    "Update workspace details with version checks.",
  ),
  list_workspace_members: op(
    z.object({ workspaceId: z.uuid() }),
    z.array(memberSchema),
    "GET",
    "/workspaces/{workspaceId}/members",
    "read",
    "List members of a workspace you belong to.",
  ),
  set_workspace_member: op(
    z
      .object({
        ...mutation,
        workspaceId: z.uuid(),
        email: z.email(),
        // A seeded role name or a custom role ID of this workspace.
        role: roleId.nullable(),
      })
      .strict(),
    okSchema,
    "POST",
    "/workspaces/{workspaceId}/members",
    "admin",
    "Manage workspace access with a seeded or custom role; removal also revokes direct project access in this workspace. Needs `member.manage`; the role, and any role the person holds now, must grant nothing the caller lacks.",
  ),
  list_workspace_roles: op(
    z.object({ workspaceId: z.uuid() }),
    z.array(workspaceRoleSchema),
    "GET",
    "/workspaces/{workspaceId}/roles",
    "read",
    "List the seeded roles and the workspace's custom roles with the actions each grants and how many memberships hold it.",
  ),
  create_workspace_role: op(
    z
      .object({
        ...mutation,
        workspaceId: z.uuid(),
        name: text.max(40),
        permissions: z.array(z.enum(permissions)).max(permissions.length),
      })
      .strict(),
    workspaceRoleSchema,
    "POST",
    "/workspaces/{workspaceId}/roles",
    "admin",
    "Define a custom role. Needs `workspace.manage` and every action it grants. Names are unique in the workspace and the seeded role names are reserved (`duplicate_role`).",
  ),
  update_workspace_role: op(
    z
      .object({
        ...mutation,
        workspaceId: z.uuid(),
        roleId: z.uuid(),
        expectedVersion: version,
        name: text.max(40),
        permissions: z.array(z.enum(permissions)).max(permissions.length),
      })
      .strict(),
    workspaceRoleSchema,
    "PATCH",
    "/workspaces/{workspaceId}/roles/{roleId}",
    "admin",
    "Rename a custom role or change its actions; every membership holding it changes at once. Needs `workspace.manage` and every action the role grants before and after.",
  ),
  delete_workspace_role: op(
    z
      .object({
        ...mutation,
        workspaceId: z.uuid(),
        roleId: z.uuid(),
        expectedVersion: version,
        // Where memberships holding the role go; required while any does.
        reassignTo: roleId.optional(),
      })
      .strict(),
    okSchema,
    "DELETE",
    "/workspaces/{workspaceId}/roles/{roleId}",
    "admin",
    "Delete a custom role. Fails with `role_in_use` while memberships hold it unless `reassignTo` names another role of the workspace for them.",
  ),
  transfer_workspace: op(
    z
      .object({
        ...mutation,
        workspaceId: z.uuid(),
        expectedVersion: version,
        userId: z.string().min(1),
      })
      .strict(),
    workspaceSchema,
    "POST",
    "/workspaces/{workspaceId}/owner",
    "admin",
    "Make another active administrator of the workspace its owner. Only the owner or an instance administrator can transfer, and the previous owner stays an administrator. Fails with `owner_ineligible` when the person is not an active workspace administrator.",
  ),
  get_workspace_impact: op(
    z.object({ workspaceId: z.uuid() }),
    workspaceImpactSchema,
    "GET",
    "/workspaces/{workspaceId}/impact",
    "admin",
    "Preview what deleting the workspace removes: each project with its tickets, comments, files, and activity, its members, pending invitations, and shared labels, and blockers such as claimed tickets.",
  ),
  delete_workspace: op(
    z
      .object({
        ...mutation,
        workspaceId: z.uuid(),
        expectedVersion: version,
        confirmSlug: z.string().max(80),
      })
      .strict(),
    okSchema,
    "DELETE",
    "/workspaces/{workspaceId}",
    "admin",
    "Permanently delete a workspace and every project in it as `delete_project` does, with its memberships, invitations, and shared labels. Only the owner or an instance administrator, signed in within the last 15 minutes, can delete; `confirmSlug` must repeat the workspace URL key. Fails with `claim_conflict` while any ticket is claimed. Accounts, the URL key, and the activity history are kept.",
  ),
  list_deleted_accounts: op(
    z.object({}),
    z.array(z.string()),
    "GET",
    "/accounts/deleted",
    "read",
    "List the IDs of deleted accounts. Tickets, comments, evidence, and activity they wrote keep the ID; show it as `Deleted account`.",
  ),
  get_account_impact: op(
    z.object({ userId: z.string().min(1) }),
    accountImpactSchema,
    "GET",
    "/accounts/{userId}/impact",
    "read",
    "Preview deleting an account: its sign-in methods, sessions, credentials, devices, memberships, claims, and open imports, the history that stays, and blockers such as an owned workspace or the last instance administrator. Only the account itself or an instance administrator can read it.",
  ),
  delete_account: op(
    z
      .object({
        ...mutation,
        userId: z.string().min(1),
        confirmEmail: z.string().trim().max(320),
      })
      .strict(),
    okSchema,
    "DELETE",
    "/accounts/{userId}",
    "write",
    "Delete an account: remove its sign-in methods, sessions, API keys, OAuth grants, devices, notification settings, memberships, and photo, release its claims, cancel its imports, and replace its name and email with a `Deleted account` tombstone. Tickets, comments, evidence, and activity keep the account ID. Only the account itself or an instance administrator, signed in within the last 15 minutes, can delete; `confirmEmail` must repeat the account's email. Fails with `workspace_owner` while it owns a workspace and `last_administrator` for the last active instance or workspace administrator.",
  ),
  list_workspace_labels: op(
    z.object({ workspaceId: z.uuid() }),
    z.array(workspaceCatalogLabel),
    "GET",
    "/workspaces/{workspaceId}/labels",
    "read",
    "List the workspace's shared labels with ticket counts from the projects you can read, including archived tickets.",
  ),
  create_workspace_label: op(
    z
      .object({
        ...mutation,
        workspaceId: z.uuid(),
        name: text.max(40),
        color: labelColor.default("gray"),
        adopt: z.boolean().default(false),
      })
      .strict(),
    workspaceLabelSchema,
    "POST",
    "/workspaces/{workspaceId}/labels",
    "admin",
    "Create a label every project in the workspace can use. When projects already define the name, the write fails with `label_conflict` unless `adopt` replaces those project definitions; their tickets keep the label.",
  ),
  update_workspace_label: op(
    z
      .object({
        ...mutation,
        workspaceId: z.uuid(),
        labelId: z.uuid(),
        expectedVersion: version,
        name: text.max(40),
        color: labelColor,
        adopt: z.boolean().default(false),
      })
      .strict(),
    workspaceLabelSchema,
    "PATCH",
    "/workspaces/{workspaceId}/labels/{labelId}",
    "admin",
    "Rename or recolor a workspace label. Renames update tickets and saved-view filters in every project of the workspace atomically; renaming onto a project label needs `adopt`.",
  ),
  delete_workspace_label: op(
    z
      .object({ ...mutation, workspaceId: z.uuid(), labelId: z.uuid(), expectedVersion: version })
      .strict(),
    okSchema,
    "DELETE",
    "/workspaces/{workspaceId}/labels/{labelId}",
    "admin",
    "Delete a workspace label and remove it from tickets and saved-view filters in every project of the workspace atomically.",
  ),
  list_invitations: op(
    z.object({ workspaceId: z.uuid() }),
    z.array(invitationSchema),
    "GET",
    "/workspaces/{workspaceId}/invitations",
    "admin",
    "List the workspace's pending and expired invitations.",
  ),
  create_invitation: op(
    // No requestId: the response carries the only copy of the link, so it is never stored in a
    // replay receipt. The same holds for resend.
    z
      .object({
        workspaceId: z.uuid(),
        email: z.email().overwrite((value) => value.toLowerCase()),
        role: z.enum(roles),
        // Omit or pass null for the whole workspace; otherwise the role applies to these projects.
        projectIds: z.array(z.uuid()).min(1).max(100).nullable().default(null),
        expiresInDays: z.number().int().min(1).max(30).default(7),
      })
      .strict(),
    sentInvitationSchema,
    "POST",
    "/workspaces/{workspaceId}/invitations",
    "admin",
    "Invite an email address with a fixed role on the workspace or selected projects. Returns the one-time link and emails it when the instance has SMTP.",
  ),
  resend_invitation: op(
    z
      .object({
        workspaceId: z.uuid(),
        invitationId: z.uuid(),
        expectedVersion: version,
        expiresInDays: z.number().int().min(1).max(30).default(7),
      })
      .strict(),
    sentInvitationSchema,
    "POST",
    "/workspaces/{workspaceId}/invitations/{invitationId}/resend",
    "admin",
    "Replace a pending or expired invitation's link, restart its expiry, and send it again.",
  ),
  revoke_invitation: op(
    z
      .object({
        ...mutation,
        workspaceId: z.uuid(),
        invitationId: z.uuid(),
        expectedVersion: version,
      })
      .strict(),
    okSchema,
    "DELETE",
    "/workspaces/{workspaceId}/invitations/{invitationId}",
    "admin",
    "Cancel an invitation so its link stops working.",
  ),
  get_invitation: op(
    z.object({ token: invitationToken }),
    z.object({
      workspace: z.object({ id: z.uuid(), name: z.string() }),
      email: z.string(),
      role: z.enum(roles),
      projects: z.array(invitedProject).nullable(),
      status: z.enum(invitationStatuses),
      invitedBy: z.string().nullable(),
      expiresAt: timestamp,
      // Whether the signed-in account's email is the invited address.
      matchesAccount: z.boolean(),
    }),
    "GET",
    "/invitations/{token}",
    "read",
    "Read the invitation behind a link from a signed-in session.",
  ),
  accept_invitation: op(
    z.object({ ...mutation, token: invitationToken }).strict(),
    z.object({ workspaceId: z.uuid(), projectIds: z.array(z.uuid()).nullable() }),
    "POST",
    "/invitations/accept",
    "write",
    "Accept an invitation addressed to the signed-in account's email.",
  ),
  list_projects: op(
    z.object({ workspaceId: z.uuid().optional(), archived: ticketFilter.shape.archived }),
    z.array(
      projectSchema.extend({
        openTickets: z.number().int().nonnegative(),
        overdueTickets: z.number().int().nonnegative(),
        // Defaults keep clients compatible with servers that predate these rollups.
        closedTickets: z.number().int().nonnegative().default(0),
        nextDueAt: timestamp.nullable().default(null),
        role: z.enum(roles),
        roleId: z.string().optional(),
        capabilities: z.array(z.enum(permissions)).optional(),
      }),
    ),
    "GET",
    "/projects",
    "read",
    "List projects accessible to the current identity, each with open, overdue, and closed ticket counts, the soonest upcoming open due date, and the caller's role and actions there. Archived projects are left out unless `archived` is `include` or `only`.",
  ),
  create_project: op(
    z
      .object({
        ...mutation,
        workspaceId: z.uuid().optional(),
        visibility: z.enum(["workspace", "private"]).default("private"),
        key: projectKey,
        name: text.max(120),
        description: z.string().max(5000).default(""),
      })
      .strict(),
    projectSchema,
    "POST",
    "/projects",
    "write",
    "Create a project with a ticket prefix that no project has used before.",
  ),
  get_project: op(
    projectInput,
    projectSchema,
    "GET",
    "/projects/{projectId}",
    "read",
    "Read project details, workspace identity, and appearance.",
  ),
  set_project_icon: op(
    projectInput
      .extend({
        ...mutation,
        expectedVersion: version,
        icon: z.union([
          z
            .object({
              kind: z.literal("library"),
              name: z.string().regex(/^[a-z0-9-]{1,80}$/),
              color: z.enum(projectIconColors).default("default"),
            })
            .strict(),
          z
            .object({
              kind: z.literal("image"),
              contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
              data: z.string().max(700000),
            })
            .strict(),
          z.null(),
        ]),
      })
      .strict(),
    projectSchema,
    "POST",
    "/projects/{projectId}/icon",
    "admin",
    "Choose an installed library icon, upload an image, or reset the project icon.",
  ),
  set_project_background: op(
    projectInput
      .extend({
        ...mutation,
        expectedVersion: version,
        background: z.union([
          z
            .object({
              contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
              data: z.string().max(700000),
            })
            .strict(),
          z.null(),
        ]),
      })
      .strict(),
    projectSchema,
    "POST",
    "/projects/{projectId}/background",
    "admin",
    "Upload an image shown behind the project's ticket views, or remove it.",
  ),
  update_project: op(
    projectInput
      .extend({
        ...mutation,
        expectedVersion: version,
        visibility: z.enum(["workspace", "private"]).optional(),
        publicReadEnabled: z.boolean().optional(),
        name: text.max(120),
        description: z.string().max(5000),
        key: projectKey.optional(),
      })
      .strict(),
    projectSchema,
    "PATCH",
    "/projects/{projectId}",
    "admin",
    "Update project details. A new `key` re-keys every ticket of the project; the previous prefix stays reserved for the project, and the project and every key issued under it keep resolving. `publicReadEnabled` shares or stops sharing the project's read-only public view (see the public operations).",
  ),
  move_project: op(
    projectInput
      .extend({ ...mutation, expectedVersion: version, ...placement })
      .strict()
      .refine(oneNeighbor, "Name one neighbor: before or after")
      .refine((input) => input.before ?? input.after, "Name a neighbor: before or after"),
    projectSchema,
    "POST",
    "/projects/{projectId}/move",
    "admin",
    "Place a project directly before or after another accessible project of its workspace in the shared project order.",
  ),
  archive_project: op(
    projectInput.extend({ ...mutation, expectedVersion: version, archived: z.boolean() }).strict(),
    projectSchema,
    "POST",
    "/projects/{projectId}/archive",
    "admin",
    "Archive a project, or restore it with `archived: false`. An archived project keeps its tickets and history but leaves default project lists, search, My work, calendar feeds, public links, reminders, and agent queues, and its tickets and settings are read only. Fails with `claim_conflict` while any ticket is claimed.",
  ),
  get_project_impact: op(
    projectInput.extend({ workspaceId: z.uuid().optional() }),
    projectImpactSchema,
    "GET",
    "/projects/{projectId}/impact",
    "admin",
    "Preview what deleting the project removes, or with `workspaceId`, what moving it to that workspace changes: who loses or gains access, labels copied or merged, follows and invitations dropped, and blockers such as claimed tickets.",
  ),
  transfer_project: op(
    projectInput.extend({ ...mutation, expectedVersion: version, workspaceId: z.uuid() }).strict(),
    projectSchema,
    "POST",
    "/projects/{projectId}/transfer",
    "admin",
    "Move a project with its tickets, keys, and links to another workspace. Requires administration of both workspaces and applies the reconciliation `get_project_impact` previews in one transaction; blockers fail with their code.",
  ),
  delete_project: op(
    projectInput
      .extend({ ...mutation, expectedVersion: version, confirmKey: z.string().max(20) })
      .strict(),
    okSchema,
    "DELETE",
    "/projects/{projectId}",
    "admin",
    "Permanently delete a project's tickets, comments, attachments, labels, feeds, and destinations. `confirmKey` must repeat the project prefix. Fails with `claim_conflict` while any ticket is claimed. The prefix stays reserved and the activity history and deletion events are kept.",
  ),
  export_project: op(
    projectInput,
    ticketExportSchema,
    "GET",
    "/projects/{projectId}/export",
    "read",
    "Export the project's tickets, archived ones included, as a versioned `kanvil.tickets` bundle: workflow states, custom fields, labels, relationships, comments, evidence, and links, with the people they name. Records reference each other by source ID. `completeness.omitted` counts what the bundle leaves out, such as attachments and activity history.",
  ),
  preview_import: op(
    z
      .object({
        ...mutation,
        workspaceId: z.uuid(),
        key: projectKey,
        name: text.max(120),
        visibility: z.enum(["workspace", "private"]).default("private"),
        bundle: ticketImportSchema,
      })
      .strict(),
    importRunSchema,
    "POST",
    "/workspaces/{workspaceId}/imports",
    "write",
    "Stage a `kanvil.tickets` bundle for import into a new project of the workspace and check it without writing tickets: references, workflow, custom field values, dependency cycles, and the prefix. People are matched by email to accounts that can open the new project. The run holds the issues found; errors block `start_import`. Signed-in accounts only; an unstarted run expires after 24 hours.",
  ),
  list_import_source_projects: op(
    z.object({ workspaceId: z.uuid(), source: importSourceSchema }).strict(),
    z.array(importSourceProjectSchema),
    "POST",
    "/workspaces/{workspaceId}/import-sources/projects",
    "write",
    "Connect to Linear, Jira, Trello, Plane, PLANKA, or Kaneo with the given credentials and list the teams, projects, or boards they can read, for `preview_source_import`. Only reads the source and writes nothing; the credentials serve this request alone. Signed-in accounts only.",
  ),
  preview_source_import: op(
    z
      .object({
        ...mutation,
        workspaceId: z.uuid(),
        key: projectKey,
        name: text.max(120),
        visibility: z.enum(["workspace", "private"]).default("private"),
        source: importSourceSchema,
        // The team or project `ref` from `list_import_source_projects`.
        sourceProject: z.string().trim().min(1).max(200),
        includeComments: z.boolean().default(true),
      })
      .strict(),
    importRunSchema,
    "POST",
    "/workspaces/{workspaceId}/imports/source",
    "write",
    "Read a Linear team, a Jira, Plane, or Kaneo project, or a Trello or PLANKA board with the given credentials, translate it into a `kanvil.tickets` bundle, and stage it like `preview_import`: workflow, issues with parents, priorities, labels, assignees, dates, checklists, relationships, and optionally comments. What the source holds that Kanvil cannot, such as cycles, estimates, and attachments, is listed among the warnings. Only reads the source, before the write; the credentials serve this request alone and are never stored, and a retry with the same `requestId` returns the staged run without reading the source again. Start the run with `start_import`. Signed-in accounts only.",
  ),
  list_imports: op(
    z.object({ workspaceId: z.uuid() }),
    z.array(importRunSchema),
    "GET",
    "/workspaces/{workspaceId}/imports",
    "read",
    "List your 20 most recently started imports into the workspace with their progress. Previews that were never started are left out.",
  ),
  get_import: op(
    importInput,
    importRunSchema,
    "GET",
    "/workspaces/{workspaceId}/imports/{importId}",
    "read",
    "Read one of your imports: its preview, progress, and the records that failed.",
  ),
  start_import: op(
    importInput.extend({ ...mutation, expectedVersion: version }).strict(),
    importRunSchema,
    "POST",
    "/workspaces/{workspaceId}/imports/{importId}/start",
    "write",
    "Start a previewed import without errors. The server creates the project and writes its records in the background through the regular operations, as you, resuming after a restart without duplicates. Imported writes carry import provenance on their events, notify no one, and reach no project destination.",
  ),
  cancel_import: op(
    importInput.extend({ ...mutation, expectedVersion: version }).strict(),
    importRunSchema,
    "POST",
    "/workspaces/{workspaceId}/imports/{importId}/cancel",
    "write",
    "Cancel a previewed or running import. Records already written stay in the new project.",
  ),
  list_members: op(
    projectInput,
    z.array(memberSchema),
    "GET",
    "/projects/{projectId}/members",
    "read",
    "List project members.",
  ),
  list_project_roles: op(
    projectInput,
    z.array(workspaceRoleSchema),
    "GET",
    "/projects/{projectId}/roles",
    "read",
    "List the roles a project membership can hold: the seeded roles and its workspace's custom roles.",
  ),
  set_member: op(
    projectInput.extend({ ...mutation, email: z.email(), role: roleId.nullable() }).strict(),
    okSchema,
    "POST",
    "/projects/{projectId}/members",
    "admin",
    "Add or update an existing user's membership with a seeded role or a custom role of the project's workspace, or remove it with a null role. Needs `member.manage`; the role, and any role the person holds now, must grant nothing the caller lacks.",
  ),
  list_tickets: op(
    projectInput
      .extend({
        ...ticketFilter.shape,
        ...pagination,
        // A ticket ID or key: only tickets linked to it by a relationship, in either direction.
        relatedTo: id.optional(),
        // Only tickets in this workflow state.
        stateId: z.uuid().optional(),
        // Only tickets whose span, from the start (or due) date to the due (or start) date,
        // overlaps [scheduledFrom, scheduledTo). Either bound alone also excludes undated tickets.
        scheduledFrom: timestamp.optional(),
        scheduledTo: timestamp.optional(),
      })
      .superRefine(rejectConflicts),
    page(ticketSchema),
    "GET",
    "/projects/{projectId}/tickets",
    "read",
    "Search tickets with server-side filters, stable ordering, and pagination. Each property filter takes one value or a repeated list (any of them); its `Not` twin excludes values.",
  ),
  list_ticket_labels: op(
    projectInput.extend({ archived: ticketFilter.shape.archived }),
    z.array(z.object({ name: z.string(), count: z.number().int().nonnegative() })),
    "GET",
    "/projects/{projectId}/labels",
    "read",
    "List distinct ticket labels and usage counts across the authorized project, independent of ticket pagination.",
  ),
  list_project_labels: op(
    projectInput,
    z.array(catalogLabelSchema),
    "GET",
    "/projects/{projectId}/labels/catalog",
    "read",
    "List the labels tickets in this project can use: the project's own definitions and its workspace's shared labels (`scope`), with colors and this project's ticket counts, including unused labels and archived tickets.",
  ),
  create_project_label: op(
    projectInput
      .extend({
        ...mutation,
        name: text.max(40),
        color: labelColor.default("gray"),
      })
      .strict(),
    projectLabelSchema,
    "POST",
    "/projects/{projectId}/labels",
    "admin",
    "Create a reusable project label. Label names are unique within the project and cannot repeat a workspace label.",
  ),
  update_project_label: op(
    projectInput
      .extend({
        ...mutation,
        labelId: z.uuid(),
        expectedVersion: version,
        name: text.max(40),
        color: labelColor,
      })
      .strict(),
    projectLabelSchema,
    "PATCH",
    "/projects/{projectId}/labels/{labelId}",
    "admin",
    "Rename or recolor a project label. Renames update tickets and saved-view filters atomically.",
  ),
  delete_project_label: op(
    projectInput.extend({ ...mutation, labelId: z.uuid(), expectedVersion: version }).strict(),
    okSchema,
    "DELETE",
    "/projects/{projectId}/labels/{labelId}",
    "admin",
    "Delete a project label and remove it from tickets and saved-view filters atomically.",
  ),
  list_label_colors: op(
    z.object({}),
    z.array(z.object({ value: hexColor, createdAt: timestamp })),
    "GET",
    "/label-colors",
    "read",
    "List the site-wide custom label colors, newest first. A custom color joins the list when a label is saved with it.",
  ),
  remove_label_color: op(
    z.object({ ...mutation, value: hexColor }).strict(),
    okSchema,
    "POST",
    "/label-colors/remove",
    "write",
    "Remove a custom color from the site-wide palette; instance administrators and the person who added it may do so. Labels already using it keep their color.",
  ),
  list_workflow_states: op(
    projectInput,
    z.array(workflowStateSchema.extend({ count: z.number().int().nonnegative() })),
    "GET",
    "/projects/{projectId}/workflow",
    "read",
    "List the project's workflow states in display order: by category (backlog, todo, in_progress, in_review, done, cancelled), then position. Counts include archived tickets. A ticket's status is its state's category, which open, closed, readiness, and claim rules read.",
  ),
  create_workflow_state: op(
    projectInput
      .extend({
        ...mutation,
        name: text.max(40),
        category: z.enum(states),
        color: labelColor.default("default"),
      })
      .strict(),
    workflowStateSchema,
    "POST",
    "/projects/{projectId}/workflow",
    "admin",
    "Add a workflow state at the end of its category. Its slug is derived from the name once and never changes. Reuse requestId when retrying this write.",
  ),
  update_workflow_state: op(
    projectInput
      .extend({
        ...mutation,
        stateId: z.uuid(),
        expectedVersion: version,
        name: text.max(40).optional(),
        color: labelColor.optional(),
        category: z.enum(states).optional(),
        // The state's new place within its category; a category change without one appends it.
        position: z.number().int().min(0).max(1000).optional(),
      })
      .strict()
      .refine(
        (input) =>
          input.name !== undefined ||
          input.color !== undefined ||
          input.category !== undefined ||
          input.position !== undefined,
        { message: "Change the name, color, category, or position" },
      ),
    workflowStateSchema,
    "PATCH",
    "/projects/{projectId}/workflow/{stateId}",
    "admin",
    "Rename, recolor, recategorize, or reorder a workflow state. A category change moves the status of every ticket in the state and publishes their updates. The last state of a category cannot leave it.",
  ),
  delete_workflow_state: op(
    projectInput
      .extend({ ...mutation, stateId: z.uuid(), expectedVersion: version, reassignTo: z.uuid() })
      .strict(),
    okSchema,
    "DELETE",
    "/projects/{projectId}/workflow/{stateId}",
    "admin",
    "Delete a workflow state after moving its tickets, archived ones included, to another state of the project, publishing their updates. The last state of a category cannot be deleted.",
  ),
  list_custom_fields: op(
    projectInput,
    z.array(customFieldSchema.extend({ count: z.number().int().nonnegative() })),
    "GET",
    "/projects/{projectId}/custom-fields",
    "read",
    "List the project's custom field definitions in display order, each with how many tickets hold a value, including archived tickets.",
  ),
  create_custom_field: op(
    projectInput
      .extend({
        ...mutation,
        name: customFieldSchema.shape.name,
        type: customFieldSchema.shape.type,
        options: customFieldOptions.default([]),
        required: z.boolean().default(false),
        defaultValue: customFieldValue.nullable().default(null),
      })
      .strict(),
    customFieldSchema,
    "POST",
    "/projects/{projectId}/custom-fields",
    "admin",
    "Define a typed ticket field: text, number, date (YYYY-MM-DD), checkbox, select, or multi-select with options. Names are unique within the project.",
  ),
  update_custom_field: op(
    projectInput
      .extend({
        ...mutation,
        fieldId: z.uuid(),
        expectedVersion: version,
        name: customFieldSchema.shape.name.optional(),
        // The complete option list in display order; options keep their IDs.
        options: customFieldOptions.optional(),
        required: z.boolean().optional(),
        // Null clears the default; omitting it keeps the saved one.
        defaultValue: customFieldValue.nullable().optional(),
        // Where the values of removed options go: another option of the new list, or null to clear.
        reassign: z.record(z.uuid(), z.uuid().nullable()).optional(),
      })
      .strict()
      .refine(
        (input) =>
          [input.name, input.options, input.required, input.defaultValue].some(
            (value) => value !== undefined,
          ),
        "Change the name, options, required rule, or default",
      ),
    customFieldSchema,
    "PATCH",
    "/projects/{projectId}/custom-fields/{fieldId}",
    "admin",
    "Rename a custom field, edit its options, or change its required rule or default at its current version. The type never changes. Removing an option that tickets or the default still use requires `reassign` to map it to a remaining option or to null; affected tickets and saved-view filters update atomically.",
  ),
  move_custom_field: op(
    projectInput
      .extend({ ...mutation, fieldId: z.uuid(), expectedVersion: version, ...placement })
      .strict()
      .refine(oneNeighbor, "Name one neighbor: before or after")
      .refine((input) => input.before ?? input.after, "Name a neighbor: before or after"),
    customFieldSchema,
    "POST",
    "/projects/{projectId}/custom-fields/{fieldId}/move",
    "admin",
    "Place a custom field directly before or after another field of the project in display order.",
  ),
  delete_custom_field: op(
    projectInput.extend({ ...mutation, fieldId: z.uuid(), expectedVersion: version }).strict(),
    okSchema,
    "DELETE",
    "/projects/{projectId}/custom-fields/{fieldId}",
    "admin",
    "Delete a custom field and remove its values from tickets and saved-view filters atomically.",
  ),
  get_ticket: op(
    ticketInput,
    z.object({
      ticket: ticketSchema,
      readiness: readinessSchema,
      claim: claimSchema.nullable(),
      subscribed: z.boolean(),
      canReleaseClaim: z.boolean(),
    }),
    "GET",
    "/projects/{projectId}/tickets/{ticketId}",
    "read",
    "Read a ticket by ID or key, with readiness and ownership.",
  ),
  create_ticket: op(
    projectInput
      .extend({
        ...mutation,
        title: ticketFields.shape.title,
        description: z.string().max(100_000).default(""),
        acceptanceCriteria: z.string().max(50_000).default(""),
        // Without either, the ticket starts in the first To do state.
        status: z.enum(states).optional(),
        stateId: z.uuid().optional(),
        priority: z.enum(priorities).default("medium"),
        kind: z.enum(kinds).default("feature"),
        difficulty: z.enum(difficulties).nullable().default(null),
        startAt: dueDate.nullable().default(null),
        dueAt: dueDate.nullable().default(null),
        labels: tags.default([]),
        scopes: tags.default([]),
        assigneeId: z.string().nullable().default(null),
        parentId: z.uuid().nullable().default(null),
        automationReady: z.boolean().default(false),
        holdReason: z.string().trim().max(2000).nullable().default(null),
        archived: z.boolean().default(false),
        uploads: z.array(z.uuid()).max(50).default([]),
        customFields: customFieldValues.default({}),
      })
      .strict(),
    ticketSchema,
    "POST",
    "/projects/{projectId}/tickets",
    "write",
    "Create a ticket. `customFields` maps field IDs from list_custom_fields to values; omitted fields take their default, and a required field must end with a value. `uploads` lists your staged inline uploads in this project; they become its attachments in the same write, or nothing is created. Reuse requestId when retrying this write.",
  ),
  duplicate_ticket: op(
    ticketInput.extend(mutation).strict(),
    ticketSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/duplicate",
    "write",
    "Copy a ticket into a new To do ticket in the same project, linked to the original by a clones relationship. Copies requirements, properties, labels, scopes, and parent; resets agent readiness and never copies claims, comments, evidence, attachments, or children. Reuse requestId when retrying this write.",
  ),
  update_ticket: op(
    ticketInput
      .extend({
        ...mutation,
        expectedVersion: version,
        changes: ticketChanges,
        claimId: z.uuid().optional(),
      })
      .strict(),
    ticketSchema,
    "PATCH",
    "/projects/{projectId}/tickets/{ticketId}",
    "write",
    "Update a ticket with optimistic concurrency. Worker completion requires its active claim. `changes.customFields` sets only the named fields; null clears one.",
  ),
  move_ticket: op(
    ticketInput
      .extend({
        ...mutation,
        expectedVersion: version,
        ...placement,
        // Written like a ticket update's: a state, a status, or both when they agree.
        status: z.enum(states).optional(),
        stateId: z.uuid().optional(),
        claimId: z.uuid().optional(),
      })
      .strict()
      .refine(oneNeighbor, "Name one neighbor: before or after")
      .refine(
        (input) => input.before ?? input.after ?? input.status ?? input.stateId,
        "Name a neighbor, a status or state, or both",
      ),
    ticketSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/move",
    "write",
    "Place a ticket directly before or after another ticket of the project in the manual order (`sort: manual`), optionally changing its status or workflow state in the same versioned write. Only the moved ticket changes place; reorders alone notify no one.",
  ),
  check_ticket_relocation: op(
    ticketInput.extend({ destinationProjectId: id }).strict(),
    z.object({
      destination: projectRef,
      // The destination's workflow; `stateId` is the first state of the ticket's current status.
      states: z.array(workflowStateSchema),
      stateId: z.uuid(),
      // Empty when the move can proceed. Codes: claimed, parent, children, relations, assignee,
      // custom_fields, required_fields.
      blockers: z.array(reason),
    }),
    "GET",
    "/projects/{projectId}/tickets/{ticketId}/relocation",
    "write",
    "Check a move to another project of the same workspace before making it: the destination's workflow states and anything that keeps the ticket where it is. Both projects require write access; a destination you cannot write to reads as not found.",
  ),
  relocate_ticket: op(
    ticketInput
      .extend({
        ...mutation,
        expectedVersion: version,
        destinationProjectId: id,
        // Without either, the ticket keeps its status in the destination's first state of it.
        status: z.enum(states).optional(),
        stateId: z.uuid().optional(),
      })
      .strict(),
    ticketSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/relocate",
    "write",
    "Move a ticket to another project of the same workspace. It keeps its ID, comments, attachments, evidence, links, and followers, takes the destination's next number as its new key, and its previous key keeps resolving. A claim, a parent or children, relationships, an assignee without destination access, custom field values, or a destination field that is required without a default block the move with `relocation_blocked`; the ticket takes the destination's custom field defaults. Activity before the move stays with the original project. Reuse requestId when retrying this write.",
  ),
  resolve_ticket: op(
    z.object({ ticketId: id }).strict(),
    z.object({ ticket: ticketSchema, project: projectRef }),
    "GET",
    "/tickets/resolve",
    "read",
    "Find a ticket by ID, current key, or any earlier key from a prefix change or a move, across every accessible project. An unknown or inaccessible ticket reads as not found.",
  ),
  bulk_update_tickets: op(
    projectInput
      .extend({
        ...mutation,
        tickets: ticketSelection,
        changes: ticketChanges,
      })
      .strict(),
    z.array(ticketSchema),
    "POST",
    "/projects/{projectId}/tickets/bulk",
    "write",
    "Apply an atomic bulk edit using each ticket's current version.",
  ),
  delete_ticket: op(
    ticketInput.extend({ ...mutation, expectedVersion: version }).strict(),
    okSchema,
    "DELETE",
    "/projects/{projectId}/tickets/{ticketId}",
    "admin",
    "Delete a ticket and publish a deletion event.",
  ),
  bulk_delete_tickets: op(
    projectInput.extend({ ...mutation, tickets: ticketSelection }).strict(),
    okSchema,
    "POST",
    "/projects/{projectId}/tickets/bulk-delete",
    "admin",
    "Delete up to 100 tickets atomically. Every ticket's version and ownership is checked before anything is deleted; children outside the selection lose their parent. Reuse requestId when retrying this write.",
  ),
  search_tickets: op(
    z
      .object({
        q: z.string().trim().min(1).max(200),
        workspaceId: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .strict(),
    z.object({
      items: z.array(
        z.object({
          ticket: ticketSchema,
          project: projectRef,
        }),
      ),
    }),
    "GET",
    "/tickets/search",
    "read",
    "Search unarchived tickets by key or text across every accessible project, optionally within one workspace.",
  ),
  search_workspace: op(
    z
      .object({
        q: z.string().trim().min(1).max(200),
        workspaceId: z.uuid().optional(),
        type: z.enum(searchResultTypes).optional(),
        ...filterShape,
        limit: z.coerce.number().int().min(1).max(50).default(20),
        offset: z.coerce.number().int().min(0).max(1000).default(0),
      })
      .strict()
      .superRefine(rejectConflicts),
    z.object({
      items: z.array(searchResultSchema),
      total: z.number().int().nonnegative(),
      counts: z.record(z.enum(searchResultTypes), z.number().int().nonnegative()),
      // What matched ticket text: the external index when it is current, otherwise PostgreSQL.
      engine: z.enum(["postgres", "index"]),
      // An external index is configured but behind or unavailable, so PostgreSQL answered.
      indexing: z.boolean(),
    }),
    "GET",
    "/search",
    "read",
    "Search accessible tickets, projects, comments, and activity by text or ticket key, optionally within one workspace or one result type. Property filters restrict results to matching tickets. Results order by exact key match, then type, then recency.",
  ),
  list_my_work: op(
    z
      .object({
        workspaceId: z.uuid().optional(),
        q: ticketFilter.shape.q,
        sort: ticketFilter.shape.sort,
        order: ticketFilter.shape.order,
        // How many of the most recent accessible events to return alongside the tickets.
        activity: z.coerce.number().int().min(0).max(50).default(0),
        ...pagination,
      })
      .strict(),
    page(ticketSchema).extend({ activity: z.array(eventSchema).default([]) }),
    "GET",
    "/my-work",
    "read",
    "List open, unarchived tickets assigned to the current identity across every accessible project, optionally within one workspace, with the most recent accessible activity when `activity` is set.",
  ),
  list_eligible_tickets: op(
    projectInput.extend(pagination),
    page(z.object({ ticket: ticketSchema, readiness: readinessSchema })),
    "GET",
    "/projects/{projectId}/eligibility",
    "read",
    "Inspect eligibility and explicit blocking reasons for open tickets.",
  ),
  list_relations: op(
    ticketInput,
    z.array(relationSchema),
    "GET",
    "/projects/{projectId}/tickets/{ticketId}/relations",
    "read",
    "List incoming and outgoing ticket relationships.",
  ),
  add_relation: op(
    ticketInput
      .extend({
        ...mutation,
        targetId: z.uuid(),
        type: relationSchema.shape.type,
        direction: relationDirections.optional(),
      })
      .strict(),
    relationSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/relations",
    "write",
    "Relate tickets while rejecting dependency cycles.",
  ),
  remove_relation: op(
    projectInput.extend({ ...mutation, relationId: z.uuid() }).strict(),
    okSchema,
    "DELETE",
    "/projects/{projectId}/relations/{relationId}",
    "write",
    "Remove a ticket relationship.",
  ),
  list_comments: op(
    ticketInput.extend(pagination),
    page(commentSchema),
    "GET",
    "/projects/{projectId}/tickets/{ticketId}/comments",
    "read",
    "Read ticket discussion.",
  ),
  add_comment: op(
    ticketInput.extend({ ...mutation, body: text.max(50_000) }).strict(),
    commentSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/comments",
    "write",
    "Add a comment with authenticated attribution. Mention a project member with `[@Name](mention:<user id>)` from list_members; members who can read the project are notified.",
  ),
  update_comment: op(
    projectInput
      .extend({
        ...mutation,
        commentId: z.uuid(),
        expectedVersion: version,
        body: text.max(50_000),
      })
      .strict(),
    commentSchema,
    "PATCH",
    "/projects/{projectId}/comments/{commentId}",
    "write",
    "Edit your own comment or moderate as a project administrator. Only mentions the edit adds are notified.",
  ),
  delete_comment: op(
    projectInput.extend({ ...mutation, commentId: z.uuid(), expectedVersion: version }).strict(),
    okSchema,
    "DELETE",
    "/projects/{projectId}/comments/{commentId}",
    "write",
    "Delete your own comment or moderate as a project administrator.",
  ),
  list_activity: op(
    ticketInput.extend(pagination),
    page(eventSchema),
    "GET",
    "/projects/{projectId}/tickets/{ticketId}/activity",
    "read",
    "Read durable ticket activity.",
  ),
  upload_attachment: op(
    ticketInput.extend({ ...mutation, ...fileFields }).strict(),
    attachmentSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/attachments",
    "write",
    "Upload up to 10 MB of base64-encoded bytes. The original filename is metadata, never a filesystem path.",
  ),
  stage_upload: op(
    projectInput.extend({ ...mutation, ...fileFields }).strict(),
    stagedUploadSchema,
    "POST",
    "/projects/{projectId}/uploads",
    "write",
    "Stage up to 10 MB of base64-encoded bytes for a ticket that does not exist yet. Only you can read it, at its attachment content address, until create_ticket claims it; unclaimed uploads expire after 24 hours.",
  ),
  discard_upload: op(
    projectInput.extend({ ...mutation, uploadId: z.uuid() }).strict(),
    okSchema,
    "DELETE",
    "/projects/{projectId}/uploads/{uploadId}",
    "write",
    "Delete one of your unclaimed staged uploads and its bytes.",
  ),
  list_attachments: op(
    ticketInput,
    z.array(attachmentSchema),
    "GET",
    "/projects/{projectId}/tickets/{ticketId}/attachments",
    "read",
    "List authorized attachment metadata.",
  ),
  delete_attachment: op(
    projectInput.extend({ ...mutation, attachmentId: z.uuid() }).strict(),
    okSchema,
    "DELETE",
    "/projects/{projectId}/attachments/{attachmentId}",
    "write",
    "Remove an attachment.",
  ),
  list_evidence: op(
    ticketInput,
    z.array(evidenceSchema),
    "GET",
    "/projects/{projectId}/tickets/{ticketId}/evidence",
    "read",
    "Read attributed evidence. Outcomes are reports from the submitting identity.",
  ),
  add_evidence: op(
    ticketInput
      .extend({ ...mutation, ...evidenceFields.shape, claimId: z.uuid().optional() })
      .strict(),
    evidenceSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/evidence",
    "write",
    "Attach evidence with its commit and provenance.",
  ),
  list_time_entries: op(
    ticketInput.extend(pagination),
    page(timeEntrySchema),
    "GET",
    "/projects/{projectId}/tickets/{ticketId}/time-entries",
    "read",
    "List observed time entries, newest first. Running entries have null endAt and durationMs.",
  ),
  get_time_entry: op(
    ticketInput.extend({ timeEntryId: z.uuid() }),
    timeEntrySchema,
    "GET",
    "/projects/{projectId}/tickets/{ticketId}/time-entries/{timeEntryId}",
    "read",
    "Read one attributed time entry within its current ticket and project.",
  ),
  create_time_entry: op(
    ticketInput
      .extend({ ...mutation, ...timeEntryFields.shape, claimId: z.uuid().optional() })
      .strict(),
    timeEntrySchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/time-entries",
    "write",
    "Record observed startAt and optional endAt timestamps. Duration is derived in milliseconds; at most one running entry per actor and ticket. Reuse requestId after interruption.",
  ),
  update_time_entry: op(
    ticketInput
      .extend({
        ...mutation,
        timeEntryId: z.uuid(),
        expectedVersion: version,
        claimId: z.uuid().optional(),
        startAt: timeEntryFields.shape.startAt.optional(),
        endAt: timeEntryFields.shape.endAt.unwrap().optional(),
        note: timeEntryFields.shape.note.unwrap().optional(),
      })
      .strict()
      .refine(
        (input) =>
          input.startAt !== undefined || input.endAt !== undefined || input.note !== undefined,
        {
          message: "Change the start, end, or note",
        },
      ),
    timeEntrySchema,
    "PATCH",
    "/projects/{projectId}/tickets/{ticketId}/time-entries/{timeEntryId}",
    "write",
    "Edit your own time entry at its current version; project administrators may edit any. Omitting endAt keeps it, null reopens it. Original actor attribution never changes.",
  ),
  delete_time_entry: op(
    ticketInput
      .extend({
        ...mutation,
        timeEntryId: z.uuid(),
        expectedVersion: version,
        claimId: z.uuid().optional(),
      })
      .strict(),
    okSchema,
    "DELETE",
    "/projects/{projectId}/tickets/{ticketId}/time-entries/{timeEntryId}",
    "write",
    "Delete your own time entry at its current version; project administrators may delete any. Reuse requestId when retrying.",
  ),
  list_resources: op(
    ticketInput,
    z.array(resourceSchema),
    "GET",
    "/projects/{projectId}/tickets/{ticketId}/resources",
    "read",
    "List the ticket's editable links. remoteState is null unless a configured connection confirmed it.",
  ),
  add_resource: op(
    ticketInput
      .extend({ ...mutation, ...resourceFields.shape, claimId: z.uuid().optional() })
      .strict(),
    resourceSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/resources",
    "write",
    "Link an HTTP or HTTPS resource with an optional title. Reuse requestId when retrying this write.",
  ),
  update_resource: op(
    projectInput
      .extend({
        ...mutation,
        resourceId: z.uuid(),
        expectedVersion: version,
        claimId: z.uuid().optional(),
        url: httpUrl.optional(),
        title: resourceTitle.optional(),
      })
      .strict()
      .refine((input) => input.url !== undefined || input.title !== undefined, {
        message: "Change the URL or the title",
      }),
    resourceSchema,
    "PATCH",
    "/projects/{projectId}/resources/{resourceId}",
    "write",
    "Edit a link's URL or title at its current version. Changing the URL clears confirmed remote state.",
  ),
  delete_resource: op(
    projectInput
      .extend({
        ...mutation,
        resourceId: z.uuid(),
        expectedVersion: version,
        claimId: z.uuid().optional(),
      })
      .strict(),
    okSchema,
    "DELETE",
    "/projects/{projectId}/resources/{resourceId}",
    "write",
    "Remove a link at its current version.",
  ),
  claim_ticket: op(
    ticketInput
      .extend({
        ...mutation,
        workerId: text.max(200),
        expectedVersion: version,
        leaseSeconds: claimLeaseSecondsSchema.optional(),
      })
      .strict(),
    claimSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/claim",
    "claim",
    "Atomically claim ready work. Expired claims require explicit recovery.",
  ),
  renew_claim: op(
    ticketInput
      .extend({
        ...mutation,
        claimId: z.uuid(),
        leaseSeconds: claimLeaseSecondsSchema.optional(),
      })
      .strict(),
    claimSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/claim/renew",
    "claim",
    "Renew the caller's unexpired claim.",
  ),
  release_claim: op(
    ticketInput.extend({ ...mutation, claimId: z.uuid() }).strict(),
    okSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/claim/release",
    "claim",
    "Release the caller's claim.",
  ),
  recover_claim: op(
    ticketInput
      .extend({
        ...mutation,
        claimId: z.uuid(),
        reason: text.min(10).max(2000),
        confirmedStopped: z.literal(true),
        reschedule: z.boolean().optional(),
        expectedVersion: version.optional(),
      })
      .strict()
      .refine((input) => !input.reschedule || input.expectedVersion !== undefined, {
        message: "expectedVersion is required to reschedule recovered work",
        path: ["expectedVersion"],
      }),
    okSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/claim/recover",
    "claim",
    "Recover an expired claim after confirming the worker stopped. Optionally reschedule it to To do at its expectedVersion.",
  ),
  set_subscription: op(
    ticketInput.extend({ ...mutation, enabled: z.boolean() }).strict(),
    okSchema,
    "POST",
    "/projects/{projectId}/tickets/{ticketId}/subscription",
    "read",
    "Subscribe to ticket updates or unsubscribe.",
  ),
  list_calendar_feeds: op(
    projectInput,
    z.array(calendarFeedSchema),
    "GET",
    "/projects/{projectId}/calendar-feeds",
    "admin",
    "List the project's calendar feeds. Tokens are never returned after creation.",
  ),
  create_calendar_feed: op(
    // No requestId: the response carries the only copy of the token, so it is never stored in a
    // replay receipt.
    projectInput
      .extend({
        name: text.max(80),
        labels: tags.default([]),
        timeZone: z.string().min(1).max(64),
      })
      .strict(),
    calendarFeedSchema.extend({ token: z.string(), path: z.string() }),
    "POST",
    "/projects/{projectId}/calendar-feeds",
    "admin",
    "Share the project's open, unarchived tickets that have a start or due date, optionally only those with any of the given labels, as an iCalendar feed of all-day events in the given IANA time zone. Anyone with the returned path can read the feed's ticket keys, titles, statuses, and dates; the token is shown only in this response.",
  ),
  revoke_calendar_feed: op(
    projectInput.extend({ ...mutation, feedId: z.uuid() }).strict(),
    okSchema,
    "DELETE",
    "/projects/{projectId}/calendar-feeds/{feedId}",
    "admin",
    "Revoke a calendar feed. Its link stops working immediately.",
  ),
  list_views: op(
    projectInput,
    z.array(z.object({ id: z.uuid(), name: z.string(), filters: ticketFilter })),
    "GET",
    "/projects/{projectId}/views",
    "read",
    "List your saved project views.",
  ),
  save_view: op(
    projectInput.extend({ ...mutation, name: text.max(80), filters: ticketFilter }).strict(),
    z.object({ id: z.uuid() }),
    "POST",
    "/projects/{projectId}/views",
    "read",
    "Save a personal filtered view.",
  ),
  delete_view: op(
    projectInput.extend({ ...mutation, viewId: z.uuid() }).strict(),
    okSchema,
    "DELETE",
    "/projects/{projectId}/views/{viewId}",
    "read",
    "Delete your own saved view.",
  ),
  list_notification_channels: op(
    z.object({}),
    z.array(notificationChannelSchema),
    "GET",
    "/notification-channels",
    "read",
    "List your notification channels with masked settings, routing, and delivery health.",
  ),
  create_notification_channel: op(
    z
      .object({
        ...mutation,
        name: text.max(80),
        settings: deliverySettingsInput,
        routes: channelRoutes.default([]),
        paused: z.boolean().default(false),
      })
      .strict(),
    notificationChannelSchema,
    "POST",
    "/notification-channels",
    "read",
    "Add an email, ntfy, Gotify, or signed webhook channel for your notifications. Signed-in sessions only. A channel sends nothing until a workspace route selects it.",
  ),
  update_notification_channel: op(
    z
      .object({
        ...mutation,
        channelId: z.uuid(),
        expectedVersion: version,
        name: text.max(80).optional(),
        settings: deliverySettingsInput.optional(),
        routes: channelRoutes.optional(),
        paused: z.boolean().optional(),
      })
      .strict(),
    notificationChannelSchema,
    "PATCH",
    "/notification-channels/{channelId}",
    "read",
    "Edit, pause, or reroute your notification channel. Omitted secrets keep their saved value; pausing and routing changes keep the saved configuration.",
  ),
  delete_notification_channel: op(
    z.object({ ...mutation, channelId: z.uuid(), expectedVersion: version }).strict(),
    okSchema,
    "DELETE",
    "/notification-channels/{channelId}",
    "read",
    "Disconnect your notification channel and discard its queued deliveries.",
  ),
  test_notification_channel: op(
    z.object({ ...mutation, channelId: z.uuid() }).strict(),
    okSchema,
    "POST",
    "/notification-channels/{channelId}/test",
    "read",
    "Queue a test message to your notification channel; its health shows the result.",
  ),
  list_project_destinations: op(
    projectInput,
    z.array(projectDestinationSchema),
    "GET",
    "/projects/{projectId}/destinations",
    "admin",
    "List the project's outgoing webhook and chat destinations with masked settings and delivery health.",
  ),
  create_project_destination: op(
    projectInput
      .extend({
        ...mutation,
        name: text.max(80),
        settings: deliverySettingsInput,
        events: z.array(z.enum(destinationEvents)).max(destinationEvents.length),
        paused: z.boolean().default(false),
      })
      .strict(),
    projectDestinationSchema,
    "POST",
    "/projects/{projectId}/destinations",
    "admin",
    "Send the project's ticket activity to a signed webhook, Slack, Discord, Mattermost, or Telegram.",
  ),
  update_project_destination: op(
    projectInput
      .extend({
        ...mutation,
        destinationId: z.uuid(),
        expectedVersion: version,
        name: text.max(80).optional(),
        settings: deliverySettingsInput.optional(),
        events: z.array(z.enum(destinationEvents)).max(destinationEvents.length).optional(),
        paused: z.boolean().optional(),
      })
      .strict(),
    projectDestinationSchema,
    "PATCH",
    "/projects/{projectId}/destinations/{destinationId}",
    "admin",
    "Edit, pause, or change the events of a project destination. Omitted secrets keep their saved value.",
  ),
  delete_project_destination: op(
    projectInput
      .extend({ ...mutation, destinationId: z.uuid(), expectedVersion: version })
      .strict(),
    okSchema,
    "DELETE",
    "/projects/{projectId}/destinations/{destinationId}",
    "admin",
    "Remove a project destination and discard its queued deliveries.",
  ),
  test_project_destination: op(
    projectInput.extend({ ...mutation, destinationId: z.uuid() }).strict(),
    okSchema,
    "POST",
    "/projects/{projectId}/destinations/{destinationId}/test",
    "admin",
    "Queue a test message to a project destination; its health shows the result.",
  ),
  list_repository_connections: op(
    projectInput,
    z.array(repositoryConnectionSchema),
    "GET",
    "/projects/{projectId}/repositories",
    "admin",
    "List the project's connected repositories with their webhook URL, mapped transitions, access check, and latest webhook. Secrets are never returned.",
  ),
  create_repository_connection: op(
    projectInput
      .extend({
        ...mutation,
        provider: z.enum(repositoryProviders).default("github"),
        repository: repositoryName,
        baseUrl: repositoryBaseUrl.optional(),
        token: repositorySecret,
        webhookSecret: repositorySecret,
        commentOnLink: z.boolean().default(false),
        transitions: repositoryTransitions.default({}),
        paused: z.boolean().default(false),
      })
      .strict(),
    repositoryConnectionSchema,
    "POST",
    "/projects/{projectId}/repositories",
    "admin",
    "Connect a GitHub, Gitea, or GitLab repository with an access token and a webhook secret, both write-only. Gitea and GitLab take the instance `baseUrl` (GitLab defaults to gitlab.com). Queues an access check; `health` shows its result.",
  ),
  update_repository_connection: op(
    projectInput
      .extend({
        ...mutation,
        connectionId: z.uuid(),
        expectedVersion: version,
        repository: repositoryName.optional(),
        baseUrl: repositoryBaseUrl.optional(),
        token: repositorySecret.optional(),
        webhookSecret: repositorySecret.optional(),
        commentOnLink: z.boolean().optional(),
        transitions: repositoryTransitions.optional(),
        paused: z.boolean().optional(),
      })
      .strict(),
    repositoryConnectionSchema,
    "PATCH",
    "/projects/{projectId}/repositories/{connectionId}",
    "admin",
    "Reconnect, pause, or change the transitions of a repository connection. Omitted secrets keep their saved value; a new repository, base URL, or token queues another access check.",
  ),
  delete_repository_connection: op(
    projectInput.extend({ ...mutation, connectionId: z.uuid(), expectedVersion: version }).strict(),
    okSchema,
    "DELETE",
    "/projects/{projectId}/repositories/{connectionId}",
    "admin",
    "Disconnect a repository. Its webhook stops being accepted at once; links it verified stay on their tickets.",
  ),
  verify_repository_connection: op(
    projectInput.extend({ ...mutation, connectionId: z.uuid() }).strict(),
    okSchema,
    "POST",
    "/projects/{projectId}/repositories/{connectionId}/verify",
    "admin",
    "Queue an access check of the saved token against the repository; `health` shows the result.",
  ),
  preview_repository_sync: op(
    projectInput
      .extend({
        ...mutation,
        connectionId: z.uuid(),
        outbound: syncRuleSchema,
        inbound: syncRuleSchema,
      })
      .strict(),
    syncPreviewSchema,
    "POST",
    "/projects/{projectId}/repositories/{connectionId}/sync/preview",
    "admin",
    "Count what applying these issue sync rules would do without changing anything. Issues import when the host next reports them, so imports are not counted.",
  ),
  apply_repository_sync: op(
    projectInput
      .extend({
        ...mutation,
        connectionId: z.uuid(),
        expectedVersion: version,
        outbound: syncRuleSchema,
        inbound: syncRuleSchema,
        fingerprint: z.string().max(100),
      })
      .strict(),
    repositoryConnectionSchema,
    "POST",
    "/projects/{projectId}/repositories/{connectionId}/sync",
    "admin",
    "Save issue sync rules and apply the previewed effects: queue new issues for exported tickets, pause links that no longer qualify, and hold requalifying links for review. Refused with `version_conflict` when the preview's `fingerprint` is stale.",
  ),
  list_issue_links: op(
    projectInput.extend({ connectionId: z.uuid() }),
    z.array(issueLinkSchema),
    "GET",
    "/projects/{projectId}/repositories/{connectionId}/issue-links",
    "admin",
    "List the tickets this connection synchronizes with issues, with each link's state.",
  ),
  compare_issue_link: op(
    projectInput.extend({ linkId: z.uuid() }),
    issueComparisonSchema,
    "GET",
    "/projects/{projectId}/issue-links/{linkId}",
    "admin",
    "Compare a linked ticket's title, description, and open state with its issue as the host last reported it.",
  ),
  reconcile_issue_link: op(
    projectInput
      .extend({
        ...mutation,
        linkId: z.uuid(),
        expectedVersion: version,
        ticketVersion: version,
        resolution: z.enum(["kanvil", "remote", "unlink"]),
      })
      .strict(),
    okSchema,
    "POST",
    "/projects/{projectId}/issue-links/{linkId}/reconcile",
    "admin",
    "Resume a paused, conflicting, or unconfirmed link from the side chosen as authoritative, or unlink it. `kanvil` writes the ticket to the issue (or creates the issue again); `remote` writes the issue to the ticket. Both versions come from `compare_issue_link`; a change on either side since then is refused with `version_conflict`. Unlinking keeps the ticket and the issue.",
  ),
} as const;

// Anonymous, read-only views of projects whose administrators turned on public read. The server
// answers them under /api/public without a session or credential. Each output is the public
// projection of the matching member read: parsing drops every field these schemas do not name, so
// people, comments, activity, attachments, evidence, claims, and coordination fields stay private.
// Archived tickets are not published at all.
// A mention publishes the name its author wrote, never the member's account ID.
const publicText = z
  .string()
  .overwrite((value) => value.replaceAll(/\[(@(?:\\.|[^\]\\])*)\]\(mention:[^)\s]*\)/g, "$1"));
export const publicTicketSchema = ticketSchema
  .pick({
    id: true,
    projectId: true,
    key: true,
    number: true,
    title: true,
    description: true,
    acceptanceCriteria: true,
    status: true,
    stateId: true,
    priority: true,
    kind: true,
    difficulty: true,
    labels: true,
    scopes: true,
    parentId: true,
    startAt: true,
    dueAt: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({ description: publicText, acceptanceCriteria: publicText });
export type PublicTicket = z.output<typeof publicTicketSchema>;
const publicReference = publicTicketSchema.pick({
  id: true,
  key: true,
  title: true,
  status: true,
  stateId: true,
});
export const publicProjectSchema = projectSchema
  .pick({ id: true, key: true, name: true, iconName: true, iconColor: true })
  .extend({
    description: publicText,
    states: z.array(
      workflowStateSchema.pick({
        id: true,
        name: true,
        category: true,
        color: true,
        position: true,
      }),
    ),
    labels: z.array(z.object({ name: z.string(), color: labelColor })),
  });
export type PublicProject = z.output<typeof publicProjectSchema>;
const publicProjectInput = z.object({ projectId: z.uuid() });
const publicOp = <I extends z.ZodObject, O extends z.ZodType>(
  input: I,
  output: O,
  path: string,
  description: string,
) => ({ input, output, method: "GET" as const, path, description });
export const publicOperations = {
  get_public_project: publicOp(
    publicProjectInput,
    publicProjectSchema,
    "/projects/{projectId}",
    "Read a shared project's name, description, icon, workflow states, and the colors of labels its unarchived tickets use.",
  ),
  list_public_tickets: publicOp(
    publicProjectInput.extend(pagination).strict(),
    page(publicTicketSchema),
    "/projects/{projectId}/tickets",
    "List a shared project's unarchived tickets by status, then number.",
  ),
  get_public_ticket: publicOp(
    publicProjectInput.extend({ ticketId: id }).strict(),
    z.object({
      ticket: publicTicketSchema,
      parent: publicReference.nullable(),
      children: z.array(publicReference),
      relations: z.array(relationSchema.omit({ projectId: true })),
    }),
    "/projects/{projectId}/tickets/{ticketId}",
    "Read a shared project's unarchived ticket by ID or key with its unarchived parent, children, and related tickets.",
  ),
} as const;
export type PublicOperation = keyof typeof publicOperations;
export type PublicInput<K extends PublicOperation> = z.input<(typeof publicOperations)[K]["input"]>;
export type PublicOutput<K extends PublicOperation> = z.output<
  (typeof publicOperations)[K]["output"]
>;
export function isPublicOperation(name: string): name is PublicOperation {
  return Object.hasOwn(publicOperations, name);
}
export function parsePublicOutput<K extends PublicOperation>(
  name: K,
  value: unknown,
): PublicOutput<K> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The registry key selects and validates the generic result schema.
  return publicOperations[name].output.parse(value) as PublicOutput<K>;
}

export type Operation = keyof typeof operations;
// The action an operation needs from the caller's role where it runs: none to read, the writer's
// action for other writes, and project or workspace management to administer, except where a
// narrower action owns the operation.
const permissionOverrides: Partial<Record<Operation, Permission | null>> = {
  set_member: "member.manage",
  set_workspace_member: "member.manage",
  list_invitations: "invitation.manage",
  create_invitation: "invitation.manage",
  resend_invitation: "invitation.manage",
  revoke_invitation: "invitation.manage",
  delete_ticket: "ticket.delete",
  bulk_delete_tickets: "ticket.delete",
  list_calendar_feeds: "sharing.manage",
  create_calendar_feed: "sharing.manage",
  revoke_calendar_feed: "sharing.manage",
  // Details need `project.manage` and the public link `sharing.manage`; the handler checks what
  // changed.
  update_project: null,
};
export function operationPermission(name: Operation): Permission | null {
  if (Object.hasOwn(permissionOverrides, name)) return permissionOverrides[name] ?? null;
  const { scope, path } = operations[name];
  if (scope === "read") return null;
  if (scope !== "admin") return "ticket.write";
  return path.startsWith("/workspaces/") ? "workspace.manage" : "project.manage";
}
// The credential scope an action needs; a credential never acts beyond its scopes.
export const permissionScope = (permission: Permission): (typeof scopes)[number] =>
  permission === "ticket.write" ? "write" : "admin";
export type Input<K extends Operation> = z.input<(typeof operations)[K]["input"]>;
export type ParsedInput<K extends Operation> = z.output<(typeof operations)[K]["input"]>;
export type Output<K extends Operation> = z.output<(typeof operations)[K]["output"]>;
export function isOperation(name: string): name is Operation {
  return Object.hasOwn(operations, name);
}
export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export const streamErrorSchema = z.object({
  status: z.number().int().min(400).max(599),
  code: z.string(),
  message: z.string(),
});

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function parseOutput<K extends Operation>(name: K, value: unknown): Output<K> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The registry key selects and validates the generic result schema.
  return operations[name].output.parse(value) as Output<K>;
}

export function errorMessage(error: unknown): string {
  if (
    error instanceof Error &&
    /fetch failed|failed to fetch|network request failed|could not connect to the server/i.test(
      error.message,
    )
  )
    return t("common.error.network");
  if (error instanceof z.ZodError)
    return error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || t("common.error.input")}: ${issue.message}`)
      .join("; ");
  if (error instanceof ApiError && Array.isArray(error.details)) {
    const details = z
      .array(z.object({ path: z.string(), message: z.string() }))
      .safeParse(error.details);
    if (details.success)
      return details.data
        .slice(0, 3)
        .map((issue) => `${issue.path || t("common.error.input")}: ${issue.message}`)
        .join("; ");
  }
  // The server explains in English; other languages read the code's own wording.
  if (
    error instanceof ApiError &&
    activeLocale() !== defaultLocale &&
    isTranslatedError(error.code)
  )
    return t(`common.error.code.${error.code}`);
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : t("common.error.fallback");
}
const translatedErrors = [
  "unauthorized",
  "session_required",
  "account_disabled",
  "forbidden",
  "insufficient_scope",
  "workspace_scope_required",
  "invalid_origin",
  "not_found",
  "version_conflict",
  "claim_conflict",
  "idempotency_conflict",
  "project_archived",
  "rate_limited",
  "snapshot_required",
  "request_failed",
] as const;
const isTranslatedError = (code: string): code is (typeof translatedErrors)[number] =>
  translatedErrors.some((known) => known === code);

export function formatTimestamp(value: string): string {
  return formatDate(value, { dateStyle: "medium", timeStyle: "short" });
}
