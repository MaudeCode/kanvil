import { useDeferredValue, useLayoutEffect, useState, useEffect } from "react";
import { View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useInfiniteQuery } from "@tanstack/react-query";
import { searchResultTypes } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { useHeaderSearch, useProjectNavigation } from "./navigation.ts";
import { useConnection, useWorkspace } from "./data.tsx";
import {
  Body,
  Choice,
  ErrorNotice,
  Field,
  List,
  Loading,
  Row,
  Screen,
  RemovableSummary,
  WorkspaceScope,
  nativeHeaderOptions,
} from "./ui.tsx";
import { TicketRow } from "./ui.tsx";

// The account-owned context also retains workspace searches when their root remounts.
function useWorkspaceSearch(page: string) {
  const { contexts } = useProjectNavigation(),
    { active } = useWorkspace();
  const [query, setQuery] = useState(() => contexts.search(active?.id ?? "", page));
  useEffect(() => {
    if (active) contexts.saveSearch(active.id, page, query);
  }, [contexts, active, page, query]);
  return [query, setQuery] as const;
}

export function MyWork() {
  const { api } = useConnection(),
    workspace = useWorkspace(),
    navigation = useNavigation();
  const [query, setQuery] = useWorkspaceSearch("work");
  const {
    options: searchOptions,
    setText: changeQuery,
    searching,
  } = useHeaderSearch(query, setQuery, t("native.tickets.searchPlaceholder"));
  useLayoutEffect(
    () => navigation.setOptions(nativeHeaderOptions({ headerSearchBarOptions: searchOptions })),
    [navigation, searchOptions],
  );
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
      <WorkspaceScope />
      {!searching && (
        <RemovableSummary
          label={t("shell.app.clearSearch")}
          value={query}
          onClear={() => changeQuery("")}
        />
      )}
      <ErrorNotice error={work.error ?? workspace.error} />
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
              <Body muted>
                {t(query.trim() ? "ticket.list.emptyFiltered" : "shell.app.noAssigned")}
              </Body>
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
  const [query, setQuery] = useWorkspaceSearch("search");
  const [type, setType] = useState<(typeof searchResultTypes)[number] | undefined>();
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
      <WorkspaceScope />
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
