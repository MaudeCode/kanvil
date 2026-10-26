import type { ComponentProps } from "react";
import { tintedSurface } from "@kanvil/contracts/themes";
import { Text, View, useColorScheme } from "react-native";
import Svg, { Rect, SvgXml } from "react-native-svg";
import { useQuery } from "@tanstack/react-query";
import {
  iconFromLibrary,
  difficultySegments,
  ticketSymbols,
  type TicketPropertyName,
} from "@kanvil/contracts/icons";
import { nativeAccentColor, nativeStatusColor } from "@kanvil/contracts/colors";
import {
  difficultyLabels,
  kindLabels,
  priorityLabels,
  stateLabels,
  memberName,
  type Ticket,
  type LabelColor,
} from "@kanvil/contracts";
import { avatarInitials } from "@kanvil/contracts/users";
import { t } from "@kanvil/contracts/i18n";
import { useConnection, useIdentity } from "./data.tsx";
import { useNativePalette } from "./theme.ts";
import { useIconLibrary } from "./icon-library.ts";
import { AccountImage } from "./image.tsx";

// Native SVG adapter for the same installed Lucide glyphs used by the website.
export function TicketGlyph({
  name,
  color,
  size = 16,
  weight = 2,
}: {
  name: string;
  color: string;
  size?: number;
  weight?: number;
}) {
  const library = useIconLibrary();
  const body = iconFromLibrary(library.data, name)?.body;
  return (
    <View
      style={{ width: size, height: size, flexShrink: 0 }}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {body && (
        <SvgXml
          width={size}
          height={size}
          color={color}
          xml={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body.replaceAll('stroke-width="2"', `stroke-width="${weight}"`)}</svg>`}
        />
      )}
    </View>
  );
}

export function UserAvatar({
  name,
  image,
  size = 20,
}: {
  name: string;
  image?: string | null;
  size?: number;
}) {
  const color = useNativePalette();
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: "hidden",
        backgroundColor: color.accentSurface,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: color.accent, fontSize: size * 0.42, fontWeight: "600" }}>
        {avatarInitials(name)}
      </Text>
      {image && (
        <AccountImage
          uri={image}
          style={{ position: "absolute", width: size, height: size, borderRadius: size / 2 }}
        />
      )}
    </View>
  );
}

type Property = {
  [P in TicketPropertyName]: {
    property: P;
    value: Ticket[P extends "assignee" ? "assigneeId" : P];
  };
}[TicketPropertyName];
// One catalog/wording path serves visual values and the complete spoken ticket summary.
export function useTicketCatalog(
  projectId: string,
  stateId?: string | null,
  assigneeId?: string | null,
) {
  const { api } = useConnection(),
    identity = useIdentity();
  const workflow = useQuery({
    ...api.query("list_workflow_states", { projectId }),
    enabled: !!stateId,
  });
  const members = useQuery({
    ...api.query("list_members", { projectId }),
    enabled: !!assigneeId && assigneeId !== identity.id,
  });
  const deleted = useQuery({
    ...api.query("list_deleted_accounts", {}),
    enabled:
      !!assigneeId &&
      assigneeId !== identity.id &&
      !!members.data &&
      !members.data.some((person) => person.userId === assigneeId),
  });
  return { states: workflow.data, people: members.data, deleted: deleted.data, identity };
}
export function propertyText(
  props: Property & { stateId?: string | null | undefined },
  catalog: ReturnType<typeof useTicketCatalog>,
) {
  switch (props.property) {
    case "status":
      return (
        catalog.states?.find((state) => state.id === props.stateId)?.name ??
        stateLabels[props.value]
      );
    case "priority":
      return priorityLabels[props.value];
    case "kind":
      return kindLabels[props.value];
    case "difficulty":
      return props.value ? difficultyLabels[props.value] : t("common.difficulty.none");
    case "assignee":
      return !props.value
        ? t("common.state.unassigned")
        : props.value === catalog.identity.id
          ? catalog.identity.name
          : memberName(catalog.people, catalog.deleted, props.value);
  }
  return t("ticket.field.noValue");
}
export function propertyDescription(
  props: Property & { stateId?: string | null | undefined },
  catalog: ReturnType<typeof useTicketCatalog>,
) {
  return t("native.labelValue", {
    label: t(`ticket.property.${props.property}`),
    value: propertyText(props, catalog),
  });
}

// Read-only sibling of TicketProperties. Every native ticket value shares its symbol and wording.
export function PropertyValue({
  projectId,
  stateId,
  iconOnly = false,
  ...props
}: Property & { projectId: string; stateId?: string | null; iconOnly?: boolean }) {
  const color = useNativePalette(),
    mode = useColorScheme() === "dark" ? "dark" : "light";
  const catalog = useTicketCatalog(
    projectId,
    props.property === "status" ? stateId : null,
    props.property === "assignee" ? props.value : null,
  );
  const name = propertyText({ ...props, stateId }, catalog);
  let tone: string, glyph;
  if (props.property === "difficulty") {
    tone = props.value ? color.foreground : color.muted;
    glyph = (
      <Svg
        width={16}
        height={16}
        viewBox="0 0 16 16"
        accessible={false}
        accessibilityElementsHidden
      >
        {difficultySegments(props.value).map((segment) => (
          <Rect key={segment.x} {...segment} fill={tone} />
        ))}
      </Svg>
    );
  } else if (props.property === "assignee") {
    const person = catalog.people?.find((member) => member.userId === props.value);
    tone = color.muted;
    glyph = props.value ? (
      <UserAvatar
        name={name}
        image={
          props.value === catalog.identity.id ? catalog.identity.image : (person?.image ?? null)
        }
      />
    ) : (
      <TicketGlyph name="circle-user-round" color={tone} />
    );
  } else {
    const symbol =
      props.property === "status"
        ? ticketSymbols.status[props.value]
        : props.property === "priority"
          ? ticketSymbols.priority[props.value]
          : ticketSymbols.kind[props.value];
    const state =
      props.property === "status"
        ? catalog.states?.find((entry) => entry.id === stateId)
        : undefined;
    tone =
      props.property === "status"
        ? nativeStatusColor(props.value, state?.color, mode, color)
        : color[symbol.tone];
    glyph = (
      <TicketGlyph
        name={symbol.icon}
        color={tone}
        weight={props.property === "priority" ? 2.5 : 2}
      />
    );
  }
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={propertyDescription({ ...props, stateId }, catalog)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        flexShrink: 1,
        minWidth: 0,
        ...(!iconOnly && props.property === "status"
          ? {
              backgroundColor: tintedSurface(color.surface, color.foreground, tone),
              paddingHorizontal: 7,
              paddingVertical: 3,
              borderRadius: 6,
            }
          : {}),
      }}
    >
      {glyph}
      {!iconOnly && (
        <Text
          style={{
            color: props.property === "status" ? color.foreground : tone,
            fontSize: 13,
            lineHeight: 18,
            flexShrink: 1,
          }}
        >
          {name}
        </Text>
      )}
    </View>
  );
}

// Choices extend the same value renderer with native-menu geometry, without another property table.
export function propertyOption({
  optionValue,
  label,
  ...value
}: ComponentProps<typeof PropertyValue> & { optionValue: string; label: string }) {
  const symbol =
    value.property === "status"
      ? ticketSymbols.status[value.value].icon
      : value.property === "priority"
        ? ticketSymbols.priority[value.value].icon
        : value.property === "kind"
          ? ticketSymbols.kind[value.value].icon
          : value.property === "difficulty"
            ? "chart-bar"
            : "circle-user-round";
  return { value: optionValue, label, symbol, leading: <PropertyValue {...value} iconOnly /> };
}

// Labels retain catalog colors; scopes use the same renderer with an outline and no dot.
export function TicketTag({
  tag,
  color: labelColor = "gray",
  kind = "label",
  indicatorOnly = false,
  onLayout,
}: {
  tag: string;
  color?: LabelColor;
  kind?: "label" | "scope";
  indicatorOnly?: boolean;
  onLayout?: ComponentProps<typeof View>["onLayout"];
}) {
  const color = useNativePalette(),
    mode = useColorScheme() === "dark" ? "dark" : "light";
  if (indicatorOnly)
    return (
      <View
        accessible={false}
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          backgroundColor: nativeAccentColor(labelColor, mode, color),
        }}
      />
    );
  return (
    <View
      onLayout={onLayout}
      style={{
        maxWidth: "100%",
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 5,
        borderWidth: kind === "scope" ? 0.5 : 0,
        borderColor: color.line,
        backgroundColor:
          kind === "label"
            ? tintedSurface(
                color.surface,
                color.foreground,
                nativeAccentColor(labelColor, mode, color),
              )
            : "transparent",
      }}
    >
      {kind === "label" && (
        <View
          accessible={false}
          style={{
            width: 5,
            height: 5,
            borderRadius: 3,
            flexShrink: 0,
            backgroundColor: nativeAccentColor(labelColor, mode, color),
          }}
        />
      )}
      {kind === "scope" && <TicketGlyph name="hash" color={color.muted} size={11} />}
      <Text style={{ color: color.foreground, fontSize: 12, lineHeight: 18, flexShrink: 1 }}>
        {tag}
      </Text>
    </View>
  );
}

// Composer, filters and bulk edits choose from the same colored label catalog.
export const labelOptions = (labels: { name: string; color: LabelColor }[]) =>
  labels.map((label) => ({
    value: label.name,
    label: label.name,
    leading: <TicketTag tag={label.name} color={label.color} indicatorOnly />,
  }));
