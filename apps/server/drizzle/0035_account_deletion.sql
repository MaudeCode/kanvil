ALTER TABLE "user" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
-- A deleted account is a tombstone that keeps shared history attributed. It can never carry a
-- name, address, photo, or role again, and stays disabled, so no later update brings it back.
ALTER TABLE "user" ADD CONSTRAINT "user_deleted_tombstone" CHECK (
	"deleted_at" IS NULL OR (
		"name" = 'Deleted account' AND "email" = 'deleted+' || "id" || '@kanvil.invalid'
		AND "image" IS NULL AND "role" IS NULL AND "banned" AND NOT "email_verified"
	)
);
