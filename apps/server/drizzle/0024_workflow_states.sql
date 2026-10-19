CREATE TABLE "workflow_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"color" text DEFAULT 'default' NOT NULL,
	"position" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "workflow_state_slug" UNIQUE("project_id","slug"),
	CONSTRAINT "workflow_state_category" UNIQUE("project_id","id","category"),
	CONSTRAINT "workflow_state_category_check" CHECK ("workflow_states"."category" IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "state_id" uuid;--> statement-breakpoint
-- Every existing project starts with the six canonical states, and each ticket moves to the state
-- of its status. A status outside the canonical set becomes To do.
INSERT INTO "workflow_states" ("project_id", "slug", "name", "category", "position")
SELECT "projects"."id", defaults.slug, defaults.name, defaults.slug, 0
FROM "projects"
CROSS JOIN (VALUES
	('backlog', 'Backlog'),
	('todo', 'To do'),
	('in_progress', 'In progress'),
	('in_review', 'In review'),
	('done', 'Done'),
	('cancelled', 'Cancelled')
) AS defaults(slug, name);--> statement-breakpoint
UPDATE "tickets" SET "status" = 'todo'
WHERE "status" NOT IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled');--> statement-breakpoint
UPDATE "tickets" SET "state_id" = "workflow_states"."id"
FROM "workflow_states"
WHERE "workflow_states"."project_id" = "tickets"."project_id"
	AND "workflow_states"."category" = "tickets"."status";--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "state_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_states" ADD CONSTRAINT "workflow_states_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "ticket_workflow_state" FOREIGN KEY ("project_id","state_id","status") REFERENCES "public"."workflow_states"("project_id","id","category") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "ticket_state" ON "tickets" USING btree ("state_id");