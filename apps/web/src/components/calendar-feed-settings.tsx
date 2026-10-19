import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarSync, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Output } from "@kanvil/contracts";
import { api, ActorName, useOperation } from "../data.tsx";
import {
  Button,
  Confirm,
  CopyValue,
  EmptyState,
  ErrorNotice,
  FormActions,
  IconButton,
  Input,
  Loading,
  Modal,
  RelativeTime,
  SectionHeading,
} from "../ui.tsx";
import { SettingRow } from "./settings-layout.tsx";
import { TagInput } from "./tag-input.tsx";
import { TicketTags } from "./ticket-tags.tsx";
import { ProjectLabelProvider } from "./project-label-provider.tsx";
import { t } from "@kanvil/contracts/i18n";

// The browser's zone names the days a new feed's all-day events fall on.
const browserZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;
// Project calendar feeds, beside the label directory. Only administrators share them; while the
// project is archived (`canCreate` false) they can still revoke feeds.
export function CalendarFeedSettings({
  projectId,
  canAdmin,
  canCreate = canAdmin,
}: {
  projectId: string;
  canAdmin: boolean;
  canCreate?: boolean;
}) {
  const feeds = useQuery({
    ...api.query("list_calendar_feeds", { projectId }),
    enabled: canAdmin,
  });
  const create = useOperation("create_calendar_feed"),
    revoke = useOperation("revoke_calendar_feed");
  const [draft, setDraft] = useState<{ name: string; labels: string[] } | null>(null),
    [created, setCreated] = useState<Output<"create_calendar_feed"> | null>(null);
  const close = () => {
    setDraft(null);
    setCreated(null);
  };
  return (
    <section>
      <SectionHeading
        title={t("settings.calendarFeeds.title")}
        action={
          canCreate && (
            <IconButton
              label={t("settings.calendarFeeds.new")}
              variant="default"
              onClick={() => {
                create.reset();
                setDraft({ name: "", labels: [] });
              }}
            >
              <Plus />
            </IconButton>
          )
        }
      />
      {!canAdmin ? (
        <p className="text-sm text-muted-foreground">{t("settings.calendarFeeds.adminOnly")}</p>
      ) : feeds.isPending ? (
        <Loading />
      ) : feeds.data?.length ? (
        feeds.data.map((feed) => (
          <SettingRow
            key={feed.id}
            compact
            title={<span dir="auto">{feed.name}</span>}
            description={
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                {feed.labels.length ? (
                  <TicketTags
                    tags={feed.labels}
                    label={t("settings.calendarFeeds.labels")}
                    variant="secondary"
                  />
                ) : (
                  t("settings.calendarFeeds.everyLabel")
                )}
                <span>· {feed.timeZone} ·</span>
                <ActorName projectId={projectId} actorId={feed.createdBy} />
                <RelativeTime value={feed.createdAt} />
                {!feed.active && (
                  <span className="text-destructive">{t("settings.calendarFeeds.stopped")}</span>
                )}
              </span>
            }
          >
            <Confirm
              label={t("settings.calendarFeeds.revoke", { name: feed.name })}
              icon={<Trash2 />}
              danger
              description={t("settings.calendarFeeds.revokeDescription", { name: feed.name })}
              onConfirm={async () => {
                await revoke.mutateAsync({ projectId, feedId: feed.id });
                toast.success(t("settings.calendarFeeds.revoked"));
              }}
            />
          </SettingRow>
        ))
      ) : (
        !feeds.error && <EmptyState title={t("settings.calendarFeeds.empty")} icon={CalendarSync} />
      )}
      <ErrorNotice error={feeds.error} />
      <Modal
        title={created ? t("settings.calendarFeeds.created") : t("settings.calendarFeeds.new")}
        open={!!draft || !!created}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        busy={create.isPending}
      >
        {created ? (
          <div>
            <p>{t("settings.calendarFeeds.copyNow")}</p>
            <CopyValue
              label={t("settings.calendarFeeds.link")}
              value={new URL(created.path, window.location.origin).href}
            />
            <div className="flex justify-end">
              <Button variant="default" onClick={close}>
                {t("common.action.done")}
              </Button>
            </div>
          </div>
        ) : (
          draft && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void create
                  .mutateAsync({
                    projectId,
                    name: draft.name,
                    labels: draft.labels,
                    timeZone: browserZone(),
                  })
                  .then((feed) => {
                    setDraft(null);
                    setCreated(feed);
                  })
                  .catch(() => {});
              }}
            >
              <Input
                label={t("settings.calendarFeeds.name")}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                maxLength={80}
                required
                autoFocus
              />
              <ProjectLabelProvider projectId={projectId}>
                <TagInput
                  label={t("settings.calendarFeeds.onlyLabels")}
                  value={draft.labels}
                  onChange={(labels) => setDraft({ ...draft, labels })}
                />
              </ProjectLabelProvider>
              <p className="text-xs text-muted-foreground">
                {t("settings.calendarFeeds.explanation", { zone: browserZone() })}
              </p>
              <FormActions
                error={create.error}
                pending={create.isPending}
                submitLabel={t("settings.calendarFeeds.create")}
                submitDisabled={!draft.name.trim()}
                onCancel={close}
              />
            </form>
          )
        )}
      </Modal>
    </section>
  );
}
