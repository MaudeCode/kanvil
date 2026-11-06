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
CREATE VIEW "public_board_candidates" WITH (security_barrier) AS
  SELECT t."project_id", t."key", t."title", t."kind", t."status", t."created_at", t."updated_at"
  FROM "tickets" t
  JOIN "public_boards" b ON b."project_id" = t."project_id"
  JOIN "projects" p ON p."id" = b."project_id"
  WHERE NOT t."archived"
    AND t."hold_reason" IS NULL
    AND t."labels" && b."labels"
    AND NOT t."labels" && b."excluded_labels"
    AND p."archived_at" IS NULL
    AND p."deleted_at" IS NULL;
--> statement-breakpoint
CREATE VIEW "public_board_tickets" WITH (security_barrier) AS
  SELECT c."project_id", c."key", c."title", c."kind", c."status", c."created_at", c."updated_at"
  FROM "public_board_candidates" c
  JOIN "public_boards" b ON b."project_id" = c."project_id"
  WHERE b."enabled";
--> statement-breakpoint
CREATE VIEW "public_board_summaries" WITH (security_barrier) AS
  SELECT b."project_id", b."title"
  FROM "public_boards" b
  JOIN "projects" p ON p."id" = b."project_id"
  WHERE b."enabled"
    AND p."archived_at" IS NULL
    AND p."deleted_at" IS NULL;
