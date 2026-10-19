import { z } from "zod";
import { memberSchema, roles } from "./index.ts";
export const accountSchema = memberSchema.pick({ name: true, email: true, image: true }).extend({
  id: z.string(),
  role: z.string().nullable(),
  banned: z.boolean(),
  createdAt: z.iso.datetime(),
});
export const accountQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  role: z.enum(["all", "user", "admin"]).default("all"),
  status: z.enum(["all", "active", "disabled"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export const accountsSchema = z.object({
  users: z.array(accountSchema),
  total: z.number().int().nonnegative(),
});
export const accountDetailsSchema = accountSchema.extend({
  workspaces: z.array(z.object({ id: z.uuid(), name: z.string(), role: z.enum(roles) })),
  projects: z.array(z.object({ id: z.uuid(), name: z.string(), role: z.enum(roles) })),
  providers: z.array(z.string()),
  sessionCount: z.number().int().nonnegative(),
});
export const localPasswordSchema = z.object({ password: z.string().min(12).max(128) }).strict();
export type ManagedAccount = z.output<typeof accountSchema>;
export const adminWorkspaceQuerySchema = accountQuerySchema.pick({
  q: true,
  limit: true,
  offset: true,
});
export const adminWorkspacesSchema = z.object({
  workspaces: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      slug: z.string(),
      // Null for a workspace without an owner; servers that predate ownership omit it.
      ownerId: z.string().nullable().default(null),
      createdAt: z.iso.datetime(),
      memberCount: z.number().int().nonnegative(),
      projectCount: z.number().int().nonnegative(),
      administrators: z.array(
        accountSchema.pick({ id: true, name: true, email: true, image: true }),
      ),
    }),
  ),
  total: z.number().int().nonnegative(),
});
export type AdminWorkspace = z.output<typeof adminWorkspacesSchema>["workspaces"][number];
