import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MailPlus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { roleLabels, roles, type Invitation } from "@kanvil/contracts";
import { z } from "zod";
import { api, useAllProjects, useOperation } from "../data.tsx";
import { formText } from "../forms.ts";
import {
  Button,
  Check,
  Confirm,
  CopyButton,
  EmptyState,
  ErrorNotice,
  FormActions,
  IconButton,
  Input,
  Loading,
  Modal,
  ModalActions,
  RelativeTime,
  SectionHeading,
  Select,
  SelectItem,
} from "../ui.tsx";
import { Item, ItemActions, ItemContent, ItemGroup } from "@/components/ui/item";
import { Badge } from "@/components/ui/badge";

const lifetimes = [1, 7, 14, 30] as const;
type Sent = { invitation: Invitation; url: string; emailed: boolean };
// Pending invitations sit under the member list with the same row layout. They are a separate
// list from MemberDirectory because their actions (resend, revoke) act on an address, not an account.
export function InvitationList({ workspaceId }: { workspaceId: string }) {
  const invitations = useQuery(api.query("list_invitations", { workspaceId })),
    projects = useAllProjects(),
    create = useOperation("create_invitation"),
    resend = useOperation("resend_invitation"),
    revoke = useOperation("revoke_invitation");
  const [inviting, setInviting] = useState(false),
    [scope, setScope] = useState<"workspace" | "projects">("workspace"),
    [selected, setSelected] = useState<string[]>([]),
    [sent, setSent] = useState<Sent | null>(null);
  const choices = projects.data?.filter((project) => project.workspaceId === workspaceId) ?? [];
  return (
    <section className="pt-8">
      <SectionHeading
        title="Invitations"
        action={
          <IconButton
            label="Invite by email"
            variant="default"
            onClick={() => {
              create.reset();
              setScope("workspace");
              setSelected([]);
              setInviting(true);
            }}
          >
            <MailPlus />
          </IconButton>
        }
      />
      <ErrorNotice error={invitations.error ?? resend.error} />
      {invitations.isPending ? (
        <Loading />
      ) : invitations.data?.length ? (
        <ItemGroup className="gap-0">
          {invitations.data.map((invitation) => (
            <Item
              key={invitation.id}
              className="invitation-row rounded-none border-x-0 border-t-0 border-b-border px-0 py-3"
            >
              <ItemContent className="min-w-0 gap-1">
                <span className="text-sm font-medium wrap-anywhere">{invitation.email}</span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    {roleLabels[invitation.role]} ·{" "}
                    {invitation.projects
                      ? invitation.projects.map((project) => project.name).join(", ") ||
                        "Removed projects"
                      : "Whole workspace"}
                  </span>
                  {invitation.status === "expired" ? (
                    <Badge variant="outline" className="font-normal text-(--warning)">
                      Expired
                    </Badge>
                  ) : (
                    <span>
                      Expires <RelativeTime value={invitation.expiresAt} />
                    </span>
                  )}
                </span>
              </ItemContent>
              <ItemActions>
                <IconButton
                  label={`Resend invitation to ${invitation.email}`}
                  disabled={resend.isPending}
                  onClick={() => {
                    void resend
                      .mutateAsync({
                        workspaceId,
                        invitationId: invitation.id,
                        expectedVersion: invitation.version,
                      })
                      .then(setSent)
                      .catch(() => {});
                  }}
                >
                  <Send />
                </IconButton>
                <Confirm
                  label="Revoke invitation"
                  icon={<Trash2 />}
                  danger
                  description={`The link sent to ${invitation.email} will stop working.`}
                  onConfirm={() =>
                    revoke
                      .mutateAsync({
                        workspaceId,
                        invitationId: invitation.id,
                        expectedVersion: invitation.version,
                      })
                      .then(() => toast.success("Invitation revoked"))
                  }
                />
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      ) : (
        <EmptyState title="No pending invitations" className="py-8" />
      )}
      <Modal
        title="Invite by email"
        open={inviting}
        onOpenChange={setInviting}
        busy={create.isPending}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            void create
              .mutateAsync({
                workspaceId,
                email: formText(values, "email"),
                role: z.enum(roles).parse(values.get("role")),
                projectIds: scope === "projects" ? selected : null,
                expiresInDays: Number(values.get("expires")),
              })
              .then((result) => {
                setInviting(false);
                setSent(result);
              })
              .catch(() => {});
          }}
        >
          <Input label="Email" name="email" type="email" required autoFocus />
          <Select label="Role" name="role" defaultValue="writer">
            {roles.map((role) => (
              <SelectItem key={role} value={role}>
                {roleLabels[role]}
              </SelectItem>
            ))}
          </Select>
          <Select
            label="Access"
            value={scope}
            onValueChange={(value) => setScope(value === "projects" ? "projects" : "workspace")}
          >
            <SelectItem value="workspace">Whole workspace</SelectItem>
            <SelectItem value="projects">Selected projects</SelectItem>
          </Select>
          {scope === "projects" && (
            <fieldset className="mb-4">
              <legend className="mb-1 text-sm font-medium">Projects</legend>
              {choices.length ? (
                choices.map((project) => (
                  <Check
                    key={project.id}
                    label={project.name}
                    checked={selected.includes(project.id)}
                    onCheckedChange={(checked) =>
                      setSelected((current) =>
                        checked
                          ? [...current, project.id]
                          : current.filter((id) => id !== project.id),
                      )
                    }
                  />
                ))
              ) : (
                <p className="m-0 text-sm text-muted-foreground">This workspace has no projects.</p>
              )}
            </fieldset>
          )}
          <Select label="Link expires" name="expires" defaultValue="7">
            {lifetimes.map((days) => (
              <SelectItem key={days} value={String(days)}>
                {days === 1 ? "In 1 day" : `In ${days} days`}
              </SelectItem>
            ))}
          </Select>
          <FormActions
            error={create.error}
            pending={create.isPending}
            submitLabel="Invite"
            submitDisabled={scope === "projects" && !selected.length}
            onCancel={() => setInviting(false)}
          />
        </form>
      </Modal>
      <Modal
        title="Invitation link"
        description={
          sent?.emailed
            ? `Emailed to ${sent.invitation.email}. The link works once, for that address.`
            : `Email is not configured on this instance. Send this link to ${sent?.invitation.email ?? "the recipient"}; it works once, for that address.`
        }
        open={!!sent}
        onOpenChange={(open) => {
          if (!open) setSent(null);
        }}
      >
        {sent && (
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Input
                label="Invitation link"
                labelHidden
                value={sent.url}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
            <CopyButton label="Copy invitation link" value={sent.url} />
          </div>
        )}
        <ModalActions>
          <Button onClick={() => setSent(null)}>Done</Button>
        </ModalActions>
      </Modal>
    </section>
  );
}
