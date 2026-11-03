ALTER TABLE "projects" ADD COLUMN "repositories" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "mutation_receipts" ADD COLUMN "project_id" uuid;