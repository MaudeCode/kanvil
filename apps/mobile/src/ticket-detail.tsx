import {
  difficultyLabels,
  formatCustomFieldValue,
  formatTimestamp,
  kindLabels,
  readinessReasonText,
  ApiError,
} from "@kanvil/contracts";
import { formatDate, t } from "@kanvil/contracts/i18n";
import { createHeaderAction } from "./navigation-actions.tsx";
import { useEffect, useLayoutEffect, useState } from "react";
import { Alert, Share, Text, View } from "react-native";
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
  priorityText,
} from "./ui.tsx";
import { Attachments, Evidence, Activity, Links } from "./ticket-resources.tsx";
import { Discussion, Relations } from "./collaboration.tsx";
import type { ScreenProps, Routes } from "./navigation.ts";
import { TicketActions } from "./ticket-actions.tsx";

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
  const { api, baseUrl } = useConnection(),
    color = usePalette();
  const access = useProjectAccess(projectId);
  const result = useQuery(api.query("get_ticket", { projectId, ticketId }));
  useEffect(() => {
    if (preview && result.error instanceof ApiError && result.error.code === "not_found")
      onUnavailable?.();
  }, [preview, result.error, onUnavailable]);
  const fields = useQuery(api.query("list_custom_fields", { projectId }));
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
        unstable_headerRightItems: () => [
          ...(access.canWrite
            ? [
                createHeaderAction(
                  t("common.action.edit"),
                  () => navigation.navigate("Edit", { projectId, ticketId }),
                  { type: "sfSymbol", name: "square.and.pencil" },
                ),
              ]
            : []),
          createHeaderAction(
            t("native.detail.share"),
            () => {
              void Share.share({ message: `${baseUrl}/projects/${projectId}/tickets/${ticketId}` });
            },
            { type: "sfSymbol", name: "square.and.arrow.up" },
          ),
          createHeaderAction(t("ticket.selection.more"), () => setActions(true), {
            type: "sfSymbol",
            name: "ellipsis",
          }),
        ],
      }),
    );
  }, [preview, navigation, projectId, ticketId, result.data?.ticket.key, baseUrl, access.canWrite]);
  if (result.isPending) return <Loading />;
  if (!result.data) return <ErrorNotice error={result.error} />;
  const { ticket, readiness, claim, canReleaseClaim } = result.data;
  const valued = (fields.data ?? []).filter((field) => ticket.customFields[field.id] !== undefined);
  return (
    <Screen>
      {preview && (
        <Body muted small>
          {ticket.key}
        </Body>
      )}
      <View style={styles.actions}>
        <Status ticket={ticket} />
        <Body muted small>
          {priorityText(ticket.priority)}
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
      <ErrorNotice error={result.error ?? release.error} />
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
