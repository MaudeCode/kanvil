CREATE TABLE "project_prefixes" (
	"prefix" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_aliases" (
	"key" text PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_prefixes" ADD CONSTRAINT "project_prefixes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_aliases" ADD CONSTRAINT "ticket_aliases_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_prefix_project" ON "project_prefixes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ticket_alias_ticket" ON "ticket_aliases" USING btree ("ticket_id");--> statement-breakpoint
-- Every existing prefix is reserved for its project.
INSERT INTO "project_prefixes" ("prefix", "project_id") SELECT "key", "id" FROM "projects";
