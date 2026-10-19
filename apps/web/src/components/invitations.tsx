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
import { t } from "@kanvil/contracts/i18n";
import { Trans } from "react-i18next";

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
        title={t("settings.invitations.title")}
        action={
          <IconButton
            label={t("settings.invitations.invite")}
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
                        t("settings.invitations.removedProjects")
                      : t("settings.invitations.wholeWorkspace")}
                  </span>
                  {invitation.status === "expired" ? (
                    <Badge variant="outline" className="font-normal text-(--warning)">
                      {t("settings.invitations.expired")}
                    </Badge>
                  ) : (
                    <span>
                      <Trans
                        i18nKey="settings.invitations.expires"
                        components={{ time: <RelativeTime value={invitation.expiresAt} /> }}
                      />
                    </span>
                  )}
                </span>
              </ItemContent>
              <ItemActions>
                <IconButton
                  label={t("settings.invitations.resend", { email: invitation.email })}
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
                  label={t("settings.invitations.revoke")}
                  icon={<Trash2 />}
                  danger
                  description={t("settings.invitations.revokeDescription", {
                    email: invitation.email,
                  })}
                  onConfirm={() =>
                    revoke
                      .mutateAsync({
                        workspaceId,
                        invitationId: invitation.id,
                        expectedVersion: invitation.version,
                      })
                      .then(() => toast.success(t("settings.invitations.revoked")))
                  }
                />
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      ) : (
        <EmptyState title={t("settings.invitations.empty")} className="py-8" />
      )}
      <Modal
        title={t("settings.invitations.invite")}
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
          <Input
            label={t("settings.invitations.email")}
            name="email"
            type="email"
            required
            autoFocus
          />
          <Select label={t("settings.invitations.role")} name="role" defaultValue="writer">
            {roles.map((role) => (
              <SelectItem key={role} value={role}>
                {roleLabels[role]}
              </SelectItem>
            ))}
          </Select>
          <Select
            label={t("settings.invitations.access")}
            value={scope}
            onValueChange={(value) => setScope(value === "projects" ? "projects" : "workspace")}
          >
            <SelectItem value="workspace">{t("settings.invitations.wholeWorkspace")}</SelectItem>
            <SelectItem value="projects">{t("settings.invitations.selectedProjects")}</SelectItem>
          </Select>
          {scope === "projects" && (
            <fieldset className="mb-4">
              <legend className="mb-1 text-sm font-medium">
                {t("settings.invitations.projects")}
              </legend>
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
                <p className="m-0 text-sm text-muted-foreground">
                  {t("settings.invitations.noProjects")}
                </p>
              )}
            </fieldset>
          )}
          <Select label={t("settings.invitations.linkExpires")} name="expires" defaultValue="7">
            {lifetimes.map((days) => (
              <SelectItem key={days} value={String(days)}>
                {t("settings.invitations.inDays", { count: days })}
              </SelectItem>
            ))}
          </Select>
          <FormActions
            error={create.error}
            pending={create.isPending}
            submitLabel={t("settings.invitations.submit")}
            submitDisabled={scope === "projects" && !selected.length}
            onCancel={() => setInviting(false)}
          />
        </form>
      </Modal>
      <Modal
        title={t("settings.invitations.link")}
        description={
          sent?.emailed
            ? t("settings.invitations.emailed", { email: sent.invitation.email })
            : sent
              ? t("settings.invitations.notEmailed", { email: sent.invitation.email })
              : t("settings.invitations.notEmailedUnknown")
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
                label={t("settings.invitations.link")}
                labelHidden
                value={sent.url}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
            <CopyButton label={t("settings.invitations.copyLink")} value={sent.url} />
          </div>
        )}
        <ModalActions>
          <Button onClick={() => setSent(null)}>{t("common.action.done")}</Button>
        </ModalActions>
      </Modal>
    </section>
  );
}
