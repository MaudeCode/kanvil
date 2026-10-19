CREATE TABLE "issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"number" integer,
	"url" text,
	"base" jsonb,
	"remote" jsonb,
	"remote_at" timestamp with time zone,
	"synced_from" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_link_ticket" UNIQUE("connection_id","ticket_id"),
	CONSTRAINT "issue_link_number" UNIQUE("connection_id","number")
);
--> statement-breakpoint
CREATE TABLE "synced_comments" (
	"link_id" uuid NOT NULL,
	"comment_id" uuid,
	"remote_id" text NOT NULL,
	CONSTRAINT "synced_comments_link_id_remote_id_pk" PRIMARY KEY("link_id","remote_id"),
	CONSTRAINT "synced_comment_local" UNIQUE("comment_id")
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "issue_link_id" uuid;--> statement-breakpoint
ALTER TABLE "repository_connections" ADD COLUMN "outbound" jsonb DEFAULT '{"enabled":false,"labels":[],"match":"any"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "repository_connections" ADD COLUMN "inbound" jsonb DEFAULT '{"enabled":false,"labels":[],"match":"any"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_connection_id_repository_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."repository_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synced_comments" ADD CONSTRAINT "synced_comments_link_id_issue_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."issue_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synced_comments" ADD CONSTRAINT "synced_comments_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_link_ticket_id" ON "issue_links" USING btree ("ticket_id");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_issue_link_id_issue_links_id_fk" FOREIGN KEY ("issue_link_id") REFERENCES "public"."issue_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_issue_sync" ON "deliveries" USING btree ("issue_link_id") WHERE "deliveries"."event_id" IS NULL AND "deliveries"."finished_at" IS NULL;