CREATE TABLE "project_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'gray' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "project_label_name" UNIQUE("project_id","name")
);
--> statement-breakpoint
ALTER TABLE "project_labels" ADD CONSTRAINT "project_labels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "project_labels" ("project_id", "name")
SELECT DISTINCT "project_id", unnest("labels") FROM "tickets"
ON CONFLICT DO NOTHING;
