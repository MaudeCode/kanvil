import { Settings2 } from "lucide-react";
import type { AdminInstance } from "@kanvil/contracts/instance";
import { Badge } from "@/components/ui/badge";
import { CopyValue, ErrorNotice, IconButton, SectionHeading } from "../ui.tsx";
import { SettingRow } from "./settings-layout.tsx";
const providerNames = {
  local: "Local PostgreSQL storage",
  s3: "S3-compatible object storage",
  postgres: "Built-in PostgreSQL",
  elasticsearch: "Elasticsearch-compatible search",
  rabbitmq: "RabbitMQ",
};
export function InstanceOverview({
  data,
  section,
  onConfigure,
}: {
  data: AdminInstance;
  section: "general" | "storage" | "search" | "events";
  onConfigure: () => void;
}) {
  if (section === "general")
    return (
      <section>
        <SectionHeading
          title="Instance"
          action={
            <IconButton label="Edit instance" onClick={onConfigure}>
              <Settings2 />
            </IconButton>
          }
        />
        <SettingRow title="Name" description={data.name} />
        <SettingRow title="Description" description={data.description || "No description"} />
        <SettingRow title="Application version">
          <code>{data.deployment.version}</code>
        </SettingRow>
        <div className="pt-5">
          <CopyValue label="Public URL" value={data.deployment.url} />
        </div>
      </section>
    );
  const info =
      section === "storage" ? data.storage : section === "search" ? data.search : data.broker,
    title =
      section === "storage"
        ? "File storage"
        : section === "search"
          ? "Ticket search"
          : "Event delivery",
    configured = info.source === "deployment",
    healthy = ["ready", "builtin"].includes(info.status);
  return (
    <section>
      <SectionHeading
        title={title}
        action={
          <IconButton
            label={
              configured
                ? "View configuration"
                : `Configure ${section === "storage" ? "storage" : section === "search" ? "search" : "event delivery"}`
            }
            onClick={onConfigure}
          >
            <Settings2 />
          </IconButton>
        }
      />
      <SettingRow title="Provider" description={providerNames[info.provider]}>
        <Badge variant="secondary">{configured ? "Deployment managed" : "Instance managed"}</Badge>
      </SettingRow>
      <SettingRow
        title={
          section === "storage" ? "Transfers" : section === "search" ? "Index status" : "Connection"
        }
        description={
          section === "storage"
            ? data.storage.provider === "s3"
              ? "Files move to object storage after they are saved locally."
              : "New files are stored in PostgreSQL."
            : section === "search"
              ? info.status === "builtin"
                ? "Search runs directly in PostgreSQL."
                : "Ticket changes are indexed in the background."
              : "Notifications wake consumers; PostgreSQL keeps the replay history."
        }
      >
        <Badge variant={info.status === "unavailable" ? "destructive" : "outline"}>
          {info.status === "builtin"
            ? "Built in"
            : healthy
              ? section === "events"
                ? "Connected"
                : "Up to date"
              : info.status}
        </Badge>
      </SettingRow>
      {section === "storage" && (
        <>
          <SettingRow
            title="Pending transfers"
            description={
              data.storage.pending
                ? "These files remain available from PostgreSQL until transfer completes."
                : "No files are waiting to transfer."
            }
          >
            {data.storage.pending}
          </SettingRow>
          {data.storage.settings && (
            <>
              <SettingRow title="Bucket" description={data.storage.settings.bucket} />
              <CopyValue
                label="Storage endpoint"
                value={data.storage.settings.endpoint || "Amazon S3"}
              />
            </>
          )}
          <SettingRow
            title="Backup"
            description={
              data.locations.length
                ? "Back up PostgreSQL and every referenced object-storage bucket."
                : "File bytes are included in your PostgreSQL backup."
            }
          />
        </>
      )}
      {section === "search" && (
        <>
          <SettingRow
            title="Fallback"
            description="PostgreSQL search is available while an external index is behind or offline."
          />
          {data.search.settings && (
            <>
              <CopyValue label="Search endpoint" value={data.search.settings.url} />
              <SettingRow title="Index" description={data.search.settings.index} />
            </>
          )}
        </>
      )}
      {section === "events" && (
        <>
          <SettingRow
            title="Delivery"
            description="Durable events and replay stay in PostgreSQL. An optional broker distributes wakeups."
          />
          {data.broker.settings && (
            <>
              <CopyValue label="Broker endpoint" value={data.broker.settings.endpoint} />
              <SettingRow title="Exchange" description={data.broker.settings.exchange} />
            </>
          )}
        </>
      )}
      <ErrorNotice error={info.error ? new Error(info.error) : undefined} />
    </section>
  );
}
