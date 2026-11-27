CREATE TABLE "download_urls" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"attachment_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"credential" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "download_urls" ADD CONSTRAINT "download_urls_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_urls" ADD CONSTRAINT "download_urls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_urls" ADD CONSTRAINT "download_urls_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "download_urls_expires" ON "download_urls" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "download_urls_attachment" ON "download_urls" USING btree ("attachment_id");