import { useIsFocused } from "@react-navigation/native";
import { calendarDay, scheduleWindow } from "@kanvil/contracts/schedule";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { Alert, Platform, ScrollView, View, useWindowDimensions } from "react-native";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
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
import { useConnection, useAllProjects, useOperation, useProjectAccess } from "./data.tsx";
import {
  nativeHeaderOptions,
  Body,
  Button,
  Choice,
  ErrorNotice,
  Field,
  Heading,
  List,
  Loading,
  Screen,
  Scroll,
  Section,
  Sheet,
  TicketRow,
  usePalette,
  RemovableSummary,
} from "./ui.tsx";
import { createHeaderAction, projectHeaderItems } from "./navigation-actions.tsx";
import { TicketActions, BulkProperties } from "./ticket-actions.tsx";
import { TicketSchedule } from "./ticket-schedule.tsx";
import { TicketContent } from "./ticket-detail.tsx";
import { SplitView } from "./split-view.tsx";
import { useHeaderSearch, useProjectNavigation, type ScreenProps } from "./navigation.ts";
import { ticketSections, sectionEntries } from "./ticket-sections.ts";

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
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isError } = result;
  useEffect(() => {
    if (enabled && hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [enabled, hasNextPage, isFetchingNextPage, fetchNextPage, isError]);
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
  const [splitState, setSplitState] = useState({
    collapsed: false,
    secondaryVisible: initial?.secondaryVisible ?? !!initial?.selectedTicketId,
  });
  const views = useQuery(api.query("list_views", { projectId })),
    workflow = useQuery(api.query("list_workflow_states", { projectId }));
  const [filters, setFilters] = useState(() => ticketFilter.parse(initial?.filters ?? {})),
    [query, setQuery] = useState(initial?.query ?? ""),
    [filtering, setFiltering] = useState(false),
    [saving, setSaving] = useState(false),
    [name, setName] = useState(""),
    [focused, setFocused] = useState<Ticket>(),
    [selectedTicketId, setSelectedTicketId] = useState(initial?.selectedTicketId),
    [selection, setSelection] = useState<Map<string, Ticket>>(() => new Map()),
    [bulkOpen, setBulkOpen] = useState(false),
    [selecting, setSelecting] = useState(false),
    [error, setError] = useState<unknown>();
  const layout = route.params.layout ?? "list",
    planning = route.params.collection === "planning";
  const split =
    Platform.OS === "ios" && Number.parseInt(Platform.Version, 10) >= 26 && layout === "list";
  const q = useDeferredValue(query);
  const collection = planning ? "planning" : "all";
  const [normalCollapsed, setNormalCollapsed] = useState(
    () => new Set(initial?.collapsedSections?.[collection] ?? []),
  );
  const [searchCollapsed, setSearchCollapsed] = useState<{ query: string; ids: Set<string> }>({
    query: "",
    ids: new Set(),
  });
  const onQuery = useCallback((value: string) => {
    setQuery(value);
    setSearchCollapsed({ query: value, ids: new Set() });
  }, []);
  const {
    options: searchOptions,
    setText: changeQuery,
    searching,
  } = useHeaderSearch(query, onQuery, t("native.tickets.searchPlaceholder"));
  const collapsed = query.trim()
    ? searchCollapsed.query === query
      ? searchCollapsed.ids
      : new Set<string>()
    : normalCollapsed;
  const changeCollapsed = useCallback(
    (ids: Set<string>) => {
      if (query.trim()) setSearchCollapsed({ query, ids });
      else setNormalCollapsed(ids);
    },
    [query],
  );

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
  const sections = useMemo(() => ticketSections(rows, workflow.data), [rows, workflow.data]);
  const selected = useQuery({
    ...api.query("get_ticket", { projectId, ticketId: selectedTicketId ?? "none" }),
    enabled: !!selectedTicketId,
  });
  const selectedTicket = rows.find((item) => item.id === selectedTicketId) ?? selected.data?.ticket;
  useEffect(() => {
    if (isFocused)
      contexts.save(projectId, {
        filters,
        query,
        anchor,
        selectedTicketId,
        secondaryVisible: splitState.secondaryVisible,
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
              {
                type: "sfSymbol",
                name: "xmark",
              },
            ),
            createHeaderAction(
              t("ticket.selection.fields"),
              () => setBulkOpen(true),
              { type: "sfSymbol", name: "slider.horizontal.3" },
              bulk.isPending || !selection.size,
            ),
            {
              type: "menu",
              label: t("ticket.selection.more"),
              icon: { type: "sfSymbol", name: "ellipsis" },
              menu: {
                items: [
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
              },
            },
          ]
        : [
            ...(selectedTicket && split && (!splitState.collapsed || splitState.secondaryVisible)
              ? [
                  ...(access.canWrite
                    ? [
                        createHeaderAction(
                          t("common.action.edit"),
                          () =>
                            navigation.navigate("Edit", { projectId, ticketId: selectedTicket.id }),
                          { type: "sfSymbol", name: "square.and.pencil" },
                        ),
                      ]
                    : []),
                  createHeaderAction(
                    t("ticket.selection.more"),
                    () =>
                      setFocused(
                        rows.find((ticket) => ticket.id === selectedTicket.id) ?? selectedTicket,
                      ),
                    { type: "sfSymbol", name: "ellipsis" },
                  ),
                ]
              : []),
            ...(split && splitState.collapsed && splitState.secondaryVisible
              ? []
              : ([
                  createHeaderAction(
                    t("native.screen.newTicket"),
                    () => navigation.navigate("Edit", { projectId }),
                    { type: "sfSymbol", name: "plus" },
                    !access.canWrite,
                  ),
                  {
                    type: "menu",
                    label: t("ticket.list.views"),
                    accessibilityLabel: t("ticket.list.views"),
                    icon: { type: "sfSymbol", name: "ellipsis" },
                    menu: {
                      items: [
                        {
                          type: "action",
                          label: t("ticket.filter.filters"),
                          onPress: () => setFiltering(true),
                        },
                        {
                          type: "action",
                          label: t("native.tickets.select"),
                          disabled: !rows.length || !access.canWrite,
                          onPress: () => setSelecting(true),
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
                                onPress: () =>
                                  changeCollapsed(new Set(sections.map((section) => section.id))),
                              },
                            ]
                          : []),
                        {
                          type: "submenu",
                          label: t("ticket.display.layout"),
                          items: ticketLayouts.map((value) => ({
                            type: "action",
                            label:
                              value === "calendar" || value === "timeline"
                                ? t(`ticket.schedule.${value}`)
                                : t(`ticket.display.${value}`),
                            state: value === layout ? "on" : "off",
                            onPress: () => navigation.setParams({ layout: value }),
                          })),
                        },
                        {
                          type: "action",
                          label: t("ticket.list.allTickets"),
                          state: planning ? "off" : "on",
                          onPress: () => navigation.setParams({ collection: "all" }),
                        },
                        {
                          type: "action",
                          label: t("ticket.list.planningLink"),
                          state: planning ? "on" : "off",
                          onPress: () => navigation.setParams({ collection: "planning" }),
                        },
                        ...(views.data ?? []).map((view) => ({
                          type: "action" as const,
                          label: view.name,
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
                        ...(route.params.viewId
                          ? [
                              {
                                type: "action" as const,
                                label: t("ticket.list.deleteView", {
                                  name:
                                    views.data?.find((view) => view.id === route.params.viewId)
                                      ?.name ?? "",
                                }),
                                destructive: true,
                                onPress: () =>
                                  Alert.alert(
                                    t("common.action.delete"),
                                    t("ticket.list.deleteViewConfirm", {
                                      name:
                                        views.data?.find((view) => view.id === route.params.viewId)
                                          ?.name ?? "",
                                    }),
                                    [
                                      { text: t("common.action.cancel"), style: "cancel" },
                                      {
                                        text: t("common.action.confirm"),
                                        style: "destructive",
                                        onPress: () => {
                                          if (route.params.viewId)
                                            void removeView({
                                              projectId,
                                              viewId: route.params.viewId,
                                            })
                                              .then(() => navigation.setParams({ viewId: "" }))
                                              .catch(() => {});
                                        },
                                      },
                                    ],
                                  ),
                              },
                            ]
                          : []),
                      ],
                    },
                  },
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
      layout,
      planning,
      views.data,
      route.params.viewId,
      removeView,
      selectedTicket,
      splitState,
      split,
      rows,
      changeQuery,
      selecting,
      changeCollapsed,
      sections,
    ],
  );
  useLayoutEffect(() => {
    navigation.setOptions(
      nativeHeaderOptions({
        title: selecting ? t("ticket.selection.selected", { count: selection.size }) : title,
        unstable_headerRightItems: () => headerItems,
        ...(layout === "list" || layout === "board"
          ? {
              headerBackVisible: !(split && splitState.collapsed && splitState.secondaryVisible),
              unstable_headerLeftItems: () =>
                projectHeaderItems(
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
                ),
            }
          : {}),
        headerSearchBarOptions:
          selecting || (split && splitState.collapsed && splitState.secondaryVisible)
            ? undefined
            : searchOptions,
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
  ]);
  const entries = sectionEntries(sections, collapsed, !!query.trim());
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
  const open = (ticket: Ticket) => {
    if (selecting) toggle(ticket);
    else if (split) {
      setSelectedTicketId(ticket.id);
      setSplitState((state) => ({ ...state, secondaryVisible: true }));
    } else navigation.navigate("Ticket", { projectId, ticketId: ticket.id });
  };
  const refresh = () => {
    void (planning ? Promise.all([backlog.refetch(), archived.refetch()]) : tickets.refetch());
  };
  const collectionView =
    layout === "calendar" || layout === "timeline" ? (
      <TicketSchedule
        layout={layout}
        anchor={anchor}
        range={range ?? scheduleWindow(layout, anchor, firstWeekday())}
        onAnchor={setAnchor}
        loading={pending}
        tickets={rows}
        onOpen={(ticket) => navigation.navigate("Ticket", { projectId, ticketId: ticket.id })}
      />
    ) : pending ? (
      <Loading />
    ) : listError && !rows.length ? (
      <View style={{ padding: 24 }}>
        <Button plain title={t("ticket.list.retry")} onPress={refresh} />
      </View>
    ) : !rows.length ? (
      <View style={{ padding: 24, gap: 12 }}>
        <Body muted>
          {t(
            filtered
              ? "ticket.list.emptyFiltered"
              : planning
                ? "ticket.list.emptyPlanning"
                : "ticket.list.emptyProject",
          )}
        </Body>
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
      </View>
    ) : layout === "board" ? (
      <Scroll horizontal contentContainerStyle={{ gap: 18, padding: 18 }}>
        {sections.map((state) => (
          <View
            key={state.id}
            style={{
              width: Math.min(340, Math.max(260, width - 100)),
              backgroundColor: color.surface,
            }}
          >
            <Heading compact>{state.name}</Heading>
            <ScrollView>
              {state.tickets.map((ticket) => (
                <TicketRow
                  key={ticket.id}
                  ticket={ticket}
                  selected={selecting ? selection.has(ticket.id) : undefined}
                  selecting={selecting}
                  showStatus={false}
                  onPress={() => open(ticket)}
                  onLongPress={() => setFocused(ticket)}
                />
              ))}
            </ScrollView>
          </View>
        ))}
      </Scroll>
    ) : (
      <List
        data={entries}
        initialScrollOffset={initial?.scrollOffset ?? 0}
        onScroll={(event) => {
          if (isFocused)
            contexts.save(projectId, { scrollOffset: event.nativeEvent.contentOffset.y });
        }}
        scrollEventThrottle={100}
        keyExtractor={(entry) => entry.id}
        onRefresh={refresh}
        refreshing={planning ? backlog.isRefetching || archived.isRefetching : tickets.isRefetching}
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
              disclosure={{
                expanded: !collapsed.has(item.sectionId),
                count: item.count,
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
  return (
    <Screen
      scroll={false}
      allowDivision={split || layout === "calendar"}
      background={project?.background ?? null}
    >
      {!(split && splitState.collapsed && splitState.secondaryVisible) && (
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
      <ErrorNotice
        error={error ?? bulk.error ?? remove.error ?? deleteView.error ?? views.error ?? listError}
      />
      {split ? (
        <SplitView
          primary={collectionView}
          secondaryActive={!!selectedTicketId && splitState.secondaryVisible}
          onChange={setSplitState}
          secondary={
            selectedTicket ? (
              <TicketContent
                key={selectedTicket.id}
                projectId={projectId}
                ticketId={selectedTicket.id}
                preview
                onUnavailable={() => setSelectedTicketId(undefined)}
              />
            ) : (
              <View style={{ padding: 24 }}>
                <Body muted>{t("ticket.picker.placeholder")}</Body>
              </View>
            )
          }
        />
      ) : (
        collectionView
      )}
      <Sheet
        title={t("ticket.filter.filters")}
        open={filtering}
        onClose={() => setFiltering(false)}
      >
        <TicketFilters projectId={projectId} value={filters} onChange={setFilters} />
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
  const { api } = useConnection();
  const members = useQuery(api.query("list_members", { projectId })),
    labels = useQuery(api.query("list_ticket_labels", { projectId })),
    fields = useQuery(api.query("list_custom_fields", { projectId }));
  const [operators, setOperators] = useState<Partial<Record<FilterField, "any" | "none">>>({});
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
    label: (labels.data ?? []).map((label) => ({ value: label.name, label: label.name })),
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
      {filterFieldNames.map((field) => {
        const operator = operators[field] ?? "any",
          key = filterKey(field, operator),
          selected = filterList(value[key]);
        return (
          <Section key={field} title={filterFieldLabels[field]}>
            <Choice
              label={t("ticket.filter.match", { label: filterFieldLabels[field] })}
              value={operator}
              options={[
                { value: "any", label: t("ticket.filter.is") },
                { value: "none", label: t("ticket.filter.isNot") },
              ]}
              onChange={(next) =>
                setOperators((previous) => ({
                  ...previous,
                  [field]: next === "none" ? "none" : "any",
                }))
              }
            />
            <Choice
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
          </Section>
        );
      })}
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
      <Button title={t("ticket.filter.reset")} onPress={() => onChange(ticketFilter.parse({}))} />
    </>
  );
}
