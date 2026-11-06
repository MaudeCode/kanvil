import { asc, desc, eq } from "drizzle-orm";
import { publicBoardCandidates, publicBoards } from "./schema.ts";
import { one, project, type Handlers } from "./domain.ts";

export const publicBoardHandlers: Pick<Handlers, "get_project_board" | "update_project_board"> = {
  async get_project_board(ctx) {
    const id = project(ctx).id;
    const [board] = await ctx.db.select().from(publicBoards).where(eq(publicBoards.projectId, id));
    return {
      board: board ?? null,
      tickets: await ctx.db
        .select()
        .from(publicBoardCandidates)
        .where(eq(publicBoardCandidates.projectId, id))
        .orderBy(desc(publicBoardCandidates.createdAt), asc(publicBoardCandidates.key)),
    };
  },
  async update_project_board(ctx, input) {
    const id = project(ctx).id;
    const [current] = await ctx.db
      .select()
      .from(publicBoards)
      .where(eq(publicBoards.projectId, id));
    const fields = {
      enabled: input.enabled,
      title: input.title,
      labels: input.labels,
      excludedLabels: input.excludedLabels,
    };
    return one(
      await ctx.db
        .insert(publicBoards)
        .values({ projectId: id, ...fields })
        .onConflictDoUpdate({
          target: publicBoards.projectId,
          set: { ...fields, version: (current?.version ?? 0) + 1, updatedAt: new Date() },
        })
        .returning(),
    );
  },
};
