import { formatTimestamp } from "@kanvil/contracts";
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

export function TicketDetail({ route, navigation }: ScreenProps<"Ticket">) {
  const { api, baseUrl } = useConnection(),
    { projectId, ticketId } = route.params,
    color = usePalette();
  const result = useQuery(api.query("get_ticket", { projectId, ticketId }));
  const update = useOperation("update_ticket"),
    subscribe = useOperation("set_subscription"),
    release = useOperation("release_claim"),
    recover = useOperation("recover_claim");
  const [recovering, setRecovering] = useState(false),
    [reason, setReason] = useState("");
  useLayoutEffect(() => {
    navigation.setOptions({
      title: result.data?.ticket.key ?? "Ticket",
      headerRight: createHeaderAction("Edit", () =>
        navigation.navigate("Edit", { projectId, ticketId }),
      ),
    });
  }, [navigation, projectId, ticketId, result.data?.ticket.key]);
  if (result.isPending) return <Loading />;
  if (!result.data) return <ErrorNotice error={result.error} />;
  const { ticket, readiness, claim, canReleaseClaim, subscribed } = result.data;
  return (
    <Screen>
      <View style={styles.actions}>
        <Status value={ticket.status} />
        <Body muted>
          {ticket.priority} · {ticket.kind} · {ticket.difficulty ?? "Unspecified difficulty"} · v
          {ticket.version}
        </Body>
      </View>
      <Text
        accessibilityRole="header"
        selectable
        style={{ color: color.foreground, fontSize: 26, fontWeight: "700", lineHeight: 35 }}
      >
        {ticket.title}
      </Text>
      {ticket.archived && <Body muted>Archived</Body>}
      <Body muted>{ticket.labels.map((label) => `#${label}`).join(" ")}</Body>
      <View style={styles.actions}>
        <Button
          title={subscribed ? "Unsubscribe" : "Subscribe"}
          disabled={subscribe.isPending}
          onPress={() => subscribe.mutate({ projectId, ticketId: ticket.id, enabled: !subscribed })}
        />
        <Button
          title="Share"
          onPress={() => {
            void Share.share({
              message: `${ticket.key}: ${ticket.title}\n${baseUrl}/projects/${ticket.projectId}/tickets/${ticket.id}\nkanvil://projects/${ticket.projectId}/tickets/${ticket.id}`,
            });
          }}
        />
      </View>
      <ErrorNotice error={result.error ?? subscribe.error ?? update.error ?? release.error} />
      <Section title="Description">
        <Markdown>{ticket.description || "_No description_"}</Markdown>
      </Section>
      <Section title="Acceptance criteria">
        <Markdown>{ticket.acceptanceCriteria || "_No acceptance criteria_"}</Markdown>
      </Section>
      <Section title="Agent readiness">
        <Body>{readiness.ready ? "Ready to claim" : "Not ready to claim"}</Body>
        {readiness.reasons.map((item, index) => (
          <Body key={`${item.code}:${index}`} muted>
            • {item.message}
          </Body>
        ))}
        {ticket.holdReason && <Body>Hold: {ticket.holdReason}</Body>}
        {claim && (
          <>
            <Body>
              Claimed by {claim.workerId} until {formatTimestamp(claim.expiresAt)}.
            </Body>
            {canReleaseClaim && (
              <Button
                title="Release my claim"
                disabled={release.isPending}
                onPress={() =>
                  Alert.alert("Release claim?", "Stop your worker before releasing ownership.", [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Release",
                      onPress: () =>
                        release.mutate({ projectId, ticketId: ticket.id, claimId: claim.id }),
                    },
                  ])
                }
              />
            )}
            <Button title="Recover expired claim" onPress={() => setRecovering(true)} />
            <Sheet
              title="Recover expired claim"
              open={recovering}
              onClose={() => setRecovering(false)}
            >
              <Body>
                Only a project administrator can recover an expired claim. Confirm the worker has
                stopped first.
              </Body>
              <Field
                label="Recovery reason"
                value={reason}
                onChangeText={setReason}
                multiline
                maxLength={2000}
              />
              <ErrorNotice error={recover.error} />
              <Button
                title="Worker stopped · recover"
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
        title={ticket.archived ? "Unarchive ticket" : "Archive ticket"}
        onPress={() =>
          Alert.alert(
            ticket.archived ? "Unarchive ticket?" : "Archive ticket?",
            ticket.archived
              ? "Restore this ticket to active lists?"
              : "Remove this ticket from active lists and agent eligibility?",
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Confirm",
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
