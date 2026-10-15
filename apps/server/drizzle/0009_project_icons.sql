ALTER TABLE "projects" ADD COLUMN "icon_name" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "icon_color" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "icon_object_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_icon_object_id_blob_objects_id_fk" FOREIGN KEY ("icon_object_id") REFERENCES "public"."blob_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_workspace" ON "projects" USING btree ("workspace_id");