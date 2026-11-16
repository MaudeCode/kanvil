CREATE TABLE "epic_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"epic_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "acceptance_criteria" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "status" text DEFAULT 'todo' NOT NULL;--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "priority" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "assignee_id" text;--> statement-breakpoint
ALTER TABLE "epic_comments" ADD CONSTRAINT "epic_comments_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epic_comments" ADD CONSTRAINT "epic_comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epic_comments" ADD CONSTRAINT "epic_comments_epic_id_epics_id_fk" FOREIGN KEY ("epic_id") REFERENCES "public"."epics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "epic_comment_epic" ON "epic_comments" USING btree ("epic_id");--> statement-breakpoint
ALTER TABLE "epics" ADD CONSTRAINT "epics_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;