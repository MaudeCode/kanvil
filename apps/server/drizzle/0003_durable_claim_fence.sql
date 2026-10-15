ALTER TABLE "tickets" ADD COLUMN "claim_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "tickets" SET "claim_required" = true
WHERE "id" IN (SELECT "ticket_id" FROM "claims")
   OR "id" IN (SELECT "ticket_id" FROM "events" WHERE "type" IN ('ticket.claimed', 'claim.recovered', 'claim.released'));
