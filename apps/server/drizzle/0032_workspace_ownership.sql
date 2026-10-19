ALTER TABLE "workspaces" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Each workspace is owned by its earliest-created active administrator member, ties broken by
-- account ID. A workspace without one stays unowned until an instance administrator transfers it.
UPDATE "workspaces" w SET "owner_id" = (
	SELECT m."user_id" FROM "workspace_members" m JOIN "user" u ON u."id" = m."user_id"
	WHERE m."workspace_id" = w."id" AND m."role" = 'admin' AND NOT coalesce(u."banned", false)
	ORDER BY u."created_at", u."id" LIMIT 1
);
