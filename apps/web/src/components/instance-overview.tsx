import { Pencil, Settings2 } from "lucide-react";
import type { AdminInstance } from "@kanvil/contracts/instance";
import { Badge } from "@/components/ui/badge";
import { CopyValue, ErrorNotice, IconButton, SectionHeading } from "../ui.tsx";
import { SettingRow } from "./settings-layout.tsx";
import { t } from "@kanvil/contracts/i18n";
const providerNames = {
  get local() {
    return t("admin.instance.provider.local");
  },
  get s3() {
    return t("admin.instance.provider.s3");
  },
  get postgres() {
    return t("admin.instance.provider.postgres");
  },
  get elasticsearch() {
    return t("admin.instance.provider.elasticsearch");
  },
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
          title={t("admin.instance.heading")}
          action={
            <IconButton label={t("admin.instance.edit")} onClick={onConfigure}>
              <Pencil />
            </IconButton>
          }
        />
        <SettingRow title={t("admin.instance.name")} description={data.name} />
        <SettingRow
          title={t("admin.instance.description")}
          description={data.description || t("admin.instance.noDescription")}
        />
        <SettingRow title={t("admin.instance.version")}>
          <code>{data.deployment.version}</code>
        </SettingRow>
        <SettingRow title={t("admin.instance.publicUrl")}>
          <CopyValue label={t("admin.instance.publicUrl")} value={data.deployment.url} inline />
        </SettingRow>
      </section>
    );
  const info =
      section === "storage" ? data.storage : section === "search" ? data.search : data.broker,
    title =
      section === "storage"
        ? t("admin.instance.section.storage")
        : section === "search"
          ? t("admin.instance.section.search")
          : t("admin.instance.section.events"),
    configured = info.source === "deployment";
  return (
    <section>
      <SectionHeading
        title={title}
        action={
          <IconButton
            label={
              configured
                ? t("admin.instance.viewConfiguration")
                : t(`admin.instance.configure.${section}`)
            }
            onClick={onConfigure}
          >
            <Settings2 />
          </IconButton>
        }
      />
      <SettingRow
        title={t("admin.instance.providerTitle")}
        description={providerNames[info.provider]}
      >
        <Badge variant="secondary">
          {configured ? t("admin.instance.deploymentManaged") : t("admin.instance.instanceManaged")}
        </Badge>
      </SettingRow>
      <SettingRow
        title={
          section === "storage"
            ? t("admin.instance.transfers")
            : section === "search"
              ? t("admin.instance.indexStatus")
              : t("admin.instance.connection")
        }
        description={
          section === "storage"
            ? data.storage.provider === "s3"
              ? t("admin.instance.transfersS3")
              : t("admin.instance.transfersLocal")
            : section === "search"
              ? info.status === "builtin"
                ? t("admin.instance.searchBuiltIn")
                : t("admin.instance.searchIndexed")
              : t("admin.instance.eventsConnection")
        }
      >
        <Badge variant={info.status === "unavailable" ? "destructive" : "outline"}>
          {info.status === "builtin"
            ? t("admin.instance.builtIn")
            : info.status === "ready"
              ? section === "events"
                ? t("admin.instance.connected")
                : t("admin.instance.upToDate")
              : t(`admin.instance.status.${info.status}`)}
        </Badge>
      </SettingRow>
      {section === "storage" && (
        <>
          <SettingRow
            title={t("admin.instance.pendingTransfers")}
            description={
              data.storage.pending
                ? t("admin.instance.pendingRemain")
                : t("admin.instance.noPending")
            }
          >
            {data.storage.pending}
          </SettingRow>
          {data.storage.settings && (
            <>
              <SettingRow
                title={t("admin.instance.bucket")}
                description={data.storage.settings.bucket}
              />
              <CopyValue
                label={t("admin.instance.storageEndpoint")}
                value={data.storage.settings.endpoint || "Amazon S3"}
              />
            </>
          )}
          <SettingRow
            title={t("admin.instance.backup")}
            description={
              data.locations.length
                ? t("admin.instance.backupBuckets")
                : t("admin.instance.backupDatabase")
            }
          />
        </>
      )}
      {section === "search" && (
        <>
          <SettingRow
            title={t("admin.instance.fallback")}
            description={t("admin.instance.fallbackDescription")}
          />
          {data.search.settings && (
            <>
              <CopyValue
                label={t("admin.instance.searchEndpoint")}
                value={data.search.settings.url}
              />
              <SettingRow
                title={t("admin.instance.index")}
                description={data.search.settings.index}
              />
            </>
          )}
        </>
      )}
      {section === "events" && (
        <>
          <SettingRow
            title={t("admin.instance.delivery")}
            description={t("admin.instance.deliveryDescription")}
          />
          {data.broker.settings && (
            <>
              <CopyValue
                label={t("admin.instance.brokerEndpoint")}
                value={data.broker.settings.endpoint}
              />
              <SettingRow
                title={t("admin.instance.exchange")}
                description={data.broker.settings.exchange}
              />
            </>
          )}
        </>
      )}
      <ErrorNotice error={info.error ? new Error(info.error) : undefined} />
    </section>
  );
}
