import { dueWindows, dueWindow, dueWindowLabel } from "@kanvil/contracts/schedule";
import { createHeaderMenu } from "./navigation-actions.tsx";
import { sectionEntries } from "./ticket-sections.ts";
import { ProjectIcon } from "./project-icon.tsx";
import { useDeferredValue, useLayoutEffect, useState, useEffect, useMemo } from "react";
import { View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useInfiniteQuery } from "@tanstack/react-query";
import { searchResultTypes, type SearchResult } from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";
import { useHeaderSearch, useSectionDisclosure, useProjectNavigation } from "./navigation.ts";
import { useConnection, useWorkspace, useAllProjects, useFetchRemaining, useNow } from "./data.tsx";
import {
  Body,
  Button,
  Markdown,
  Sheet,
  ErrorNotice,
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
    open: openSearch,
  } = useHeaderSearch(query, onQuery, t("native.tickets.searchPlaceholder"));
  useLayoutEffect(
    () =>
      navigation.setOptions(
        nativeHeaderOptions({
          headerSearchBarOptions: searchOptions,
          unstable_headerRightItems: () => [
            createHeaderMenu(
              t("ticket.list.views"),
              { type: "sfSymbol", name: "rectangle.3.group" },
              [
                {
                  type: "action",
                  label: query.trim()
                    ? t("ticket.filter.searchChip", { query })
                    : t("ticket.filter.searchTickets"),
                  icon: { type: "sfSymbol", name: "magnifyingglass" },
                  onPress: openSearch,
                },
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
              {
                visibilityPriority: "default",
                identifier: "work-grouping",
                ...(query.trim() ? { badge: { value: 1 } } : {}),
              },
            ),
          ],
        }),
      ),
    [navigation, searchOptions, byProject, openSearch, query],
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
    <Screen
      scroll={false}
      scrollInsets
      header={
        <>
          <WorkspaceScope />
          {!searching && (
            <RemovableSummary
              label={t("shell.app.clearSearch")}
              value={query}
              onClear={() => changeQuery("")}
            />
          )}
          <ErrorNotice error={work.error ?? workspace.error} background={!!work.data} />
        </>
      }
    >
      <List
        data={entries}
        keyExtractor={(item) => item.id}
        onRefresh={() => work.refetch()}
        onEndReached={() => {
          if (work.hasNextPage && !work.isFetchingNextPage) void work.fetchNextPage();
        }}
        ListEmptyComponent={
          work.isLoading ? (
            <Loading />
          ) : (
            <View style={{ padding: 20 }}>
              <Body muted>
                {t(query.trim() ? "ticket.list.emptyFiltered" : "shell.app.noAssigned")}
              </Body>
            </View>
          )
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
  const [preview, setPreview] = useState<SearchResult>();
  function openResult(item: SearchResult) {
    setPreview(undefined);
    if (item.ticket)
      navigation.navigate("Ticket", { projectId: item.project.id, ticketId: item.ticket.id });
    else selectProject(item.project.id);
  }
  const { options: searchOptions } = useHeaderSearch(
    query,
    setQuery,
    t("shell.search.placeholder"),
    true,
  );
  useLayoutEffect(
    () =>
      navigation.setOptions(
        nativeHeaderOptions({
          headerSearchBarOptions: searchOptions,
          unstable_headerRightItems: () => [
            createHeaderMenu(
              t("ticket.filter.filters"),
              { type: "sfSymbol", name: "line.3.horizontal.decrease" },
              [
                {
                  type: "action",
                  label: t("shell.search.tab.all"),
                  state: type === undefined ? "on" : "off",
                  onPress: () => setType(undefined),
                },
                ...searchResultTypes.map((value) => ({
                  type: "action" as const,
                  label: t(`shell.search.tab.${value}`),
                  state: type === value ? ("on" as const) : ("off" as const),
                  onPress: () => setType(value),
                })),
              ],
              { identifier: "search-options", ...(type ? { badge: { value: 1 } } : {}) },
            ),
          ],
        }),
      ),
    [navigation, searchOptions, type],
  );
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
    <Screen
      scroll={false}
      scrollInsets
      header={
        <>
          <WorkspaceScope />
          <ErrorNotice error={results.error} background={!!results.data} />
        </>
      }
    >
      <List
        data={results.data?.pages.flatMap((page) => page.items) ?? []}
        keyExtractor={(item) => `${item.type}:${item.id}`}
        onEndReached={() => {
          if (results.hasNextPage && !results.isFetchingNextPage) void results.fetchNextPage();
        }}
        ListEmptyComponent={
          !q ? null : results.isLoading ? (
            <Loading />
          ) : (
            <View style={{ padding: 20 }}>
              <Body muted>{t("shell.search.noResults", { query: q })}</Body>
            </View>
          )
        }
        renderItem={({ item }) =>
          item.type === "ticket" && item.ticket ? (
            <TicketRow
              showProject
              ticket={{ ...item.ticket, projectId: item.project.id }}
              onPress={() => openResult(item)}
            />
          ) : (
            <Row
              title={item.title}
              overline={item.ticket?.key ?? t(`shell.search.tab.${item.type}`)}
              {...(item.type === "comment" ? { caption: item.excerpt, captionLines: 2 } : {})}
              onPress={() => (item.type === "comment" ? setPreview(item) : openResult(item))}
              onLongPress={() =>
                item.type === "project" ? selectProject(item.project.id, true) : setPreview(item)
              }
            />
          )
        }
      />
      <Sheet title={t("shell.page.search")} open={!!preview} onClose={() => setPreview(undefined)}>
        {preview && (
          <>
            <Heading>
              {preview.ticket
                ? t("native.labelValue", { label: preview.ticket.key, value: preview.title })
                : preview.title}
            </Heading>
            <Markdown>{preview.excerpt}</Markdown>
            <Button
              title={preview.ticket ? t("ticket.menu.open") : preview.project.name}
              onPress={() => openResult(preview)}
            />
          </>
        )}
      </Sheet>
    </Screen>
  );
}
