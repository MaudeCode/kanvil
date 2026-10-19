-- Email codes are keyed by address. When an account's address changes or the account goes, its
-- outstanding codes go with it, so an address given to another account never carries a code over.
CREATE FUNCTION "forget_email_codes"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND OLD."email" IS NOT DISTINCT FROM NEW."email" THEN
		RETURN NULL;
	END IF;
	DELETE FROM "verification"
	WHERE "identifier" IN ('sign-in-otp-' || lower(OLD."email"), 'forget-password-otp-' || lower(OLD."email"));
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "user_email_codes" AFTER UPDATE OF "email" OR DELETE ON "user"
	FOR EACH ROW EXECUTE FUNCTION "forget_email_codes"();
