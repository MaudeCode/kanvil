import { useLayoutEffect, useMemo, useState } from "react";
import { Platform, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useNavigation } from "@react-navigation/native";
import {
  calendarDay,
  addCalendarDays,
  shiftAnchor,
  ticketSpan,
  calendarDistance,
} from "@kanvil/contracts/schedule";
import { formatDate, formatNumber, t } from "@kanvil/contracts/i18n";
import type { Ticket } from "@kanvil/contracts";
import {
  nativeHeaderOptions,
  Body,
  Button,
  Heading,
  List,
  Loading,
  Row,
  Status,
  TicketRow,
  NativeDatePicker,
  DateField,
  Screen,
  Scroll,
  usePalette,
} from "./ui.tsx";
import { SplitView } from "./split-view.tsx";
import { createHeaderAction } from "./navigation-actions.tsx";

export function TicketSchedule({
  layout,
  tickets,
  onOpen,
  anchor,
  range,
  onAnchor,
  loading,
}: {
  layout: "calendar" | "timeline";
  tickets: Ticket[];
  onOpen: (ticket: Ticket) => void;
  anchor: Date;
  range: { from: Date; to: Date };
  onAnchor: (date: Date) => void;
  loading: boolean;
}) {
  const navigation = useNavigation(),
    { width } = useWindowDimensions();
  const [today] = useState(() => calendarDay(new Date())),
    [selected, setSelected] = useState(anchor),
    [showDay, setShowDay] = useState(false);
  const color = usePalette();
  const moveAnchor = (date: Date) => {
    setSelected(date);
    onAnchor(date);
  };
  const selectDay = (date: Date) => {
    moveAnchor(calendarDay(date));
    setShowDay(true);
  };
  const spans = useMemo(() => {
    const entries = tickets.flatMap((ticket) => {
      const span = ticketSpan(ticket);
      return span && span.end >= range.from && span.start < range.to ? [{ ticket, ...span }] : [];
    });
    // This derived array is private; Hermes does not provide Array.toSorted.
    entries.sort((a, b) => a.start.getTime() - b.start.getTime());
    return entries;
  }, [tickets, range]);
  const dayTickets = spans
    .filter((span) => span.start <= selected && span.end >= selected)
    .map((span) => span.ticket);
  useLayoutEffect(() => {
    navigation.setOptions(
      nativeHeaderOptions({
        headerBackVisible: !(showDay && width < 740),
        unstable_headerLeftItems: () =>
          showDay && width < 740
            ? [
                createHeaderAction(t("ticket.schedule.calendar"), () => setShowDay(false), {
                  type: "sfSymbol",
                  name: "calendar",
                }),
              ]
            : [],
      }),
    );
    return () =>
      navigation.setOptions(
        nativeHeaderOptions({ headerBackVisible: true, unstable_headerLeftItems: () => [] }),
      );
  }, [navigation, showDay, width]);
  const controls = (
    <View style={{ padding: 16, gap: 12 }}>
      <Heading compact>
        {layout === "calendar"
          ? formatDate(anchor, { month: "long", year: "numeric" })
          : t("ticket.schedule.range", {
              from: formatDate(range.from),
              to: formatDate(addCalendarDays(range.to, -1)),
            })}
      </Heading>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          compact
          title={
            layout === "calendar"
              ? t("ticket.schedule.previousMonth")
              : t("ticket.schedule.previousWeeks")
          }
          onPress={() => moveAnchor(shiftAnchor(layout, anchor, -1))}
        />
        <Button
          compact
          title={t("ticket.schedule.today")}
          onPress={() => {
            onAnchor(today);
            setSelected(today);
          }}
        />
        <Button
          compact
          title={
            layout === "calendar" ? t("ticket.schedule.nextMonth") : t("ticket.schedule.nextWeeks")
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
    const columnWidth = 34,
      chartWidth = days.length * columnWidth;
    return (
      <Scroll>
        {controls}
        {loading ? (
          <Loading />
        ) : spans.length ? (
          <ScrollView horizontal contentContainerStyle={{ paddingHorizontal: 16 }}>
            <View style={{ width: chartWidth + 260 }}>
              <View style={{ flexDirection: "row", paddingLeft: 240, paddingBottom: 10 }}>
                {days.map((day) => (
                  <View
                    key={day.toISOString()}
                    style={{ width: columnWidth, alignItems: "center" }}
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
              {spans.map((span) => {
                const start = Math.max(0, calendarDistance(range.from, span.start)),
                  end = Math.min(days.length - 1, calendarDistance(range.from, span.end));
                return (
                  <Row
                    key={span.ticket.id}
                    title={span.ticket.title}
                    overline={span.ticket.key}
                    caption={t("ticket.schedule.range", {
                      from: formatDate(span.start),
                      to: formatDate(span.end),
                    })}
                    style={{ gap: 0 }}
                    trailing={
                      <View style={{ width: chartWidth, height: 36, justifyContent: "center" }}>
                        <View
                          style={{
                            marginLeft: start * columnWidth,
                            width: Math.max(columnWidth, (end - start + 1) * columnWidth),
                            padding: 5,
                            borderLeftWidth: 2,
                            borderLeftColor: color.accent,
                            backgroundColor: color.accentSurface,
                          }}
                        >
                          <Status ticket={span.ticket} />
                        </View>
                      </View>
                    }
                    onPress={() => onOpen(span.ticket)}
                  />
                );
              })}
            </View>
          </ScrollView>
        ) : (
          <View style={{ padding: 20 }}>
            <Body muted>{t("ticket.schedule.emptyWeeks")}</Body>
          </View>
        )}
      </Scroll>
    );
  }
  return (
    <SplitView
      secondaryActive={showDay}
      primary={
        <Screen>
          <View style={{ padding: 16 }}>
            <Button
              compact
              title={t("ticket.schedule.today")}
              onPress={() => {
                onAnchor(today);
                setSelected(today);
                setShowDay(true);
              }}
            />
          </View>
          {Platform.OS === "ios" ? (
            <NativeDatePicker
              value={selected}
              onChange={(event, date) => {
                if (event.type === "set" && date) {
                  selectDay(date);
                }
              }}
            />
          ) : (
            <DateField
              label={t("ticket.schedule.calendar")}
              value={selected.toISOString()}
              dayBoundary="start"
              clearable={false}
              onChange={(value) => {
                if (value) selectDay(new Date(value));
              }}
            />
          )}
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
                <View style={{ padding: 20 }}>
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
