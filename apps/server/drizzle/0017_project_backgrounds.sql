ALTER TABLE "projects" ADD COLUMN "background" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "background_object_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_background_object_id_blob_objects_id_fk" FOREIGN KEY ("background_object_id") REFERENCES "public"."blob_objects"("id") ON DELETE no action ON UPDATE no action;