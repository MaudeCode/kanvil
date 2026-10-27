import { ticketScheduleText } from "@kanvil/contracts/schedule";
import {
  formatCustomFieldValue,
  formatTimestamp,
  readinessReasonText,
  ApiError,
} from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { ticketHeaderItems } from "./navigation-actions.tsx";
import { useEffect, useLayoutEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useConnection, useOperation, useProjectAccess } from "./data.tsx";
import {
  nativeHeaderOptions,
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
  PropertyValue,
  TicketTags,
} from "./ui.tsx";
import { Attachments, Evidence, Activity, Links } from "./ticket-resources.tsx";
import { Discussion, Relations } from "./collaboration.tsx";
import type { ScreenProps, Routes } from "./navigation.ts";
import { TicketProperties, propertyChanges } from "./ticket-properties.tsx";
import { TicketActions } from "./ticket-actions.tsx";

export function TicketDetail(props: ScreenProps<"Ticket">) {
  return (
    <TicketContent
      key={`${props.route.params.projectId}:${props.route.params.ticketId}`}
      projectId={props.route.params.projectId}
      ticketId={props.route.params.ticketId}
    />
  );
}
export function TicketContent({
  projectId,
  ticketId,
  preview = false,
  onUnavailable,
}: {
  projectId: string;
  ticketId: string;
  preview?: boolean;
  onUnavailable?: () => void;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<Routes>>();
  const { api } = useConnection(),
    color = usePalette();
  const access = useProjectAccess(projectId);
  const result = useQuery(api.query("get_ticket", { projectId, ticketId }));
  useEffect(() => {
    if (preview && result.error instanceof ApiError && result.error.code === "not_found")
      onUnavailable?.();
  }, [preview, result.error, onUnavailable]);
  const fields = useQuery(api.query("list_custom_fields", { projectId }));
  const update = useOperation("update_ticket");
  const release = useOperation("release_claim"),
    recover = useOperation("recover_claim");
  const [recovering, setRecovering] = useState(false),
    [reason, setReason] = useState(""),
    [actions, setActions] = useState(false);
  useLayoutEffect(() => {
    if (preview) return;
    navigation.setOptions(
      nativeHeaderOptions({
        title: result.data?.ticket.key ?? t("native.screen.ticket"),
        unstable_headerRightItems: () =>
          ticketHeaderItems(
            !result.data || access.canWrite
              ? {
                  title: t("common.action.edit"),
                  onPress: () => navigation.navigate("Edit", { projectId, ticketId }),
                  disabled: !result.data || !access.canWrite,
                }
              : undefined,
            {
              title: t("ticket.selection.more"),
              onPress: () => setActions(true),
              disabled: !result.data,
            },
          ),
      }),
    );
  }, [preview, navigation, projectId, ticketId, result.data, access.canWrite]);
  if (result.isPending) return <Loading />;
  if (!result.data)
    return (
      <Screen>
        <ErrorNotice
          error={result.error}
          retrying={result.isFetching}
          onRetry={() => {
            void result.refetch();
          }}
        />
      </Screen>
    );
  const { ticket, readiness, claim, canReleaseClaim } = result.data;
  const valued = (fields.data ?? []).filter((field) => ticket.customFields[field.id] !== undefined);
  return (
    <Screen>
      {preview && (
        <Body muted small>
          {ticket.key}
        </Body>
      )}
      <Text
        accessibilityRole="header"
        selectable
        style={{
          color: color.foreground,
          fontSize: 24,
          fontWeight: "600",
          lineHeight: 30,
          letterSpacing: -0.6,
        }}
      >
        {ticket.title}
      </Text>
      {access.canWrite ? (
        <TicketProperties
          compact
          projectId={projectId}
          value={ticket}
          disabled={update.isPending}
          onChange={(changes) =>
            update.mutate({
              projectId,
              ticketId: ticket.id,
              expectedVersion: ticket.version,
              changes: propertyChanges(changes),
            })
          }
        />
      ) : (
        <View style={styles.actions}>
          <Status ticket={ticket} />
          <PropertyValue projectId={projectId} property="priority" value={ticket.priority} />
          <PropertyValue projectId={projectId} property="kind" value={ticket.kind} />
          <PropertyValue projectId={projectId} property="difficulty" value={ticket.difficulty} />
          <PropertyValue projectId={projectId} property="assignee" value={ticket.assigneeId} />
        </View>
      )}
      {(ticket.startAt || ticket.dueAt) && (
        <Body muted small>
          {ticketScheduleText(ticket)}
        </Body>
      )}
      {ticket.archived && <Body muted>{t("native.detail.archived")}</Body>}
      <TicketTags projectId={projectId} tags={ticket.labels} scopes={ticket.scopes} />
      <ErrorNotice error={result.error ?? release.error ?? update.error} />
      {ticket.description ? (
        <Markdown>{ticket.description}</Markdown>
      ) : (
        <Body muted small>
          {t("native.detail.noDescription")}
        </Body>
      )}
      {ticket.acceptanceCriteria && (
        <Section title={t("native.detail.acceptanceCriteria")}>
          <Markdown>{ticket.acceptanceCriteria}</Markdown>
        </Section>
      )}
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
      <Section
        title={t("native.readiness.title")}
        collapsible
        initiallyOpen={!!claim}
        summary={
          <Body muted small>
            {readiness.ready ? t("native.readiness.ready") : t("native.readiness.notReady")}
          </Body>
        }
      >
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
            {access.canAdmin && (
              <Button
                title={t("native.readiness.recover.action")}
                onPress={() => setRecovering(true)}
              />
            )}
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
      <Links ticket={ticket} />
      <Evidence ticket={ticket} />
      <Activity ticket={ticket} />
      <Sheet title={ticket.key} open={actions} onClose={() => setActions(false)}>
        <TicketActions ticket={ticket} detail={!preview} onClose={() => setActions(false)} />
      </Sheet>
    </Screen>
  );
}
