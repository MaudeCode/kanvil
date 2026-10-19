-- Email codes are keyed by address. When an account's address changes, the account is disabled,
-- or it goes, its outstanding codes go with it: an address given to another account never carries
-- a code over, and a disabled account cannot set a password that works once it is enabled again.
CREATE FUNCTION "forget_email_codes"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND OLD."email" IS NOT DISTINCT FROM NEW."email"
		AND NOT (coalesce(NEW."banned", false) AND NOT coalesce(OLD."banned", false)) THEN
		RETURN NULL;
	END IF;
	DELETE FROM "verification"
	WHERE "identifier" IN ('sign-in-otp-' || lower(OLD."email"), 'forget-password-otp-' || lower(OLD."email"));
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "user_email_codes" AFTER UPDATE OF "email", "banned" OR DELETE ON "user"
	FOR EACH ROW EXECUTE FUNCTION "forget_email_codes"();
