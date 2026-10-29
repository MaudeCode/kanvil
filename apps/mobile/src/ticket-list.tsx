import { labelOptions } from "./ticket-values.tsx";
import { useFocusEffect, useIsFocused, usePreventRemove } from "@react-navigation/native";
import { calendarDay, scheduleWindow } from "@kanvil/contracts/schedule";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { Alert, Platform, View, useWindowDimensions } from "react-native";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
} from "@react-navigation/native-stack";
import {
  states,
  stateLabels,
  priorities,
  priorityLabels,
  kinds,
  kindLabels,
  difficulties,
  difficultyLabels,
  ticketFilter,
  filterFieldNames,
  filterFieldLabels,
  filterList,
  filterKey,
  sortLabels,
  defaultOrder,
  dueFilterLabels,
  operations,
  ticketPredicates,
  type Input,
  type Ticket,
  type FilterField,
} from "@kanvil/contracts";
import { ticketLayouts } from "@kanvil/contracts/navigation";
import { firstWeekday, t } from "@kanvil/contracts/i18n";
import {
  useConnection,
  useAllProjects,
  useOperation,
  useProjectAccess,
  useFetchRemaining,
} from "./data.tsx";
import {
  nativeHeaderOptions,
  Body,
  Button,
  Choice,
  ErrorNotice,
  EmptyState,
  Field,
  Heading,
  List,
  Loading,
  Screen,
  Scroll,
  Sheet,
  TicketRow,
  usePalette,
  RemovableSummary,
  Row,
  PropertyValue,
  TicketGlyph,
} from "./ui.tsx";
import {
  createHeaderAction,
  projectHeaderItems,
  createHeaderMenu,
  ticketHeaderItems,
  sidebarHeaderItem,
} from "./navigation-actions.tsx";
import { TicketActions, BulkProperties } from "./ticket-actions.tsx";
import { TicketSchedule } from "./ticket-schedule.tsx";
import { TicketContent } from "./ticket-detail.tsx";
import { SplitView } from "./split-view.tsx";
import {
  useHeaderSearch,
  useSectionDisclosure,
  useProjectNavigation,
  type ScreenProps,
} from "./navigation.ts";
import { ticketSections, sectionEntries, sectionHeaderIndices } from "./ticket-sections.ts";

