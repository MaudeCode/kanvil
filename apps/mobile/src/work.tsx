import { dueWindows, dueWindow, dueWindowLabel } from "@kanvil/contracts/schedule";
import { createHeaderMenu } from "./navigation-actions.tsx";
import { sectionEntries } from "./ticket-sections.ts";
import { ProjectIcon } from "./project-icon.tsx";
import { useDeferredValue, useLayoutEffect, useState, useEffect, useMemo } from "react";
import { View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useInfiniteQuery } from "@tanstack/react-query";
import { searchResultTypes } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { useHeaderSearch, useSectionDisclosure, useProjectNavigation } from "./navigation.ts";
import { useConnection, useWorkspace, useAllProjects, useFetchRemaining, useNow } from "./data.tsx";
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
  Heading,
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
  const [query, setQuery] = useWorkspaceSearch("work"),
    [byProject, setByProject] = useState(false);
  const { collapsed, onQuery, changeCollapsed } = useSectionDisclosure(
    query,
    setQuery,
    undefined,
    `${workspace.active?.id}:${byProject ? "project" : "due"}`,
  );
  const projects = useAllProjects();
  const {
    options: searchOptions,
    setText: changeQuery,
    searching,
  } = useHeaderSearch(query, onQuery, t("native.tickets.searchPlaceholder"));
  useLayoutEffect(
    () =>
      navigation.setOptions(
        nativeHeaderOptions({
          headerSearchBarOptions: searchOptions,
          unstable_headerRightItems: () => [
            createHeaderMenu(
              t("ticket.display.groupBy"),
              { type: "sfSymbol", name: "rectangle.3.group" },
              [
                {
                  type: "action",
                  label: t("ticket.display.dueDate"),
                  state: byProject ? "off" : "on",
                  onPress: () => setByProject(false),
                },
                {
                  type: "action",
                  label: t("ticket.project.label"),
                  state: byProject ? "on" : "off",
                  onPress: () => setByProject(true),
                },
              ],
              { visibilityPriority: "default", identifier: "work-grouping" },
            ),
          ],
        }),
      ),
    [navigation, searchOptions, byProject],
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
  useFetchRemaining(work, !!workspace.active);
  const rows = useMemo(() => work.data?.pages.flatMap((page) => page.items) ?? [], [work.data]);
  const now = useNow();
  const sections = byProject
    ? [...new Set(rows.map((ticket) => ticket.projectId))].map((id) => ({
        id,
        name:
          projects.data?.find((project) => project.id === id)?.name ?? t("ticket.project.label"),
        tickets: rows.filter((ticket) => ticket.projectId === id),
      }))
    : [...dueWindows.map(([id]) => id), "none" as const]
        .map((id) => ({
          id,
          name: dueWindowLabel(id),
          tickets: rows.filter((ticket) => dueWindow(ticket, now) === id),
        }))
        .filter((group) => group.tickets.length);
  const entries = sectionEntries(sections, collapsed, !!query.trim());
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
          data={entries}
          keyExtractor={(item) => item.id}
          onRefresh={() => work.refetch()}
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
          ListFooterComponent={work.hasNextPage ? <Loading /> : undefined}
          renderItem={({ item }) =>
            "ticket" in item ? (
              <TicketRow
                showProject
                ticket={item.ticket}
                onPress={() =>
                  navigation.navigate("Ticket", {
                    projectId: item.ticket.projectId,
                    ticketId: item.ticket.id,
                  })
                }
              />
            ) : (
              <Heading
                compact
                disclosure={{
                  expanded: !collapsed.has(item.sectionId),
                  count: item.count,
                  label: t(
                    collapsed.has(item.sectionId)
                      ? "ticket.list.expandSection"
                      : "ticket.list.collapseSection",
                    { section: item.heading },
                  ),
                  leading:
                    byProject && projects.data?.find((project) => project.id === item.sectionId) ? (
                      <ProjectIcon
                        project={
                          projects.data.find((project) => project.id === item.sectionId) ?? {
                            iconName: null,
                            iconColor: "default",
                            image: null,
                          }
                        }
                        size={16}
                      />
                    ) : undefined,
                  onPress: () => {
                    const next = new Set(collapsed);
                    if (next.has(item.sectionId)) next.delete(item.sectionId);
                    else next.add(item.sectionId);
                    changeCollapsed(next);
                  },
                }}
              >
                {item.heading}
              </Heading>
            )
          }
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
      <WorkspaceScope>
        <Choice
          label={t("shell.page.search")}
          compact
          value={type ?? "all"}
          options={[
            { value: "all", label: t("shell.search.tab.all") },
            ...searchResultTypes.map((value) => ({ value, label: t(`shell.search.tab.${value}`) })),
          ]}
          onChange={(value) => setType(searchResultTypes.find((item) => item === value))}
        />
      </WorkspaceScope>
      <View style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
        <Field
          label={t("shell.search.field")}
          labelHidden
          variant="search"
          placeholder={t("shell.search.placeholder")}
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
        />
        <ErrorNotice error={results.error} />
      </View>
      {!q ? null : results.isLoading ? (
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
          renderItem={({ item }) =>
            item.type === "ticket" && item.ticket ? (
              <TicketRow
                showProject
                ticket={{ ...item.ticket, projectId: item.project.id }}
                onPress={() =>
                  navigation.navigate("Ticket", {
                    projectId: item.project.id,
                    ticketId: item.ticket?.id ?? item.id,
                  })
                }
              />
            ) : (
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
            )
          }
        />
      )}
    </Screen>
  );
}
