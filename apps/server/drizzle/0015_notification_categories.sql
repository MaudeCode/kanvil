ALTER TABLE "events" ALTER COLUMN "actor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "categories" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "reminder_amount" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "reminder_unit" text DEFAULT 'days' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "category" text DEFAULT 'update' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "reminder_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notification_event_user" UNIQUE("event_id","user_id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notification_reminder" UNIQUE("user_id","reminder_key");--> statement-breakpoint
UPDATE "notifications" SET "category" = CASE
  WHEN "events"."type" LIKE 'comment.%' THEN 'comment'
  WHEN "events"."type" = 'ticket.updated' AND "events"."data"->'changedFields' ? 'assigneeId' THEN 'assignment'
  WHEN "events"."type" = 'ticket.updated' AND "events"."data"->'changedFields' ? 'status' THEN 'status'
  ELSE 'update' END
FROM "events" WHERE "events"."id" = "notifications"."event_id";
