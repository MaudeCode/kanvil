# Workspaces and project access

A Kanvil instance hosts accounts and deployment settings. Workspaces group projects and have their own name, URL key, and members. Personal settings belong to the account. Instance administrators can administer every workspace and project; workspace administrators cannot administer the instance or other workspaces.

Workspace roles reuse the existing Read only, Can edit, and Admin roles. Workspace-visible projects inherit workspace roles. Private projects require explicit project membership, except that workspace administrators can manage all projects in their workspace. Explicit project roles override inherited roles, except for workspace administrators. A person with only project membership can see that project and its workspace identity without receiving workspace-wide access.

Workspace administrators can also invite an email address that has no access yet. An invitation fixes its role and covers either the whole workspace or selected projects, and its link works once, before it expires, for the account with that email. Kanvil account emails are set by instance administrators or verified by the OIDC provider, and people cannot change their own, so the email match identifies the recipient. Accepting checks again that the sender still administers the workspace, grants only the invited access to projects that still exist, and keeps any higher role the person already has. Invitations follow the instance's sign-in policy: they never create an account or open registration. The link is emailed when SMTP is configured and can always be copied from the dialog shown after sending; resending replaces it.

Removing workspace membership also removes that person's explicit memberships in the workspace's projects. Keep at least one workspace administrator. Project-scoped API keys remain bounded to their configured projects and cannot administer an entire workspace. Ticket and project prefixes remain unique across the instance, preserving existing links and key-based API lookups.

Existing projects are assigned to a default workspace and remain private. Existing project membership is retained; only instance administrators gain workspace administration automatically. Existing API calls that omit a workspace choose an accessible writable workspace; when none exists, project creation creates a personal workspace for the caller. New web-created projects select their workspace explicitly and offer workspace or private access.

Workspace operations use the same operation registry, authorization, transaction lock, idempotency receipts, and HTTP/MCP implementations as projects. Realtime visibility continues to derive from accessible projects, so revoked membership stops event delivery. Workspace changes invalidate project consumers through project events; an empty workspace also refreshes in browser queries on focus.

Project icons can use a bundled, searchable open-source icon collection or a normalized image upload. Uploaded bytes use the existing blob storage adapter and authenticated project access. Referenced icons must remain excluded from orphan cleanup, and backup/restore retains them with other blob objects.

## Verification

- Upgrade populated databases without widening private project access or changing ticket identifiers.
- Test workspace and private-project isolation, inherited versus explicit roles, scoped API keys, removal, last-admin guards, and idempotent writes through the shared domain.
- Exercise workspace discovery through HTTP and MCP and access revocation through realtime replay and image routes.
- Test invitation creation, resend, revocation, expiry, email mismatch, sender demotion, concurrent acceptance, and the acceptance page.
- Test workspace switching, deep links, settings navigation, member search and role changes, icon selection/upload/removal, and account administration in browser workflows.
- Review light/dark desktop and phone layouts with real content. Keep publication separate from local verification.
