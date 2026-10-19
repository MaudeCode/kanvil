import { createHeaderAction } from "./navigation-actions.tsx";
import { useDeferredValue, useLayoutEffect, useState } from "react";
import { View, Text } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useInfiniteQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  states,
  stateLabels,
  priorityLabels,
  difficultyLabels,
  type Ticket,
} from "@kanvil/contracts";
import { formatNumber, t } from "@kanvil/contracts/i18n";
import { useConnection, useProjects, useOperation } from "./data.tsx";
import {
  Body,
  Button,
  Sheet,
  Choice,
  ErrorNotice,
  Field,
  Loading,
  List,
  Row,
  Screen,
  Status,
  usePalette,
} from "./ui.tsx";
import type { ScreenProps } from "./navigation.ts";

// Navigation invokes this callback directly; mount the component that owns the sheet state.
function projectHeader() {
  return <ProjectAction />;
}

export function Projects() {
  const navigation = useNavigation();
  const projects = useProjects();
  useLayoutEffect(() => {
    navigation.setOptions({ headerRight: projectHeader });
  }, [navigation]);
  return (
    <Screen scroll={false}>
      <ErrorNotice error={projects.error} />
      {projects.isPending ? (
        <Loading />
      ) : (
        <List
          data={projects.data ?? []}
          keyExtractor={(project) => project.id}
          onRefresh={() => {
            void projects.refetch();
          }}
          refreshing={projects.isRefetching}
          ListEmptyComponent={
            <View style={{ padding: 20 }}>
              <Body muted>{t("native.projects.empty")}</Body>
            </View>
          }
          renderItem={({ item }) => (
            <Row
              title={item.name}
              overline={item.key}
              caption={item.description}
              onPress={() =>
                navigation.navigate("Tickets", { projectId: item.id, name: item.name })
              }
            />
          )}
        />
      )}
    </Screen>
  );
}
export function Tickets({ route, navigation }: ScreenProps<"Tickets">) {
  const { api } = useConnection(),
    color = usePalette(),
    projects = useProjects();
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("");
  const q = useDeferredValue(query),
    project = projects.data?.find(
      (item) =>
        item.id === route.params.projectId || item.key === route.params.projectId.toUpperCase(),
    ),
    projectId = project?.id ?? route.params.projectId;
  const input = {
    projectId,
    q,
    ...(status ? { status: z.enum(states).parse(status) } : {}),
    limit: 50,
  };
  const tickets = useInfiniteQuery({
    queryKey: ["kanvil", api.query("list_tickets", input).queryKey, "pages"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.call("list_tickets", { ...input, offset: pageParam }),
    getNextPageParam: (last, pages) => {
      const count = pages.reduce((sum, page) => sum + page.items.length, 0);
      return count < last.total ? count : undefined;
    },
  });
  useLayoutEffect(() => {
    navigation.setOptions({
      title: route.params.name ?? project?.name ?? t("native.screen.tickets"),
      headerRight: createHeaderAction(t("native.screen.newTicket"), () =>
        navigation.navigate("Edit", { projectId }),
      ),
    });
  }, [navigation, projectId, route.params.name, project?.name]);
  const rows = tickets.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Screen scroll={false}>
      <View style={{ padding: 20, gap: 14 }}>
        <Field
          label={t("native.tickets.search")}
          value={query}
          onChangeText={setQuery}
          placeholder={t("native.tickets.searchPlaceholder")}
          returnKeyType="search"
        />
        <Choice
          label={t("common.filterField.status")}
          value={status}
          onChange={setStatus}
          options={[
            { value: "", label: t("native.tickets.allStatuses") },
            ...states.map((value) => ({ value, label: stateLabels[value] })),
          ]}
        />
        <ErrorNotice error={tickets.error} />
      </View>
      {tickets.isPending ? (
        <Loading />
      ) : (
        <List
          data={rows}
          keyExtractor={(ticket) => ticket.id}
          onRefresh={() => {
            void tickets.refetch();
          }}
          refreshing={tickets.isRefetching}
          onEndReached={() => {
            if (tickets.hasNextPage && !tickets.isFetchingNextPage) void tickets.fetchNextPage();
          }}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            <View style={{ padding: 20 }}>
              <Body muted>{t("native.tickets.empty")}</Body>
            </View>
          }
          ListFooterComponent={
            tickets.isFetchingNextPage ? (
              <Loading />
            ) : (
              <Text style={{ color: color.muted, textAlign: "center", padding: 20 }}>
                {t("native.tickets.count", {
                  shown: formatNumber(rows.length),
                  total: formatNumber(tickets.data?.pages[0]?.total ?? 0),
                })}
              </Text>
            )
          }
          renderItem={({ item }) => (
            <TicketRow
              ticket={item}
              onPress={() => navigation.navigate("Ticket", { projectId, ticketId: item.id })}
            />
          )}
        />
      )}
    </Screen>
  );
}
function TicketRow({ ticket, onPress }: { ticket: Ticket; onPress: () => void }) {
  return (
    <Row
      title={ticket.title}
      overline={ticket.key}
      metadata={
        <>
          <Status ticket={ticket} />
          <Body muted small>
            {t("native.ticket.priority", { priority: priorityLabels[ticket.priority] })}
          </Body>
          <Body muted small>
            {ticket.difficulty
              ? difficultyLabels[ticket.difficulty]
              : t("native.ticket.noDifficulty")}
          </Body>
        </>
      }
      onPress={onPress}
    />
  );
}

function ProjectAction() {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [key, setKey] = useState(""),
    [description, setDescription] = useState("");
  const create = useOperation("create_project"),
    navigation = useNavigation();
  return (
    <>
      <Button title={t("native.projects.new")} plain compact onPress={() => setOpen(true)} />
      <Sheet title={t("native.projects.new")} open={open} onClose={() => setOpen(false)}>
        <Field
          label={t("native.projects.name")}
          value={name}
          onChangeText={setName}
          maxLength={120}
        />
        <Field
          label={t("native.projects.prefix")}
          value={key}
          onChangeText={(value) => setKey(value.toUpperCase())}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={10}
        />
        <Field
          label={t("native.projects.description")}
          value={description}
          onChangeText={setDescription}
          multiline
          maxLength={5000}
        />
        <ErrorNotice error={create.error} />
        <Button
          title={t("native.projects.create")}
          disabled={create.isPending || !name.trim() || key.length < 2}
          primary
          onPress={() => {
            void create
              .mutateAsync({ name, key, description })
              .then((project) => {
                setOpen(false);
                navigation.navigate("Tickets", { projectId: project.id, name: project.name });
              })
              .catch(() => {});
          }}
        />
      </Sheet>
    </>
  );
}
