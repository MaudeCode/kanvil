CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid,
	"event_id" bigint,
	"device_id" uuid,
	"channel_id" uuid,
	"destination_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"receipt_id" text,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_device" UNIQUE("notification_id","device_id"),
	CONSTRAINT "delivery_channel" UNIQUE("notification_id","channel_id"),
	CONSTRAINT "delivery_destination" UNIQUE("event_id","destination_id"),
	CONSTRAINT "delivery_one_target" CHECK (num_nonnulls("deliveries"."device_id", "deliveries"."channel_id", "deliveries"."destination_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"settings" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"routes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "project_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"settings" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_device_id_push_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."push_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_destination_id_project_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."project_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_destinations" ADD CONSTRAINT "project_destinations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_destinations" ADD CONSTRAINT "project_destinations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_pending" ON "deliveries" USING btree ("finished_at","available_at");--> statement-breakpoint
CREATE INDEX "notification_channel_user" ON "notification_channels" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "project_destination_project" ON "project_destinations" USING btree ("project_id");--> statement-breakpoint
INSERT INTO "deliveries" ("id", "notification_id", "device_id", "attempts", "available_at", "receipt_id", "finished_at", "error")
SELECT "id", "notification_id", "device_id", "attempts", "available_at", "receipt_id", "finished_at", "error" FROM "push_deliveries";
