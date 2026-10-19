ALTER TABLE "projects" ADD COLUMN "position" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "position" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "ticket_project_position" ON "tickets" USING btree ("project_id","position");--> statement-breakpoint
-- Existing tickets keep creation order and projects keep their alphabetical order, spaced for later moves.
UPDATE "tickets" SET "position" = "number"::bigint * 1024;--> statement-breakpoint
UPDATE "projects" SET "position" = ordered.rank * 1024 FROM (SELECT "id", row_number() OVER (PARTITION BY "workspace_id" ORDER BY "name", "id") AS rank FROM "projects") AS ordered WHERE "projects"."id" = ordered."id";
