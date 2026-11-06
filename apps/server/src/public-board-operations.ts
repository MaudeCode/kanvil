import { asc, desc, eq } from "drizzle-orm";
import { publicBoardCandidates, publicBoards } from "./schema.ts";
import { assertVersion, fail, one, project, publish, type Handlers } from "./domain.ts";

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
    if (input.enabled && !input.labels.length)
      fail(400, "validation_error", "Name a label before enabling a public board", [
        { path: "labels", message: "Name a label before enabling a public board" },
      ]);
    const [current] = await ctx.db
      .select()
      .from(publicBoards)
      .where(eq(publicBoards.projectId, id));
    assertVersion(current ?? { version: 0 }, input.expectedVersion ?? 0, "public board", "saving");
    const fields = {
      enabled: input.enabled,
      title: input.title,
      labels: input.labels,
      excludedLabels: input.excludedLabels,
    };
    const board = one(
      await ctx.db
        .insert(publicBoards)
        .values({ projectId: id, ...fields })
        .onConflictDoUpdate({
          target: publicBoards.projectId,
          set: { ...fields, version: (current?.version ?? 0) + 1, updatedAt: new Date() },
        })
        .returning(),
    );
    await publish(ctx, "public_board.updated", null, { ...fields, version: board.version });
    return board;
  },
};
