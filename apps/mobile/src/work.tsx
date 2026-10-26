import { useDeferredValue, useState } from "react";
import { View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { formatEvent, formatTimestamp, searchResultTypes } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { useProjectNavigation } from "./navigation.ts";
import { useConnection, useWorkspace } from "./data.tsx";
import { Body, Choice, ErrorNotice, Field, List, Loading, Row, Screen, Section } from "./ui.tsx";
import { TicketRow } from "./ui.tsx";

// Home and My work read the same operation; the home preview is deliberately bounded.
export function WorkOverview() {
  const { api } = useConnection(),
    workspace = useWorkspace(),
    navigation = useNavigation();
  const work = useQuery({
    ...api.query("list_my_work", {
      workspaceId: workspace.active?.id,
      sort: "due",
      limit: 5,
      activity: 5,
    }),
    enabled: !!workspace.active,
  });
  return (
    <View style={{ paddingHorizontal: 20 }}>
      <ErrorNotice error={workspace.error ?? work.error} />
      <Section title={t("shell.app.assigned")}>
        {work.isLoading ? (
          <Loading />
        ) : work.data?.items.length ? (
          work.data.items.map((ticket) => (
            <TicketRow
              key={ticket.id}
              ticket={ticket}
              onPress={() =>
                navigation.navigate("Ticket", { projectId: ticket.projectId, ticketId: ticket.id })
              }
            />
          ))
        ) : (
          <Body muted>{t("shell.app.noAssigned")}</Body>
        )}
      </Section>
      <Section title={t("shell.app.recentActivity")}>
        {work.data?.activity.length ? (
          work.data.activity.map((event) => (
            <Row
              key={event.id}
              title={formatEvent(event, true)}
              caption={formatTimestamp(event.createdAt)}
              onPress={() => {
                if (event.ticketId)
                  navigation.navigate("Ticket", {
                    projectId: event.projectId,
                    ticketId: event.ticketId,
                  });
              }}
            />
          ))
        ) : (
          <Body muted>{t("shell.app.noActivity")}</Body>
        )}
      </Section>
    </View>
  );
}

export function MyWork() {
  const { api } = useConnection(),
    workspace = useWorkspace(),
    navigation = useNavigation();
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query);
  const input = { workspaceId: workspace.active?.id, q, sort: "due" as const, limit: 50 };
  const work = useInfiniteQuery({
    queryKey: [...api.query("list_my_work", input).queryKey, "pages"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.call("list_my_work", { ...input, offset: pageParam }),
    getNextPageParam: (last, pages) => {
      const count = pages.reduce((sum, page) => sum + page.items.length, 0);
      return count < last.total ? count : undefined;
    },
    enabled: !!workspace.active,
  });
  return (
    <Screen scroll={false}>
      <View style={{ padding: 20 }}>
        <Field label={t("native.tickets.search")} value={query} onChangeText={setQuery} />
        <ErrorNotice error={work.error ?? workspace.error} />
      </View>
      {work.isLoading ? (
        <Loading />
      ) : (
        <List
          data={work.data?.pages.flatMap((page) => page.items) ?? []}
          keyExtractor={(item) => item.id}
          onRefresh={() => {
            void work.refetch();
          }}
          refreshing={work.isRefetching}
          onEndReached={() => {
            if (work.hasNextPage && !work.isFetchingNextPage) void work.fetchNextPage();
          }}
          ListEmptyComponent={
            <View style={{ padding: 20 }}>
              <Body muted>{t("shell.app.noAssigned")}</Body>
            </View>
          }
          renderItem={({ item }) => (
            <TicketRow
              ticket={item}
              onPress={() =>
                navigation.navigate("Ticket", { projectId: item.projectId, ticketId: item.id })
              }
            />
          )}
        />
      )}
    </Screen>
  );
}

export function Search() {
  const { selectProject } = useProjectNavigation();
  const { api } = useConnection(),
    workspace = useWorkspace(),
    navigation = useNavigation();
  const [query, setQuery] = useState(""),
    [type, setType] = useState<(typeof searchResultTypes)[number] | undefined>();
  const q = useDeferredValue(query.trim());
  const input = { workspaceId: workspace.active?.id, q, type, limit: 50 };
  const results = useInfiniteQuery({
    queryKey: [...api.query("search_workspace", input).queryKey, "pages"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.call("search_workspace", { ...input, offset: pageParam }),
    getNextPageParam: (last, pages) => {
      const count = pages.reduce((sum, page) => sum + page.items.length, 0);
      return count < last.total && count <= 1000 ? count : undefined;
    },
    enabled: !!q && !!workspace.active,
  });
  return (
    <Screen scroll={false}>
      <View style={{ padding: 20, gap: 12 }}>
        <Field
          label={t("shell.search.field")}
          placeholder={t("shell.search.placeholder")}
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
        />
        <Choice
          label={t("shell.page.search")}
          value={type ?? "all"}
          options={[
            { value: "all", label: t("shell.search.tab.all") },
            ...searchResultTypes.map((value) => ({ value, label: t(`shell.search.tab.${value}`) })),
          ]}
          onChange={(value) => setType(searchResultTypes.find((item) => item === value))}
        />
        <ErrorNotice error={results.error} />
      </View>
      {!q ? (
        <View style={{ padding: 20 }}>
          <Body muted>{t("shell.search.empty")}</Body>
        </View>
      ) : results.isLoading ? (
        <Loading />
      ) : (
        <List
          data={results.data?.pages.flatMap((page) => page.items) ?? []}
          keyExtractor={(item) => `${item.type}:${item.id}`}
          onEndReached={() => {
            if (results.hasNextPage && !results.isFetchingNextPage) void results.fetchNextPage();
          }}
          ListEmptyComponent={
            <View style={{ padding: 20 }}>
              <Body muted>{t("shell.search.noResults", { query: q })}</Body>
            </View>
          }
          renderItem={({ item }) => (
            <Row
              title={item.title}
              overline={item.ticket?.key ?? t(`shell.search.tab.${item.type}`)}
              caption={item.excerpt}
              onPress={() => {
                if (item.ticket)
                  navigation.navigate("Ticket", {
                    projectId: item.project.id,
                    ticketId: item.ticket.id,
                  });
                else selectProject(item.project.id);
              }}
            />
          )}
        />
      )}
    </Screen>
  );
}
