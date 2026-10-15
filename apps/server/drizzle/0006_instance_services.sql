CREATE TABLE "blob_objects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"backend_id" uuid,
	"object_key" text,
	"data" "bytea",
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"identity" uuid DEFAULT gen_random_uuid() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"name" text DEFAULT 'Kanvil' NOT NULL,
	"description" text DEFAULT 'Ticketing for people and agents' NOT NULL,
	"storage_backend_id" uuid,
	"search_config" text
);
--> statement-breakpoint
CREATE TABLE "profile_photos" (
	"user_id" text PRIMARY KEY NOT NULL,
	"object_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"config_hash" text DEFAULT '' NOT NULL,
	"cursor" bigint DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "storage_backends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity" text NOT NULL,
	"config" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_backends_identity_unique" UNIQUE("identity")
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "object_id" uuid;--> statement-breakpoint
ALTER TABLE "blob_objects" ADD CONSTRAINT "blob_objects_backend_id_storage_backends_id_fk" FOREIGN KEY ("backend_id") REFERENCES "public"."storage_backends"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_storage_backend_id_storage_backends_id_fk" FOREIGN KEY ("storage_backend_id") REFERENCES "public"."storage_backends"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_photos" ADD CONSTRAINT "profile_photos_object_id_blob_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."blob_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blob_objects_created" ON "blob_objects" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_object_id_blob_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."blob_objects"("id") ON DELETE no action ON UPDATE no action;