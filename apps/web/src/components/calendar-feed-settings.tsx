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
        title="Calendar feeds"
        action={
          canCreate && (
            <IconButton
              label="New calendar feed"
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
        <p className="text-sm text-muted-foreground">
          Project administrators share and revoke calendar feeds.
        </p>
      ) : feeds.isPending ? (
        <Loading />
      ) : feeds.data?.length ? (
        feeds.data.map((feed) => (
          <SettingRow
            key={feed.id}
            compact
            title={feed.name}
            description={
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                {feed.labels.length ? (
                  <TicketTags tags={feed.labels} label="Labels" variant="secondary" />
                ) : (
                  "Every label"
                )}
                <span>· {feed.timeZone} ·</span>
                <ActorName projectId={projectId} actorId={feed.createdBy} />
                <RelativeTime value={feed.createdAt} />
                {!feed.active && (
                  <span className="text-destructive">
                    · Stopped: its creator no longer has access
                  </span>
                )}
              </span>
            }
          >
            <Confirm
              label={`Revoke ${feed.name}`}
              icon={<Trash2 />}
              danger
              description={`Calendars subscribed to ${feed.name} stop updating at once. Tickets stay unchanged.`}
              onConfirm={async () => {
                await revoke.mutateAsync({ projectId, feedId: feed.id });
                toast.success("Calendar feed revoked");
              }}
            />
          </SettingRow>
        ))
      ) : (
        !feeds.error && <EmptyState title="No calendar feeds" icon={CalendarSync} />
      )}
      <ErrorNotice error={feeds.error} />
      <Modal
        title={created ? "Calendar feed created" : "New calendar feed"}
        open={!!draft || !!created}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        busy={create.isPending}
      >
        {created ? (
          <div>
            <p>
              Copy this link into a calendar app now. It is shown only once, and anyone with it can
              read the shared tickets.
            </p>
            <CopyValue
              label="Feed link"
              value={new URL(created.path, window.location.origin).href}
            />
            <div className="flex justify-end">
              <Button variant="default" onClick={close}>
                Done
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
                label="Feed name"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                maxLength={80}
                required
                autoFocus
              />
              <ProjectLabelProvider projectId={projectId}>
                <TagInput
                  label="Only tickets with these labels"
                  value={draft.labels}
                  onChange={(labels) => setDraft({ ...draft, labels })}
                />
              </ProjectLabelProvider>
              <p className="text-xs text-muted-foreground">
                The feed lists open, unarchived tickets with a start or due date as all-day events
                in {browserZone()}. Anyone with its link sees their keys, titles, statuses,
                priorities, and dates.
              </p>
              <FormActions
                error={create.error}
                pending={create.isPending}
                submitLabel="Create feed"
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
