CREATE TABLE "delivery_checkpoints" (
	"destination" text PRIMARY KEY NOT NULL,
	"cursor" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "broker_config" text;