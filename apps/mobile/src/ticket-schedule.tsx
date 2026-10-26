import { useLayoutEffect, useMemo, useState } from "react";
import {
  I18nManager,
  Pressable,
  ScrollView,
  Text,
  View,
  useColorScheme,
  useWindowDimensions,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useQuery } from "@tanstack/react-query";
import {
  calendarDay,
  addCalendarDays,
  shiftAnchor,
  ticketSpan,
  calendarDistance,
  ticketScheduleText,
} from "@kanvil/contracts/schedule";
import { formatDate, formatNumber, formatList, t } from "@kanvil/contracts/i18n";
import { nativeStatusColor } from "@kanvil/contracts/colors";
import type { Ticket } from "@kanvil/contracts";
import { useConnection } from "./data.tsx";
import {
  nativeHeaderOptions,
  Body,
  Button,
  Heading,
  List,
  Loading,
  TicketRow,
  PropertyValue,
  TicketGlyph,
  Screen,
  Scroll,
  usePalette,
  useNativeViewport,
} from "./ui.tsx";
import { SplitView } from "./split-view.tsx";
import { useProjectNavigation } from "./navigation.ts";
import { projectHeaderItems } from "./navigation-actions.tsx";

export function TicketSchedule({
  projectId,
  layout,
  tickets,
  onOpen,
  anchor,
  range,
  onAnchor,
  loading,
}: {
  projectId: string;
  layout: "calendar" | "timeline";
  tickets: Ticket[];
  onOpen: (ticket: Ticket) => void;
  anchor: Date;
  range: { from: Date; to: Date };
  onAnchor: (date: Date) => void;
  loading: boolean;
}) {
  const navigation = useNavigation(),
    { showPicker } = useProjectNavigation(),
    { api } = useConnection();
  const [splitState, setSplitState] = useState({ collapsed: false, secondaryVisible: false });
  const [today] = useState(() => calendarDay(new Date())),
    [selected, setSelected] = useState(anchor),
    [showDay, setShowDay] = useState(false),
    [rowHeights, setRowHeights] = useState<Record<string, number>>({}),
    [headerHeights, setHeaderHeights] = useState({ identity: 0, days: 0 });
  const { fontScale } = useWindowDimensions();
  const headerHeight = Math.max(44, headerHeights.identity, headerHeights.days);
  // Measure inner content so both headers also shrink when the user restores text size.
  const measureHeader = (part: keyof typeof headerHeights, height: number) =>
    setHeaderHeights((previous) =>
      previous[part] === height ? previous : { ...previous, [part]: height },
    );
  const color = usePalette(),
    mode = useColorScheme() === "dark" ? "dark" : "light",
    viewport = useNativeViewport();
  const workflow = useQuery(api.query("list_workflow_states", { projectId }));
  const moveAnchor = (date: Date) => {
    setSelected(date);
    onAnchor(date);
  };
  const selectDay = (date: Date) => {
    moveAnchor(calendarDay(date));
    setShowDay(true);
    setSplitState((state) => ({ ...state, secondaryVisible: true }));
  };
  const spans = useMemo(() => {
    const entries = tickets.flatMap((ticket) => {
      const span = ticketSpan(ticket);
      return span && span.end >= range.from && span.start < range.to ? [{ ticket, ...span }] : [];
    });
    entries.sort((a, b) => a.start.getTime() - b.start.getTime());
    return entries;
  }, [tickets, range]);
  const dayTickets = spans
    .filter((span) => span.start <= selected && span.end >= selected)
    .map((span) => span.ticket);
  useLayoutEffect(() => {
    navigation.setOptions(
      nativeHeaderOptions({
        headerBackVisible: !(showDay && splitState.collapsed && splitState.secondaryVisible),
        unstable_headerLeftItems: () =>
          projectHeaderItems(
            showPicker,
            t("native.navigation.switchProject"),
            showDay && splitState.collapsed && splitState.secondaryVisible
              ? {
                  title: t("ticket.schedule.calendar"),
                  onPress: () => {
                    setShowDay(false);
                    setSplitState((state) => ({ ...state, secondaryVisible: false }));
                  },
                }
              : undefined,
          ),
      }),
    );
    return () =>
      navigation.setOptions(
        nativeHeaderOptions({
          headerBackVisible: true,
          unstable_headerLeftItems: () =>
            projectHeaderItems(showPicker, t("native.navigation.switchProject")),
        }),
      );
  }, [navigation, showDay, splitState, showPicker]);
  const controls = (
    <View style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 6 }}>
      <Heading compact>
        {layout === "calendar"
          ? formatDate(anchor, { month: "long", year: "numeric" })
          : t("ticket.schedule.range", {
              from: formatDate(range.from),
              to: formatDate(addCalendarDays(range.to, -1)),
            })}
      </Heading>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Button
          compact
          title=""
          accessibilityLabel={t(
            layout === "calendar"
              ? "ticket.schedule.previousMonth"
              : "ticket.schedule.previousWeeks",
          )}
          leading={
            <TicketGlyph
              name={I18nManager.isRTL ? "chevron-right" : "chevron-left"}
              color={color.muted}
            />
          }
          onPress={() => moveAnchor(shiftAnchor(layout, anchor, -1))}
        />
        <Button compact title={t("ticket.schedule.today")} onPress={() => moveAnchor(today)} />
        <Button
          compact
          title=""
          accessibilityLabel={t(
            layout === "calendar" ? "ticket.schedule.nextMonth" : "ticket.schedule.nextWeeks",
          )}
          leading={
            <TicketGlyph
              name={I18nManager.isRTL ? "chevron-left" : "chevron-right"}
              color={color.muted}
            />
          }
          onPress={() => moveAnchor(shiftAnchor(layout, anchor, 1))}
        />
      </View>
    </View>
  );
  if (layout === "timeline") {
    const days = Array.from({ length: calendarDistance(range.from, range.to) }, (_, index) =>
      addCalendarDays(range.from, index),
    );
    const dayWidth = 34 * Math.max(1, fontScale),
      chartWidth = days.length * dayWidth,
      identityWidth = Math.min(280, Math.max(160, viewport.bounds.width * 0.6));
    return (
      <Scroll>
        {controls}
        {loading ? (
          <Loading />
        ) : !spans.length ? (
          <View style={{ padding: 20 }}>
            <Body muted>{t("ticket.schedule.emptyWeeks")}</Body>
          </View>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
            <View style={{ width: identityWidth }}>
              <View
                style={{ height: headerHeight, paddingHorizontal: 12, justifyContent: "center" }}
              >
                <View
                  onLayout={(event) => measureHeader("identity", event.nativeEvent.layout.height)}
                >
                  <Heading compact>{t("ticket.schedule.ticketColumn")}</Heading>
                </View>
              </View>
              {spans.map(({ ticket }) => (
                <View
                  key={ticket.id}
                  onLayout={(event) => {
                    const height = event.nativeEvent.layout.height;
                    setRowHeights((previous) =>
                      previous[ticket.id] === height
                        ? previous
                        : { ...previous, [ticket.id]: height },
                    );
                  }}
                >
                  <TicketRow ticket={ticket} density="schedule" onPress={() => onOpen(ticket)} />
                </View>
              ))}
            </View>
            <ScrollView horizontal nestedScrollEnabled style={{ flex: 1, minWidth: 0 }}>
              <View style={{ width: chartWidth }}>
                <View style={{ height: headerHeight, justifyContent: "center" }}>
                  <View
                    style={{ flexDirection: "row", alignItems: "center" }}
                    onLayout={(event) => measureHeader("days", event.nativeEvent.layout.height)}
                  >
                    {days.map((day) => (
                      <View
                        key={day.toISOString()}
                        style={{ width: dayWidth, alignItems: "center" }}
                      >
                        <Text style={{ color: color.muted, fontSize: 10 }}>
                          {formatDate(day, { weekday: "narrow" })}
                        </Text>
                        <Text style={{ color: color.foreground, fontSize: 12 }}>
                          {formatNumber(day.getDate())}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>
                {spans.map((span) => {
                  const start = Math.max(0, calendarDistance(range.from, span.start)),
                    end = Math.min(days.length - 1, calendarDistance(range.from, span.end));
                  const tone = nativeStatusColor(
                    span.ticket.status,
                    workflow.data?.find((state) => state.id === span.ticket.stateId)?.color,
                    mode,
                    color,
                  );
                  return (
                    <View
                      key={span.ticket.id}
                      style={{
                        height: rowHeights[span.ticket.id] ?? 88,
                        justifyContent: "center",
                        borderBottomWidth: 0.5,
                        borderBottomColor: color.line,
                      }}
                    >
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t("native.labelValue", {
                          label: span.ticket.key,
                          value: formatList(
                            [span.ticket.title, ticketScheduleText(span.ticket)].filter(Boolean),
                          ),
                        })}
                        onPress={() => onOpen(span.ticket)}
                        style={{
                          marginStart: start * dayWidth,
                          width: Math.max(dayWidth, (end - start + 1) * dayWidth),
                          minHeight: 44,
                          justifyContent: "center",
                          paddingHorizontal: 6,
                          borderStartWidth: 2,
                          borderStartColor: tone,
                        }}
                      >
                        <View
                          pointerEvents="none"
                          style={{
                            position: "absolute",
                            inset: 0,
                            backgroundColor: tone,
                            opacity: 0.12,
                          }}
                        />
                        <PropertyValue
                          projectId={projectId}
                          property="status"
                          value={span.ticket.status}
                          stateId={span.ticket.stateId}
                          iconOnly
                        />
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        )}
      </Scroll>
    );
  }
  return (
    <SplitView
      secondaryActive={showDay && splitState.secondaryVisible}
      onChange={setSplitState}
      primary={
        <Screen scroll={false}>
          <Scroll>
            {controls}
            <CalendarMonth
              anchor={anchor}
              range={range}
              selected={selected}
              today={today}
              tickets={tickets}
              onSelect={selectDay}
            />
          </Scroll>
        </Screen>
      }
      secondary={
        <Screen scroll={false}>
          {loading ? (
            <Loading />
          ) : (
            <List
              data={dayTickets}
              ListHeaderComponent={
                <View style={{ padding: 20, gap: 4 }}>
                  <Heading>{formatDate(selected, { dateStyle: "full" })}</Heading>
                  <Body muted small>
                    {t("ticket.list.scheduledCount", { count: dayTickets.length })}
                  </Body>
                </View>
              }
              keyExtractor={(ticket) => ticket.id}
              ListEmptyComponent={
                <View style={{ padding: 20 }}>
                  <Body muted>{t("ticket.list.emptyFiltered")}</Body>
                </View>
              }
              renderItem={({ item }) => <TicketRow ticket={item} onPress={() => onOpen(item)} />}
            />
          )}
        </Screen>
      }
    />
  );
}

// Native date inputs edit dates; this work calendar shows density and an accessible day agenda.
function CalendarMonth({
  anchor,
  range,
  selected,
  today,
  tickets,
  onSelect,
}: {
  anchor: Date;
  range: { from: Date; to: Date };
  selected: Date;
  today: Date;
  tickets: Ticket[];
  onSelect: (date: Date) => void;
}) {
  const color = usePalette(),
    viewport = useNativeViewport();
  const width = Math.max(7 * 44, viewport.bounds.width - 16);
  const days = Array.from({ length: calendarDistance(range.from, range.to) }, (_, index) =>
    addCalendarDays(range.from, index),
  );
  const spans = tickets.flatMap((ticket) => {
    const span = ticketSpan(ticket);
    return span ? [span] : [];
  });
  return (
    <ScrollView horizontal contentContainerStyle={{ paddingHorizontal: 8 }}>
      <View style={{ width }}>
        <View style={{ flexDirection: "row" }}>
          {days.slice(0, 7).map((day) => (
            <View
              key={day.toISOString()}
              style={{ width: width / 7, minHeight: 28, alignItems: "center" }}
            >
              <Text style={{ color: color.muted, fontSize: 12 }}>
                {formatDate(day, { weekday: "narrow" })}
              </Text>
            </View>
          ))}
        </View>
        {Array.from({ length: Math.ceil(days.length / 7) }, (_, week) => (
          <View key={week} style={{ flexDirection: "row", alignItems: "stretch" }}>
            {days.slice(week * 7, week * 7 + 7).map((day) => {
              const count = spans.filter((span) => span.start <= day && span.end >= day).length,
                active = calendarDistance(selected, day) === 0,
                isToday = calendarDistance(today, day) === 0;
              return (
                <Pressable
                  key={day.toISOString()}
                  accessibilityRole="button"
                  accessibilityLabel={t("ticket.schedule.showDay", {
                    day: formatDate(day, { dateStyle: "full" }),
                    count,
                  })}
                  accessibilityState={{ selected: active }}
                  onPress={() => onSelect(day)}
                  style={({ pressed }) => ({
                    width: width / 7,
                    minHeight: 56,
                    paddingVertical: 6,
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 3,
                    borderRadius: 8,
                    borderWidth: isToday ? 1 : 0,
                    borderColor: color.accent,
                    backgroundColor: active || pressed ? color.accentSurface : "transparent",
                    opacity: day.getMonth() === anchor.getMonth() ? 1 : 0.45,
                  })}
                >
                  <Text
                    style={{
                      color: active || isToday ? color.accent : color.foreground,
                      fontSize: 16,
                      fontWeight: active || isToday ? "600" : "400",
                    }}
                  >
                    {formatNumber(day.getDate())}
                  </Text>
                  {count > 0 && (
                    <Text style={{ color: color.accent, fontSize: 10, fontWeight: "600" }}>
                      {formatNumber(count)}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
