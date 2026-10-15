import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { account, session, user } from "./auth-schema.ts";
import { createAuth } from "./auth.ts";
import { fail } from "./domain.ts";
import type { Config } from "./config.ts";
import type { Database } from "./database.ts";

export const localPasswordSchema = z.string().min(12).max(128);
export async function recoverLocalPassword(
  database: Database,
  config: Config,
  email: string,
  password: string,
) {
  const normalizedEmail = z.email().parse(email.trim().toLowerCase());
  localPasswordSchema.parse(password);
  const context = await createAuth(database, config).$context;
  const hash = await context.password.hash(password);
  return database.db.transaction(async (tx) => {
    const identity = (
      await tx.select().from(user).where(eq(user.email, normalizedEmail)).for("update")
    )[0];
    if (!identity) fail(404, "not_found", "No account has this email address");
    const where = and(eq(account.userId, identity.id), eq(account.providerId, "credential"));
    const existing = (await tx.select().from(account).where(where))[0];
    if (existing)
      await tx.update(account).set({ password: hash, updatedAt: new Date() }).where(where);
    else
      await tx.insert(account).values({
        id: crypto.randomUUID(),
        accountId: identity.id,
        userId: identity.id,
        providerId: "credential",
        password: hash,
        updatedAt: new Date(),
      });
    await tx.delete(session).where(eq(session.userId, identity.id));
    return identity.id;
  });
}
