CREATE TABLE "event_audiences" (
	"event_id" bigint NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "event_audiences_event_id_user_id_pk" PRIMARY KEY("event_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_audiences" ADD CONSTRAINT "event_audiences_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_audiences" ADD CONSTRAINT "event_audiences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_audience_user" ON "event_audiences" USING btree ("user_id","event_id");