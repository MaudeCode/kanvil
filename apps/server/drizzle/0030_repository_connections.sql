CREATE TABLE "received_webhooks" (
	"connection_id" uuid NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"outcome" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "received_webhooks_connection_id_delivery_id_pk" PRIMARY KEY("connection_id","delivery_id")
);
--> statement-breakpoint
CREATE TABLE "repository_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"repository" text NOT NULL,
	"settings" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"comment_on_link" boolean DEFAULT false NOT NULL,
	"transitions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event_at" timestamp with time zone,
	"last_event_error" text,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "repository_connection_name" UNIQUE("project_id","repository")
);
--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT "delivery_one_target";--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "remote_kind" text;--> statement-breakpoint
ALTER TABLE "received_webhooks" ADD CONSTRAINT "received_webhooks_connection_id_repository_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."repository_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_connections" ADD CONSTRAINT "repository_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_connections" ADD CONSTRAINT "repository_connections_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_connection_id_repository_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."repository_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "delivery_connection" UNIQUE("event_id","connection_id");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "delivery_one_target" CHECK (num_nonnulls("deliveries"."device_id", "deliveries"."channel_id", "deliveries"."destination_id", "deliveries"."connection_id") = 1);