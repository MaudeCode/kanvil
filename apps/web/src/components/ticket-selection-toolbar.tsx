import { useState } from "react";
import { Archive, ArchiveRestore, Ellipsis, ListTodo, Rows3, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Trans } from "react-i18next";
import { stateLabels, type Ticket } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { useOperation, useProjectAccess } from "../data.tsx";
import { IconButton, Confirm, reportError } from "../ui.tsx";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CustomFieldProperty,
  TagsProperty,
  TicketProperty,
  useCustomFields,
  propertyChange,
  propertyIcons,
  propertyLabels,
  propertyOf,
  propertyOrder,
  type TicketChange,
} from "./ticket-property.tsx";
import { DatePicker, endOfDay } from "./date-picker.tsx";

// The first row's value only when every selected ticket shares it, so a mixed selection never
// shows one row's value as everyone's.
function shared<T>(selected: Ticket[], read: (ticket: Ticket) => T) {
  const [first, ...rest] = selected.map(read),
    key = JSON.stringify(first);
  return { value: first!, mixed: rest.some((value) => JSON.stringify(value) !== key) };
}

// Narrow screens keep only the icons; each control's accessible name still says what it edits.
const wideText = "max-sm:hidden";
// The server's per-request limit for bulk edits and deletion.
const batchSize = 100;

