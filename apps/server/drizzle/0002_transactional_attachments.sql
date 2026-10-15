CREATE TABLE "attachment_content" (
	"id" uuid PRIMARY KEY NOT NULL,
	"data" "bytea" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachment_content" ADD CONSTRAINT "attachment_content_id_attachments_id_fk" FOREIGN KEY ("id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;