function useTicketPages(input: Input<"list_tickets">, enabled: boolean) {
  const { api } = useConnection();
  const result = useInfiniteQuery({
    queryKey: [...api.query("list_tickets", input).queryKey, "pages"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.call("list_tickets", { ...input, offset: pageParam }),
    getNextPageParam: (last, pages) => {
      const count = pages.reduce((sum, page) => sum + page.items.length, 0);
      return count < last.total ? count : undefined;
    },
    enabled,
  });
  useFetchRemaining(result, enabled);
  return result;
}

export function Tickets({ route, navigation }: ScreenProps<"Tickets">) {
  const { api } = useConnection(),
    projects = useAllProjects(),
    color = usePalette();
  const { width } = useWindowDimensions();
  const project = projects.data?.find(
      (item) =>
        item.id === route.params.projectId || item.key === route.params.projectId.toUpperCase(),
    ),
    projectId = project?.id ?? route.params.projectId,
    access = useProjectAccess(projectId);
  const { contexts, showPicker } = useProjectNavigation();
  const isFocused = useIsFocused();
  const [initial] = useState(() => contexts.get(projectId));
  const [anchor, setAnchor] = useState(() => initial?.anchor ?? calendarDay(new Date()));
  const [sidebarHidden, setSidebarHidden] = useState(initial?.sidebarHidden ?? false);
  const [splitState, setSplitState] = useState({
    collapsed: false,
    secondaryVisible: initial?.secondaryVisible ?? !!initial?.selectedTicketId,
  });
  const views = useQuery(api.query("list_views", { projectId })),
    workflow = useQuery(api.query("list_workflow_states", { projectId }));
  const [filters, setFilters] = useState(() => ticketFilter.parse(initial?.filters ?? {})),
    [query, setQuery] = useState(initial?.query ?? ""),
    [filtering, setFiltering] = useState(false),
    [managingViews, setManagingViews] = useState(false),
    [viewQuery, setViewQuery] = useState(""),
    [saving, setSaving] = useState(false),
    [name, setName] = useState(""),
    [focused, setFocused] = useState<Ticket>(),
    [selectedTicketId, setSelectedTicketId] = useState(initial?.selectedTicketId),
    [selection, setSelection] = useState<Map<string, Ticket>>(() => new Map()),
    [bulkOpen, setBulkOpen] = useState(false),
    [selecting, setSelecting] = useState(false),
    [error, setError] = useState<unknown>();
  const planning = route.params.collection === "planning";
  const layout = planning ? "list" : (route.params.layout ?? "list");
  const split =
    Platform.OS === "ios" &&
    Number.parseInt(Platform.Version, 10) >= 26 &&
    (layout === "list" || layout === "board");
  const detailOnly =
    split && splitState.secondaryVisible && (splitState.collapsed || sidebarHidden);
  const exitSelection = useCallback(() => {
    setSelecting(false);
    setSelection(new Map());
  }, []);
  usePreventRemove(selecting, exitSelection);
  useFocusEffect(useCallback(() => exitSelection, [exitSelection]));
  const q = useDeferredValue(query);
  const collection = planning ? "planning" : "all";
  const { normalCollapsed, collapsed, onQuery, changeCollapsed } = useSectionDisclosure(
    query,
    setQuery,
    initial?.collapsedSections,
    collection,
  );
  const {
    options: searchOptions,
    setText: changeQuery,
    searching,
    open: openSearch,
  } = useHeaderSearch(query, onQuery, t("native.tickets.searchPlaceholder"));
  const changeFilters = useCallback(
    (next: typeof filters) => {
      setFilters(next);
      navigation.setParams({ viewId: "" });
    },
    [navigation],
  );
  const sortItems = useMemo<NativeStackHeaderItemMenu["menu"]["items"]>(() => {
    const common = new Set<string>(["priority", "updated", "created", "title", filters.sort]);
    const options = ticketFilter.shape.sort.unwrap().options.map((sort) => ({
      sort,
      item: {
        type: "action" as const,
        label: sortLabels[sort],
        state: filters.sort === sort ? ("on" as const) : ("off" as const),
        onPress: () => changeFilters({ ...filters, sort }),
      },
    }));
    return [
      {
        type: "submenu",
        label: t("ticket.display.orderBy"),
        inline: true,
        items: [
          ...options.filter(({ sort }) => common.has(sort)).map(({ item }) => item),
          {
            type: "submenu",
            label: t("shell.primitive.more"),
            items: options.filter(({ sort }) => !common.has(sort)).map(({ item }) => item),
          },
        ],
      },
      {
        type: "submenu",
        label: t("ticket.display.direction"),
        inline: true,
        layout: "palette",
        items: (["asc", "desc"] as const).map((order) => ({
          type: "action",
          label: t(order === "asc" ? "ticket.display.ascending" : "ticket.display.descending"),
          icon: {
            type: "sfSymbol",
            name: order === "asc" ? "arrow.up" : "arrow.down",
          },
          state: (filters.order ?? defaultOrder[filters.sort]) === order ? "on" : "off",
          onPress: () => changeFilters({ ...filters, order }),
        })),
      },
    ];
  }, [filters, changeFilters]);

  const save = useOperation("save_view"),
    deleteView = useOperation("delete_view"),
    bulk = useOperation("bulk_update_tickets"),
    remove = useOperation("bulk_delete_tickets");
  const range = useMemo(
    () =>
      layout === "calendar" || layout === "timeline"
        ? scheduleWindow(layout, anchor, firstWeekday())
        : null,
    [layout, anchor],
  );
  const input = {
    ...filters,
    q,
    projectId,
    limit: 100,
    ...(range
      ? { scheduledFrom: range.from.toISOString(), scheduledTo: range.to.toISOString() }
      : {}),
  };
  const includesBacklog =
    (!filterList(filters.status).length || filterList(filters.status).includes("backlog")) &&
    !filterList(filters.statusNot).includes("backlog");
  const tickets = useTicketPages(input, !planning);
  const backlog = useTicketPages(
    { ...input, status: "backlog", statusNot: undefined, archived: "exclude" },
    planning && includesBacklog,
  );
  const archived = useTicketPages({ ...input, archived: "only" }, planning);
  const rows = useMemo(() => {
    const pages = planning
      ? [...(includesBacklog ? (backlog.data?.pages ?? []) : []), ...(archived.data?.pages ?? [])]
      : (tickets.data?.pages ?? []);
    return [
      ...new Map(pages.flatMap((page) => page.items).map((ticket) => [ticket.id, ticket])).values(),
    ];
  }, [planning, includesBacklog, backlog.data, archived.data, tickets.data]);
  const sections = useMemo(
    () =>
      planning
        ? [
            {
              id: "planned",
              name: t("ticket.list.planned"),
              category: "backlog" as const,
              tickets: rows.filter((ticket) => !ticket.archived),
            },
            {
              id: "archived",
              name: t("ticket.list.archived"),
              category: "done" as const,
              tickets: rows.filter((ticket) => ticket.archived),
            },
          ]
        : ticketSections(rows, workflow.data),
    [planning, rows, workflow.data],
  );
  const selected = useQuery({
    ...api.query("get_ticket", { projectId, ticketId: selectedTicketId ?? "none" }),
    enabled: !!selectedTicketId,
  });
  const selectedTicket = rows.find((item) => item.id === selectedTicketId) ?? selected.data?.ticket;
  const visibleTicket = split && splitState.secondaryVisible ? selectedTicket : undefined;
  const newTicket = useCallback(
    () => navigation.navigate("Edit", { projectId }),
    [navigation, projectId],
  );
  const moreTicketActions = useCallback(() => {
    if (visibleTicket)
      setFocused(rows.find((ticket) => ticket.id === visibleTicket.id) ?? visibleTicket);
  }, [visibleTicket, rows]);
  useEffect(() => {
    if (isFocused)
      contexts.save(projectId, {
        filters,
        query,
        anchor,
        selectedTicketId,
        secondaryVisible: splitState.secondaryVisible,
        sidebarHidden,
        location: route.params,
        collapsedSections: {
          ...contexts.get(projectId)?.collapsedSections,
          [collection]: [...normalCollapsed],
        },
      });
  }, [
    isFocused,
    contexts,
    projectId,
    filters,
    query,
    anchor,
    selectedTicketId,
    splitState.secondaryVisible,
    sidebarHidden,
    route.params,
    collection,
    normalCollapsed,
  ]);
  const pending = planning
    ? (includesBacklog && backlog.isPending) || archived.isPending
    : tickets.isPending;
  const listError = planning ? (backlog.error ?? archived.error) : tickets.error;
  const incomplete = planning
    ? (includesBacklog && backlog.hasNextPage) || archived.hasNextPage
    : tickets.hasNextPage;
  const loadingMore = planning
    ? backlog.isFetchingNextPage || archived.isFetchingNextPage
    : tickets.isFetchingNextPage;
  const title = project?.name ?? route.params.name ?? t("native.screen.tickets");
  const selectedTickets = useMemo(() => [...selection.values()], [selection]);
  const versions = useMemo(
    () =>
      selectedTickets.map((ticket) => ({ ticketId: ticket.id, expectedVersion: ticket.version })),
    [selectedTickets],
  );
  const restoreSelection =
    selectedTickets.length > 0 && selectedTickets.every((ticket) => ticket.archived);
  const applyBulk = bulk.mutateAsync,
    deleteTickets = remove.mutateAsync,
    removeView = deleteView.mutateAsync;
  const apply = useCallback(
    async (changes: Input<"update_ticket">["changes"]) => {
      await applyBulk({ projectId, tickets: versions, changes });
      setSelection(new Map());
      setSelecting(false);
      setBulkOpen(false);
    },
    [applyBulk, projectId, versions],
  );
  const toggle = useCallback(
    (ticket: Ticket) => {
      const next = new Map(selection);
      if (next.has(ticket.id)) next.delete(ticket.id);
      else next.set(ticket.id, ticket);
      const parsed = operations.bulk_update_tickets.input.shape.tickets.safeParse(
        [...next.values()].map((item) => ({ ticketId: item.id, expectedVersion: item.version })),
      );
      if (next.size && !parsed.success) setError(parsed.error);
      else {
        setSelection(next);
        setSelecting(true);
      }
    },
    [selection],
  );
  const destroy = useCallback(
    () =>
      Alert.alert(
        t("ticket.selection.delete"),
        t("ticket.selection.deleteConfirm", { count: selection.size, collection: title }),
        [
          { text: t("common.action.cancel"), style: "cancel" },
          {
            text: t("common.action.delete"),
            style: "destructive",
            onPress: () => {
              void deleteTickets({ projectId, tickets: versions })
                .then(() => setSelection(new Map()))
                .catch(() => {});
            },
          },
        ],
      ),
    [deleteTickets, projectId, versions, selection.size, title],
  );
  const filterCount =
    ticketPredicates(filters).length +
    (filters.archived !== "exclude" ? 1 : 0) +
    (filters.due ? 1 : 0) +
    (filters.parentId ? 1 : 0);
  const filtered = !!query.trim() || filterCount > 0;
  const clearFilters = () => {
    setFilters(ticketFilter.parse({}));
    navigation.setParams({ viewId: "" });
  };
  const viewItems = useMemo<NativeStackHeaderItemMenu["menu"]["items"]>(
    () => [
      ...(split && selectedTicketId
        ? [
            {
              type: "action" as const,
              label: t("detail.page.closePreview"),
              icon: { type: "sfSymbol" as const, name: "xmark" as const },
              onPress: () => {
                setSelectedTicketId(undefined);
                setSplitState((state) => ({ ...state, secondaryVisible: false }));
              },
            },
          ]
        : []),
      {
        type: "submenu",
        label: t("ticket.display.layout"),
        inline: true,
        layout: "palette",
        items: ticketLayouts
          .filter((value) => !planning || value === "list")
          .map((value) => ({
            type: "action",
            label:
              value === "calendar" || value === "timeline"
                ? t(`ticket.schedule.${value}`)
                : t(`ticket.display.${value}`),
            icon: {
              type: "sfSymbol",
              name:
                value === "list"
                  ? "list.bullet"
                  : value === "board"
                    ? "rectangle.split.3x1"
                    : value === "calendar"
                      ? "calendar"
                      : "chart.bar.xaxis",
            },
            state: value === layout ? "on" : "off",
            onPress: () =>
              navigation.setParams({ layout: value, collection: planning ? "planning" : "all" }),
          })),
      },
      {
        type: "submenu",
        label: t("ticket.list.tickets"),
        inline: true,
        items: [
          {
            type: "action",
            label: t("ticket.list.allTickets"),
            state: planning ? "off" : "on",
            onPress: () => navigation.setParams({ collection: "all", viewId: "" }),
          },
          {
            type: "action",
            label: t("ticket.list.planningLink"),
            state: planning ? "on" : "off",
            onPress: () =>
              navigation.setParams({ collection: "planning", layout: "list", viewId: "" }),
          },
        ],
      },
      {
        type: "submenu",
        label: t("ticket.list.views"),
        items: [
          ...(views.data ?? []).slice(0, 6).map((view) => ({
            type: "action" as const,
            label: view.name,
            state: route.params.viewId === view.id ? ("on" as const) : ("off" as const),
            onPress: () => {
              setFilters(view.filters);
              changeQuery(view.filters.q ?? "");
              navigation.setParams({ viewId: view.id });
            },
          })),
          {
            type: "action",
            label: t("ticket.list.saveCurrentView"),
            onPress: () => {
              setName("");
              setSaving(true);
            },
          },
          {
            type: "action",
            label: t("ticket.list.manageViews"),
            onPress: () => {
              setViewQuery("");
              setManagingViews(true);
            },
          },
        ],
      },
      {
        type: "submenu",
        label: "",
        inline: true,
        items: [
          {
            type: "action",
            label: query.trim()
              ? t("ticket.filter.searchChip", { query })
              : t("ticket.filter.searchTickets"),
            icon: { type: "sfSymbol", name: "magnifyingglass" },
            onPress: openSearch,
          },
          ...(query.trim()
            ? [
                {
                  type: "action" as const,
                  label: t("shell.app.clearSearch"),
                  onPress: () => changeQuery(""),
                },
              ]
            : []),
          {
            type: "action",
            label: t("shell.settingsNav.projectSettings"),
            onPress: () =>
              navigation.navigate("ProjectSettings", { projectId, section: "general" }),
          },
          {
            type: "action",
            label: filterCount
              ? t("ticket.filter.filtersActive", { active: filterCount })
              : t("ticket.filter.filters"),
            onPress: () => setFiltering(true),
          },
          {
            type: "action",
            label: t("native.tickets.select"),
            disabled: !rows.length || !access.canWrite,
            onPress: () => {
              if (layout === "calendar" || layout === "timeline")
                navigation.setParams({ layout: "list" });
              setSelecting(true);
            },
          },
          ...(layout === "list"
            ? [
                {
                  type: "action" as const,
                  label: t("native.tickets.expandAll"),
                  onPress: () => changeCollapsed(new Set()),
                },
                {
                  type: "action" as const,
                  label: t("native.tickets.collapseAll"),
                  onPress: () => changeCollapsed(new Set(sections.map((section) => section.id))),
                },
              ]
            : []),
        ],
      },
    ],
    [
      planning,
      layout,
      navigation,
      views.data,
      route.params.viewId,
      changeQuery,
      rows.length,
      access.canWrite,
      changeCollapsed,
      sections,
      query,
      openSearch,
      filterCount,
      projectId,
      split,
      selectedTicketId,
    ],
  );
  const headerItems = useMemo<NativeStackHeaderItem[]>(
    () =>
      selecting
        ? [
            createHeaderAction(
              t("common.action.done"),
              () => {
                setSelection(new Map());
                setSelecting(false);
              },
              { type: "sfSymbol", name: "xmark" },
              false,
              { identifier: "selection-done", visibilityPriority: "high" },
            ),
            createHeaderAction(
              t("ticket.selection.fields"),
              () => setBulkOpen(true),
              { type: "sfSymbol", name: "slider.horizontal.3" },
              bulk.isPending || !selection.size,
              { identifier: "selection-fields", visibilityPriority: "high" },
            ),
            createHeaderMenu(
              t("ticket.selection.more"),
              { type: "sfSymbol", name: "checklist" },
              [
                {
                  type: "action",
                  label: restoreSelection
                    ? t("ticket.selection.restore")
                    : t("ticket.selection.archive"),
                  disabled: !selection.size || bulk.isPending,
                  onPress: () => {
                    void apply({ archived: !restoreSelection }).catch(setError);
                  },
                },
                ...(access.canDelete
                  ? [
                      {
                        type: "action" as const,
                        label: t("ticket.selection.delete"),
                        destructive: true,
                        disabled: !selection.size || remove.isPending,
                        onPress: destroy,
                      },
                    ]
                  : []),
              ],
              { identifier: "selection-actions", visibilityPriority: "low" },
            ),
          ]
        : [
            ...(visibleTicket
              ? ticketHeaderItems(
                  access.canWrite
                    ? {
                        title: t("common.action.edit"),
                        onPress: () =>
                          navigation.navigate("Edit", { projectId, ticketId: visibleTicket.id }),
                      }
                    : undefined,
                  detailOnly
                    ? { title: t("ticket.selection.more"), onPress: moreTicketActions }
                    : undefined,
                )
              : []),
            ...(detailOnly
              ? []
              : ([
                  ...(access.canWrite && !visibleTicket
                    ? [
                        createHeaderAction(
                          t("native.screen.newTicket"),
                          newTicket,
                          { type: "sfSymbol", name: "plus" },
                          false,
                          { identifier: "ticket-create", visibilityPriority: "high" },
                        ),
                      ]
                    : []),
                  createHeaderMenu(
                    t("native.tickets.options"),
                    { type: "sfSymbol", name: "arrow.up.arrow.down" },
                    [
                      ...(visibleTicket && access.canWrite
                        ? [
                            {
                              type: "submenu" as const,
                              label: "",
                              inline: true,
                              items: [
                                {
                                  type: "action" as const,
                                  label: t("native.screen.newTicket"),
                                  icon: { type: "sfSymbol" as const, name: "plus" as const },
                                  onPress: newTicket,
                                },
                              ],
                            },
                          ]
                        : []),
                      ...sortItems,
                      {
                        type: "submenu",
                        label: t("ticket.list.views"),
                        icon: { type: "sfSymbol", name: "rectangle.3.group" },
                        items: viewItems,
                      },
                      ...(visibleTicket
                        ? [
                            {
                              type: "submenu" as const,
                              label: "",
                              inline: true,
                              items: [
                                {
                                  type: "action" as const,
                                  label: t("ticket.selection.more"),
                                  icon: { type: "sfSymbol" as const, name: "ticket" as const },
                                  onPress: moreTicketActions,
                                },
                              ],
                            },
                          ]
                        : []),
                    ],
                    {
                      identifier: "ticket-list-options",
                      visibilityPriority: "high",
                      ...(filterCount || query.trim()
                        ? { badge: { value: filterCount + (query.trim() ? 1 : 0) } }
                        : {}),
                    },
                  ),
                ] satisfies NativeStackHeaderItem[])),
          ],
    [
      selection.size,
      access.canDelete,
      access.canWrite,
      bulk.isPending,
      remove.isPending,
      restoreSelection,
      apply,
      destroy,
      navigation,
      projectId,
      visibleTicket,
      newTicket,
      moreTicketActions,
      selecting,
      viewItems,
      sortItems,
      query,
      filterCount,
      detailOnly,
    ],
  );
  useLayoutEffect(() => {
    navigation.setOptions(
      nativeHeaderOptions({
        title: selecting
          ? t("ticket.selection.selected", { count: selection.size })
          : detailOnly && selectedTicket
            ? selectedTicket.key
            : "",
        unstable_headerRightItems: () => headerItems,
        ...(layout === "list" || layout === "board"
          ? {
              headerBackVisible: false,
              unstable_headerLeftItems: () =>
                selecting
                  ? []
                  : [
                      ...projectHeaderItems(
                        showPicker,
                        t("native.navigation.switchProject"),
                        split && splitState.collapsed && splitState.secondaryVisible
                          ? {
                              title: t("ticket.list.tickets"),
                              onPress: () => {
                                setSplitState((state) => ({ ...state, secondaryVisible: false }));
                              },
                            }
                          : undefined,
                        title,
                      ),
                      ...(split &&
                      !splitState.collapsed &&
                      selectedTicket &&
                      splitState.secondaryVisible
                        ? [sidebarHeaderItem(() => setSidebarHidden((hidden) => !hidden))]
                        : []),
                    ],
            }
          : {}),
        headerSearchBarOptions: selecting || detailOnly ? undefined : searchOptions,
      }),
    );
  }, [
    navigation,
    headerItems,
    selection.size,
    title,
    layout,
    split,
    splitState,
    showPicker,
    searchOptions,
    selecting,
    selectedTicket,
    detailOnly,
  ]);
  const entries = sectionEntries(sections, collapsed, !!query.trim());
  const open = (ticket: Ticket) => {
    if (selecting) toggle(ticket);
    else if (split) {
      setSelectedTicketId(ticket.id);
      setSplitState((state) => ({ ...state, secondaryVisible: true }));
    } else navigation.navigate("Ticket", { projectId, ticketId: ticket.id });
  };
  const refresh = () =>
    planning ? Promise.all([backlog.refetch(), archived.refetch()]) : tickets.refetch();
  const collectionHeader = (
    <>
      {!detailOnly && (
        <>
          {!searching && (
            <RemovableSummary
              label={t("shell.app.clearSearch")}
              value={query}
              onClear={() => changeQuery("")}
            />
          )}
          {(filterCount > 0 || route.params.viewId) && (
            <RemovableSummary
              icon="filter-outline"
              value={
                views.data?.find((view) => view.id === route.params.viewId)?.name ??
                t("ticket.list.sectionCount", {
                  n: filterCount,
                  section: t("ticket.filter.filters"),
                })
              }
              label={t("ticket.filter.clear")}
              onClear={clearFilters}
            />
          )}
        </>
      )}
      <ErrorNotice error={views.error ?? listError} background={!!tickets.data || !!backlog.data} />
    </>
  );
  const collectionView =
    layout === "calendar" || layout === "timeline" ? (
      <TicketSchedule
        projectId={projectId}
        projectName={title}
        layout={layout}
        anchor={anchor}
        range={range ?? scheduleWindow(layout, anchor, firstWeekday())}
        onAnchor={setAnchor}
        loading={pending}
        tickets={rows}
        header={collectionHeader}
        onOpen={(ticket) => navigation.navigate("Ticket", { projectId, ticketId: ticket.id })}
      />
    ) : pending ? (
      <Scroll>
        {collectionHeader}
        <Loading />
      </Scroll>
    ) : listError && !rows.length ? (
      <Scroll>
        {collectionHeader}
        <View style={{ padding: 16 }}>
          <Button plain title={t("ticket.list.retry")} onPress={refresh} />
        </View>
      </Scroll>
    ) : !rows.length ? (
      <Scroll>
        {collectionHeader}
        <EmptyState
          title={t(
            filtered
              ? "ticket.list.emptyFiltered"
              : planning
                ? "ticket.list.emptyPlanning"
                : "ticket.list.emptyProject",
          )}
        >
          {query.trim() && (
            <Button plain title={t("shell.app.clearSearch")} onPress={() => changeQuery("")} />
          )}
          {filterCount > 0 && (
            <Button plain title={t("ticket.filter.clear")} onPress={clearFilters} />
          )}
          {!filtered && access.canWrite && (
            <Button
              plain
              title={t("ticket.list.createFirst")}
              onPress={() => navigation.navigate("Edit", { projectId })}
            />
          )}
        </EmptyState>
      </Scroll>
    ) : layout === "board" ? (
      <View style={{ flex: 1 }}>
        {collectionHeader}
        <Scroll
          horizontal
          decelerationRate="fast"
          snapToInterval={Math.min(340, Math.max(260, width - 100)) + 12}
          contentContainerStyle={{ gap: 12, paddingHorizontal: 4, paddingVertical: 8 }}
        >
          {sections.map((state) => (
            <View
              key={state.id}
              style={{
                width: Math.min(340, Math.max(260, width - 100)),
                backgroundColor: color.surface,
              }}
            >
              <View style={{ paddingHorizontal: 20 }}>
                <Heading
                  compact
                  leading={
                    <PropertyValue
                      projectId={projectId}
                      property="status"
                      value={state.category}
                      stateId={state.id}
                      iconOnly
                    />
                  }
                  count={state.tickets.length}
                >
                  {state.name}
                </Heading>
              </View>
              <List
                onRefresh={refresh}
                data={state.tickets}
                keyExtractor={(ticket) => ticket.id}
                renderItem={({ item: ticket }) => (
                  <TicketRow
                    ticket={ticket}
                    selected={selecting ? selection.has(ticket.id) : undefined}
                    selecting={selecting}
                    active={split && selectedTicketId === ticket.id}
                    showStatus={false}
                    onPress={() => open(ticket)}
                    onLongPress={() => setFocused(ticket)}
                  />
                )}
              />
            </View>
          ))}
        </Scroll>
      </View>
    ) : (
      <List
        data={entries}
        stickyHeaderIndices={sectionHeaderIndices(entries)}
        ListHeaderComponent={collectionHeader}
        {...(initial?.scrollOffset === undefined
          ? {}
          : { initialScrollOffset: initial.scrollOffset })}
        onScroll={(event) => {
          if (isFocused)
            contexts.save(projectId, { scrollOffset: event.nativeEvent.contentOffset.y });
        }}
        scrollEventThrottle={100}
        keyExtractor={(entry) => entry.id}
        onRefresh={refresh}
        renderItem={({ item }) =>
          "ticket" in item ? (
            <TicketRow
              ticket={item.ticket}
              selected={selecting ? selection.has(item.ticket.id) : undefined}
              selecting={selecting}
              showStatus={false}
              active={split && selectedTicketId === item.ticket.id}
              onPress={() => open(item.ticket)}
              onLongPress={() => setFocused(item.ticket)}
            />
          ) : (
            <Heading
              compact
              sticky
              disclosure={{
                expanded: !collapsed.has(item.sectionId),
                count: item.count,
                leading: (
                  <PropertyValue
                    projectId={projectId}
                    property="status"
                    value={
                      sections.find((section) => section.id === item.sectionId)?.category ?? "todo"
                    }
                    stateId={item.sectionId}
                    iconOnly
                  />
                ),
                label: t(
                  collapsed.has(item.sectionId)
                    ? "ticket.list.expandSection"
                    : "ticket.list.collapseSection",
                  { section: item.heading },
                ),
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
        ListFooterComponent={
          listError ? (
            <Button plain title={t("ticket.list.retry")} onPress={refresh} />
          ) : loadingMore || incomplete ? (
            <Loading />
          ) : (
            <View style={{ padding: 20 }}>
              <Body muted small>
                {t("ticket.list.count", { count: rows.length })}
              </Body>
            </View>
          )
        }
      />
    );
  const primaryContent = collectionView;
  return (
    <Screen
      scroll={false}
      scrollInsets={layout === "list" || layout === "timeline" || detailOnly}
      allowDivision={split || layout === "calendar"}
      background={project?.background ?? null}
    >
      <ErrorNotice error={error ?? bulk.error ?? remove.error ?? deleteView.error} />
      {split ? (
        <SplitView
          primary={primaryContent}
          primaryHeader={layout === "board" ? "frame" : "scroll"}
          secondaryHidden={layout === "board" && !selectedTicketId}
          secondaryActive={!!selectedTicketId && splitState.secondaryVisible}
          primaryHidden={sidebarHidden}
          onChange={setSplitState}
          secondary={
            selectedTicketId ? (
              <TicketContent
                key={selectedTicketId}
                projectId={projectId}
                ticketId={selectedTicketId}
                preview
                onUnavailable={() => {
                  setSelectedTicketId(undefined);
                  setSplitState((state) => ({ ...state, secondaryVisible: false }));
                }}
              />
            ) : (
              <Screen>
                <EmptyState title={t("ticket.picker.placeholder")} />
              </Screen>
            )
          }
        />
      ) : (
        primaryContent
      )}
      <Sheet
        title={t("ticket.list.views")}
        open={managingViews}
        onClose={() => setManagingViews(false)}
      >
        <Field
          label={t("shell.search.field")}
          labelHidden
          variant="search"
          placeholder={t("shell.search.placeholder")}
          value={viewQuery}
          onChangeText={setViewQuery}
        />
        {(views.data ?? [])
          .filter((view) => view.name.toLocaleLowerCase().includes(viewQuery.toLocaleLowerCase()))
          .map((view) => (
            <Row
              key={view.id}
              dense
              interaction="choice"
              title={view.name}
              selected={route.params.viewId === view.id}
              onPress={() => {
                setFilters(view.filters);
                changeQuery(view.filters.q ?? "");
                navigation.setParams({ viewId: view.id });
                setManagingViews(false);
              }}
              trailing={
                <Button
                  compact
                  plain
                  danger
                  title=""
                  accessibilityLabel={t("ticket.list.deleteView", { name: view.name })}
                  leading={<TicketGlyph name="trash-2" color={color.danger} />}
                  onPress={() =>
                    Alert.alert(
                      t("common.action.delete"),
                      t("ticket.list.deleteViewConfirm", { name: view.name }),
                      [
                        { text: t("common.action.cancel"), style: "cancel" },
                        {
                          text: t("common.action.delete"),
                          style: "destructive",
                          onPress: () => {
                            void removeView({ projectId, viewId: view.id })
                              .then(() => {
                                if (route.params.viewId === view.id)
                                  navigation.setParams({ viewId: "" });
                              })
                              .catch(setError);
                          },
                        },
                      ],
                    )
                  }
                />
              }
            />
          ))}
        <Button
          title={t("ticket.list.saveCurrentView")}
          onPress={() => {
            setName("");
            setSaving(true);
          }}
        />
      </Sheet>
      <Sheet
        title={t("ticket.filter.filters")}
        open={filtering}
        onClose={() => setFiltering(false)}
      >
        <TicketFilters projectId={projectId} value={filters} onChange={changeFilters} />
      </Sheet>
      <Sheet
        title={t("ticket.list.saveView")}
        open={saving}
        onClose={() => {
          if (!save.isPending) setSaving(false);
        }}
      >
        <Field label={t("ticket.list.viewName")} value={name} onChangeText={setName} />
        <ErrorNotice error={save.error} />
        <Button
          title={t("ticket.list.saveView")}
          primary
          disabled={!name.trim() || save.isPending}
          onPress={() => {
            void save
              .mutateAsync({ projectId, name, filters: { ...filters, q } })
              .then((view) => {
                setSaving(false);
                navigation.setParams({ viewId: view.id });
              })
              .catch(() => {});
          }}
        />
      </Sheet>
      <Sheet
        title={focused?.key ?? t("ticket.selection.more")}
        open={!!focused}
        onClose={() => setFocused(undefined)}
      >
        {focused && (
          <TicketActions
            ticket={focused}
            showOpen={
              !(
                selectedTicketId === focused.id &&
                split &&
                (!splitState.collapsed || splitState.secondaryVisible)
              )
            }
            onClose={() => setFocused(undefined)}
            onSelect={() => {
              toggle(focused);
              setSplitState((state) => ({ ...state, secondaryVisible: false }));
            }}
            {...(filters.sort === "manual" ? { order: rows } : {})}
          />
        )}
      </Sheet>
      <Sheet
        title={t("ticket.selection.fields")}
        open={bulkOpen}
        onClose={() => {
          if (!bulk.isPending) setBulkOpen(false);
        }}
      >
        <BulkProperties projectId={projectId} tickets={selectedTickets} onChange={apply} />
      </Sheet>
    </Screen>
  );
}

function TicketFilters({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: z.output<typeof ticketFilter>;
  onChange: (value: z.output<typeof ticketFilter>) => void;
}) {
  const { api } = useConnection(),
    color = usePalette();
  const members = useQuery(api.query("list_members", { projectId })),
    labels = useQuery(api.query("list_project_labels", { projectId })),
    fields = useQuery(api.query("list_custom_fields", { projectId }));
  const [added, setAdded] = useState<Partial<Record<FilterField, "any" | "none">>>({});
  const [error, setError] = useState<unknown>();
  function change(next: unknown) {
    const parsed = ticketFilter.safeParse(next);
    setError(parsed.success ? undefined : parsed.error);
    if (parsed.success) onChange(parsed.data);
  }
  const choices: Record<FilterField, { value: string; label: string }[]> = {
    status: states.map((state) => ({ value: state, label: stateLabels[state] })),
    priority: priorities.map((priority) => ({ value: priority, label: priorityLabels[priority] })),
    kind: kinds.map((kind) => ({ value: kind, label: kindLabels[kind] })),
    difficulty: difficulties.map((difficulty) => ({
      value: difficulty,
      label: difficultyLabels[difficulty],
    })),
    label: labelOptions(labels.data ?? []),
    assigneeId: [
      { value: "none", label: t("common.state.unassigned") },
      ...(members.data ?? []).map((member) => ({ value: member.userId, label: member.name })),
    ],
    customField: (fields.data ?? []).flatMap((field) => {
      const empty = {
        value: `${field.id}:none`,
        label: t("native.labelValue", { label: field.name, value: t("ticket.field.noValue") }),
      };
      const options =
        field.type === "checkbox"
          ? [
              {
                value: `${field.id}:true`,
                label: t("native.labelValue", {
                  label: field.name,
                  value: t("common.customField.checked"),
                }),
              },
            ]
          : field.options.map((option) => ({
              value: `${field.id}:${option.id}`,
              label: t("native.labelValue", { label: field.name, value: option.name }),
            }));
      return [empty, ...options];
    }),
  };
  return (
    <>
      <ErrorNotice error={error ?? members.error ?? labels.error ?? fields.error} />
      {filterFieldNames.flatMap((field) =>
        (["any", "none"] as const)
          .filter(
            (operator) =>
              filterList(value[filterKey(field, operator)]).length > 0 || added[field] === operator,
          )
          .map((operator) => {
            const key = filterKey(field, operator),
              selected = filterList(value[key]);
            return (
              <View
                key={`${field}:${operator}`}
                style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}
              >
                <Body small>{filterFieldLabels[field]}</Body>
                <Choice
                  compact
                  label={t("ticket.filter.match", { label: filterFieldLabels[field] })}
                  value={operator}
                  options={[
                    { value: "any", label: t("ticket.filter.is") },
                    { value: "none", label: t("ticket.filter.isNot") },
                  ]}
                  onChange={(next) => {
                    if (next === operator) return;
                    setAdded((previous) => ({
                      ...previous,
                      [field]: next === "none" ? "none" : "any",
                    }));
                    const other = filterKey(field, next === "none" ? "none" : "any"),
                      moved = [...new Set([...filterList(value[other]), ...selected])];
                    change({
                      ...value,
                      [key]: undefined,
                      [other]: moved.length ? moved : undefined,
                    });
                  }}
                />
                <Choice
                  compact
                  label={filterFieldLabels[field]}
                  value=""
                  selected={selected}
                  emptyLabel={t("ticket.list.all")}
                  options={choices[field]}
                  onChange={() => {}}
                  onToggle={(next) => {
                    const values = selected.includes(next)
                      ? selected.filter((item) => item !== next)
                      : [...selected, next];
                    const otherKey = filterKey(field, operator === "any" ? "none" : "any"),
                      excluded = filterList(value[otherKey]).filter((item) => item !== next);
                    change({
                      ...value,
                      [key]: values.length ? values : undefined,
                      [otherKey]: excluded.length ? excluded : undefined,
                    });
                  }}
                />
                <Button
                  compact
                  plain
                  title=""
                  accessibilityLabel={t("ticket.filter.clear")}
                  leading={<TicketGlyph name="x" color={color.muted} />}
                  onPress={() => {
                    change({ ...value, [key]: undefined });
                    setAdded((previous) => {
                      const next = { ...previous };
                      delete next[field];
                      return next;
                    });
                  }}
                />
              </View>
            );
          }),
      )}
      <Choice
        compact
        label={t("ticket.filter.add")}
        value=""
        emptyLabel={t("ticket.filter.add")}
        options={filterFieldNames
          .filter((field) => !added[field] && !filterList(value[filterKey(field, "any")]).length)
          .map((field) => ({ value: field, label: filterFieldLabels[field] }))}
        onChange={(next) => {
          const field = filterFieldNames.find((item) => item === next);
          if (field) setAdded((previous) => ({ ...previous, [field]: "any" }));
        }}
      />
      <Choice
        label={t("ticket.display.orderBy")}
        value={value.sort}
        options={ticketFilter.shape.sort
          .unwrap()
          .options.map((sort) => ({ value: sort, label: sortLabels[sort] }))}
        onChange={(sort) => onChange(ticketFilter.parse({ ...value, sort }))}
      />
      <Choice
        label={t("ticket.display.direction")}
        value={value.order ?? defaultOrder[value.sort]}
        options={[
          { value: "asc", label: t("ticket.display.ascending") },
          { value: "desc", label: t("ticket.display.descending") },
        ]}
        onChange={(order) => onChange(ticketFilter.parse({ ...value, order }))}
      />
      <Choice
        label={t("ticket.filter.due")}
        value={value.due ?? ""}
        options={[
          { value: "", label: t("ticket.filter.anyDue") },
          ...ticketFilter.shape.due
            .unwrap()
            .options.map((due) => ({ value: due, label: dueFilterLabels[due] })),
        ]}
        onChange={(due) => onChange(ticketFilter.parse({ ...value, due: due || undefined }))}
      />
      <Choice
        label={t("ticket.filter.archived")}
        value={value.archived}
        options={[
          { value: "exclude", label: t("ticket.filter.hideArchived") },
          { value: "include", label: t("ticket.filter.includeArchived") },
          { value: "only", label: t("ticket.filter.archivedOnly") },
        ]}
        onChange={(archived) => onChange(ticketFilter.parse({ ...value, archived }))}
      />
      <Button
        title={t("ticket.filter.reset")}
        onPress={() => {
          setAdded({});
          onChange(ticketFilter.parse({}));
        }}
      />
    </>
  );
}