// Floats above the list so selecting never shifts rows; every action applies immediately.
export function TicketSelectionToolbar({
  selected,
  total,
  collection,
  onClear,
}: {
  selected: Ticket[];
  // How many tickets the list shows, so a partial selection reads as such.
  total: number;
  // Names where the selection comes from in confirmations, such as "Kanvil (2 Done)".
  collection: string;
  onClear: () => void;
}) {
  const bulk = useOperation("bulk_update_tickets"),
    remove = useOperation("bulk_delete_tickets"),
    cache = useQueryClient(),
    [busy, setBusy] = useState(false),
    [confirming, setConfirming] = useState<"archive" | "delete" | null>(null);
  const projectId = selected[0]?.projectId;
  const access = useProjectAccess(projectId ?? "", !!projectId);
  const fields = useCustomFields(projectId);
  if (!projectId) return null;
  const tickets = selected.map((ticket) => ({
    ticketId: ticket.id,
    expectedVersion: ticket.version,
  }));
  async function run(task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      // The server rolled the failed request back; reload so the selection carries current
      // versions and a retry cannot resend stale ones.
      await cache.invalidateQueries({ queryKey: ["kanvil"] });
      throw error;
    } finally {
      setBusy(false);
    }
  }
  // Larger selections go in consecutive batches; each batch is atomic on the server.
  const write = (changes: TicketChange) =>
    run(async () => {
      for (let done = 0; done < tickets.length; done += batchSize)
        await bulk
          .mutateAsync({ projectId, tickets: tickets.slice(done, done + batchSize), changes })
          .catch((error: unknown) => {
            if (done)
              toast.warning(t("ticket.selection.partlyApplied", { done, count: tickets.length }));
            throw error;
          });
    });
  function apply(changes: TicketChange, label: string) {
    if (busy) return;
    void write(changes)
      .then(() => {
        toast.success(t("ticket.selection.applied", { label, count: selected.length }));
        onClear();
      })
      .catch(reportError);
  }
  // Archived backlog tickets would stay out of active work, so only open planned ones promote.
  const planned = selected.every((ticket) => ticket.status === "backlog" && !ticket.archived),
    archived = selected.every((ticket) => ticket.archived);
  const labels = shared(selected, (ticket) => ticket.labels.toSorted()),
    due = shared(selected, (ticket) => ticket.dueAt);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-40 w-[100cqw] max-w-none md:right-10">
      <div
        className="pointer-events-auto mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-1 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-4 duration-200"
        role="region"
        aria-label={t("ticket.selection.region")}
      >
        <div className="flex items-center gap-1 pr-1">
          <IconButton
            label={t("ticket.selection.clear")}
            size="icon-sm"
            disabled={busy}
            onClick={onClear}
          >
            <X />
          </IconButton>
          <span className="text-xs font-medium whitespace-nowrap tabular-nums" role="status">
            {selected.length === total ? (
              t("ticket.selection.selected", { count: selected.length })
            ) : (
              <Trans
                i18nKey="ticket.selection.selectedOf"
                count={selected.length}
                values={{ total }}
                components={{ wide: <span className={wideText} /> }}
              />
            )}
          </span>
          {busy && <Spinner className="size-3.5" />}
        </div>
        <Separator orientation="vertical" className="hidden h-5! sm:block" />
        {propertyOrder.map((name) => {
          const Icon = propertyIcons[name],
            { value, mixed } = shared(selected, (ticket) => propertyOf(ticket, name));
          return (
            <TicketProperty
              key={name}
              property={name}
              projectId={projectId}
              value={value}
              mixed={mixed}
              disabled={busy}
              align="end"
              onChange={(next) => apply(propertyChange(name, next), propertyLabels[name])}
            >
              <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span className={wideText}>{propertyLabels[name]}</span>
            </TicketProperty>
          );
        })}
        <TagsProperty
          replace
          value={labels.value}
          mixed={labels.mixed}
          disabled={busy}
          textClassName={wideText}
          onChange={(next) => apply({ labels: next }, t("ticket.tags.labels"))}
        />
        <DatePicker
          variant="pill"
          label={t("ticket.date.due")}
          placeholder={due.mixed ? t("ticket.selection.mixedDue") : t("ticket.date.due")}
          value={!due.mixed && due.value ? new Date(due.value) : null}
          mixed={due.mixed}
          disabled={busy}
          textClassName={wideText}
          onChange={(date) => apply({ dueAt: date ? endOfDay(date) : null }, t("ticket.date.due"))}
        />
        {!!fields.data?.length && (
          <Popover>
            <PopoverTrigger
              disabled={busy}
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  aria-label={t("ticket.selection.fields")}
                />
              }
            >
              <Rows3 className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span className={wideText}>{t("ticket.selection.fields")}</span>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] gap-1 p-2">
              {fields.data.map((field) => {
                const { value, mixed } = shared(
                  selected,
                  (ticket) => ticket.customFields[field.id] ?? null,
                );
                return (
                  <CustomFieldProperty
                    key={field.id}
                    variant="row"
                    field={field}
                    value={value}
                    mixed={mixed}
                    disabled={busy}
                    align="end"
                    onChange={(next) => apply({ customFields: { [field.id]: next } }, field.name)}
                  />
                );
              })}
            </PopoverContent>
          </Popover>
        )}
        <Separator orientation="vertical" className="hidden h-5! sm:block" />
        {/* One slot for collection actions keeps the dock at two rows on a phone. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<IconButton label={t("ticket.selection.more")} disabled={busy} />}
          >
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {planned && (
              <DropdownMenuItem onClick={() => apply({ status: "todo" }, stateLabels.todo)}>
                <ListTodo />
                {t("ticket.selection.moveTo", { status: stateLabels.todo })}
              </DropdownMenuItem>
            )}
            {archived ? (
              <DropdownMenuItem
                onClick={() => apply({ archived: false }, t("ticket.selection.restoreChange"))}
              >
                <ArchiveRestore />
                {t("ticket.selection.restore")}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => setConfirming("archive")}>
                <Archive />
                {t("ticket.selection.archive")}
              </DropdownMenuItem>
            )}
            {access.canDelete && (
              <DropdownMenuItem
                variant="destructive"
                disabled={selected.length > batchSize}
                onClick={() => setConfirming("delete")}
              >
                <Trash2 />
                {selected.length > batchSize
                  ? t("ticket.selection.deleteLimit", { limit: batchSize })
                  : t("ticket.selection.delete")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Confirm
          label={t("ticket.selection.archive")}
          trigger={false}
          open={confirming === "archive"}
          onOpenChange={(open) => setConfirming(open ? "archive" : null)}
          description={t("ticket.selection.archiveConfirm", {
            count: selected.length,
            collection,
          })}
          onConfirm={async () => {
            await write({ archived: true });
            onClear();
          }}
        />
        <Confirm
          danger
          label={t("ticket.selection.delete")}
          trigger={false}
          open={confirming === "delete"}
          onOpenChange={(open) => setConfirming(open ? "delete" : null)}
          description={t("ticket.selection.deleteConfirm", {
            count: selected.length,
            collection,
          })}
          onConfirm={() =>
            run(async () => {
              await remove.mutateAsync({ projectId, tickets });
              toast.success(t("ticket.selection.deleted", { count: selected.length }));
              onClear();
            })
          }
        />
      </div>
    </div>
  );
}
