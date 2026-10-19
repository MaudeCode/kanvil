import {
  difficultyLabels,
  formatCustomFieldValue,
  formatTimestamp,
  kindLabels,
  priorityLabels,
  readinessReasonText,
} from "@kanvil/contracts";
import { formatDate, t } from "@kanvil/contracts/i18n";
import { createHeaderAction } from "./navigation-actions.tsx";
import { useLayoutEffect, useState } from "react";
import { Alert, Share, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useConnection, useOperation } from "./data.tsx";
import {
  Body,
  Button,
  ErrorNotice,
  Field,
  Loading,
  Markdown,
  Screen,
  Section,
  Sheet,
  Status,
  styles,
  usePalette,
} from "./ui.tsx";
import { Attachments, Evidence, Activity } from "./ticket-resources.tsx";
import { Discussion, Relations } from "./collaboration.tsx";
import type { ScreenProps } from "./navigation.ts";

// Start and due dates are whole days; editing them stays on the web for now.
const day = (value: string) => formatDate(value, { dateStyle: "medium" });
function scheduleText(ticket: { startAt: string | null; dueAt: string | null }) {
  return [
    ticket.startAt && t("native.ticket.starts", { date: day(ticket.startAt) }),
    ticket.dueAt && t("native.ticket.due", { date: day(ticket.dueAt) }),
  ]
    .filter(Boolean)
    .join(" · ");
}
export function TicketDetail(props: ScreenProps<"Ticket">) {
  return (
    <TicketScreen
      key={`${props.route.params.projectId}:${props.route.params.ticketId}`}
      {...props}
    />
  );
}
function TicketScreen({ route, navigation }: ScreenProps<"Ticket">) {
  const { api, baseUrl } = useConnection(),
    { projectId, ticketId } = route.params,
    color = usePalette();
  const result = useQuery(api.query("get_ticket", { projectId, ticketId }));
  const fields = useQuery(api.query("list_custom_fields", { projectId }));
  const update = useOperation("update_ticket"),
    subscribe = useOperation("set_subscription"),
    release = useOperation("release_claim"),
    recover = useOperation("recover_claim");
  const [recovering, setRecovering] = useState(false),
    [reason, setReason] = useState("");
  useLayoutEffect(() => {
    navigation.setOptions({
      title: result.data?.ticket.key ?? t("native.screen.ticket"),
      headerRight: createHeaderAction(t("common.action.edit"), () =>
        navigation.navigate("Edit", { projectId, ticketId }),
      ),
    });
  }, [navigation, projectId, ticketId, result.data?.ticket.key]);
  if (result.isPending) return <Loading />;
  if (!result.data) return <ErrorNotice error={result.error} />;
  const { ticket, readiness, claim, canReleaseClaim, subscribed } = result.data;
  // Custom field values read on the phone; editing them stays on the web for now.
  const valued = (fields.data ?? []).filter((field) => ticket.customFields[field.id] !== undefined);
  return (
    <Screen>
      <View style={styles.actions}>
        <Status ticket={ticket} />
        <Body muted small>
          {t("native.ticket.priority", { priority: priorityLabels[ticket.priority] })}
        </Body>
        <Body muted small>
          {kindLabels[ticket.kind]}
        </Body>
        <Body muted small>
          {ticket.difficulty
            ? difficultyLabels[ticket.difficulty]
            : t("native.ticket.noDifficulty")}
        </Body>
        <Body muted small>
          {t("native.ticket.version", { version: ticket.version })}
        </Body>
        {(ticket.startAt || ticket.dueAt) && (
          <Body muted small>
            {scheduleText(ticket)}
          </Body>
        )}
      </View>
      <Text
        accessibilityRole="header"
        selectable
        style={{
          color: color.foreground,
          fontSize: 29,
          fontWeight: "600",
          lineHeight: 37,
          letterSpacing: -0.6,
        }}
      >
        {ticket.title}
      </Text>
      {ticket.archived && <Body muted>{t("native.detail.archived")}</Body>}
      {ticket.labels.length > 0 && (
        <Body muted small>
          {ticket.labels.map((label) => `#${label}`).join(" ")}
        </Body>
      )}
      <View style={styles.actions}>
        <Button
          title={subscribed ? t("native.detail.unsubscribe") : t("native.detail.subscribe")}
          disabled={subscribe.isPending}
          onPress={() => subscribe.mutate({ projectId, ticketId: ticket.id, enabled: !subscribed })}
        />
        <Button
          title={t("native.detail.share")}
          onPress={() => {
            void Share.share({
              message: `${ticket.key}: ${ticket.title}\n${baseUrl}/projects/${ticket.projectId}/tickets/${ticket.id}\nkanvil://projects/${ticket.projectId}/tickets/${ticket.id}`,
            });
          }}
        />
      </View>
      <ErrorNotice error={result.error ?? subscribe.error ?? update.error ?? release.error} />
      <Section title={t("native.detail.description")}>
        <Markdown>{ticket.description || t("native.detail.noDescription")}</Markdown>
      </Section>
      <Section title={t("native.detail.acceptanceCriteria")}>
        <Markdown>{ticket.acceptanceCriteria || t("native.detail.noAcceptanceCriteria")}</Markdown>
      </Section>
      {valued.length > 0 && (
        <Section title={t("native.detail.fields")}>
          {valued.map((field) => (
            <Body key={field.id} small>
              {t("native.labelValue", {
                label: field.name,
                value: formatCustomFieldValue(field, ticket.customFields[field.id]),
              })}
            </Body>
          ))}
        </Section>
      )}
      <Section title={t("native.readiness.title")}>
        <Body>
          {readiness.ready ? t("native.readiness.ready") : t("native.readiness.notReady")}
        </Body>
        {readiness.reasons.map((item, index) => (
          <Body key={`${item.code}:${index}`} muted>
            • {readinessReasonText(item, claim?.workerId)}
          </Body>
        ))}
        {ticket.holdReason && (
          <Body>{t("native.readiness.hold", { reason: ticket.holdReason })}</Body>
        )}
        {claim && (
          <>
            <Body>
              {t("native.readiness.claimed", {
                worker: claim.workerId,
                time: formatTimestamp(claim.expiresAt),
              })}
            </Body>
            {canReleaseClaim && (
              <Button
                title={t("native.readiness.release.action")}
                disabled={release.isPending}
                onPress={() =>
                  Alert.alert(
                    t("native.readiness.release.title"),
                    t("native.readiness.release.message"),
                    [
                      { text: t("common.action.cancel"), style: "cancel" },
                      {
                        text: t("native.readiness.release.confirm"),
                        onPress: () =>
                          release.mutate({ projectId, ticketId: ticket.id, claimId: claim.id }),
                      },
                    ],
                  )
                }
              />
            )}
            <Button
              title={t("native.readiness.recover.action")}
              onPress={() => setRecovering(true)}
            />
            <Sheet
              title={t("native.readiness.recover.action")}
              open={recovering}
              onClose={() => setRecovering(false)}
            >
              <Body>{t("native.readiness.recover.explanation")}</Body>
              <Field
                label={t("native.readiness.recover.reason")}
                value={reason}
                onChangeText={setReason}
                multiline
                maxLength={2000}
              />
              <ErrorNotice error={recover.error} />
              <Button
                title={t("native.readiness.recover.confirm")}
                disabled={reason.trim().length < 10 || recover.isPending}
                onPress={() => {
                  void recover
                    .mutateAsync({
                      projectId,
                      ticketId: ticket.id,
                      claimId: claim.id,
                      reason,
                      confirmedStopped: true,
                    })
                    .then(() => setRecovering(false))
                    .catch(() => {});
                }}
              />
            </Sheet>
          </>
        )}
      </Section>
      <Relations ticket={ticket} navigation={navigation} />
      <Discussion ticket={ticket} />
      <Attachments ticket={ticket} />
      <Evidence ticket={ticket} />
      <Activity ticket={ticket} />
      <Button
        title={
          ticket.archived ? t("native.detail.unarchive.action") : t("native.detail.archive.action")
        }
        onPress={() =>
          Alert.alert(
            ticket.archived ? t("native.detail.unarchive.title") : t("native.detail.archive.title"),
            ticket.archived
              ? t("native.detail.unarchive.message")
              : t("native.detail.archive.message"),
            [
              { text: t("common.action.cancel"), style: "cancel" },
              {
                text: t("common.action.confirm"),
                onPress: () =>
                  update.mutate({
                    projectId,
                    ticketId: ticket.id,
                    expectedVersion: ticket.version,
                    changes: { archived: !ticket.archived },
                  }),
              },
            ],
          )
        }
      />
    </Screen>
  );
}
