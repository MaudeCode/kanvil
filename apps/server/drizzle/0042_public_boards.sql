CREATE TABLE "public_boards" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"excluded_labels" text[] DEFAULT '{}' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "public_boards" ADD CONSTRAINT "public_boards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE VIEW "public_board_candidates" WITH (security_invoker = true) AS
  SELECT t.*
  FROM "tickets" t
  JOIN "public_boards" b ON b."project_id" = t."project_id";
--> statement-breakpoint
CREATE VIEW "public_board_tickets" WITH (security_invoker = true) AS
  SELECT * FROM "public_board_candidates";
--> statement-breakpoint
CREATE VIEW "public_board_summaries" WITH (security_invoker = true) AS
  SELECT * FROM "public_boards";
