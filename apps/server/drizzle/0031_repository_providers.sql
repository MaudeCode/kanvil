ALTER TABLE "repository_connections" DROP CONSTRAINT "repository_connection_name";--> statement-breakpoint
ALTER TABLE "repository_connections" ADD COLUMN "base_url" text;--> statement-breakpoint
ALTER TABLE "repository_connections" ADD CONSTRAINT "repository_connection_name" UNIQUE NULLS NOT DISTINCT("project_id","provider","base_url","repository");