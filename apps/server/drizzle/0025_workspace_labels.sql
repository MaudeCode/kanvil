CREATE TABLE "workspace_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'gray' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "workspace_label_name" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
ALTER TABLE "workspace_labels" ADD CONSTRAINT "workspace_labels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;