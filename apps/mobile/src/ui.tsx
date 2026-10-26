import { LegendList, type LegendListProps } from "@legendapp/list/react-native";
import {
  createContext,
  useContext,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentRef,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Button as SystemButton,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
  type ViewStyle,
  type StyleProp,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  NavigationContainer,
  NavigationIndependentTree,
  DefaultTheme,
  DarkTheme,
  useNavigation,
  NavigationContext,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackHeaderItem,
  type NativeStackHeaderItemMenu,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import {
  createHeaderAction,
  createHeaderFallback,
  type HeaderAction,
} from "./navigation-actions.tsx";
import { useNativePalette } from "./theme.ts";
import { AccountImage } from "./image.tsx";
import { nativeAccentColor } from "@kanvil/contracts/colors";
import {
  formats,
  markdownFormats,
  formatMarkdown,
  type MarkdownFormat,
} from "@kanvil/contracts/markdown";
import Ionicons from "@expo/vector-icons/Ionicons";
import Svg, { Path } from "react-native-svg";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Renderer, useMarkdown } from "react-native-marked";
import { brandMark } from "@kanvil/contracts/theme";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "./data.tsx";
import {
  errorMessage,
  mentionScheme,
  priorityLabels,
  stateLabels,
  stateTones,
  type Ticket,
  presentWorkflow,
  difficultyLabels,
  type CustomField,
  type CustomFieldValue,
} from "@kanvil/contracts";
import { activeLocale, formatDate, formatNumber, t } from "@kanvil/contracts/i18n";
// "High priority"; no priority reads as itself rather than "No priority priority".
export const priorityText = (priority: Ticket["priority"]) =>
  priority === "none"
    ? priorityLabels.none
    : t("native.ticket.priority", { priority: priorityLabels[priority] });

export const usePalette = useNativePalette;
const SheetStack = createNativeStackNavigator<{ Sheet: undefined }>();
type ButtonAction = HeaderAction;
const FormAction = createContext<((action: ButtonAction | undefined) => void) | null>(null);
const ImageSurface = createContext(false);

// Extend the native item description once: UIKit owns iOS bars; Android uses the same actions
// through our existing Sheet/Row primitives. Choice is flat and cannot represent bar submenus.
export function nativeHeaderOptions<
  const T extends Pick<
    NativeStackNavigationOptions,
    "unstable_headerLeftItems" | "unstable_headerRightItems"
  >,
>(options: T) {
  if (Platform.OS === "ios") return options;
  const left = options.unstable_headerLeftItems,
    right = options.unstable_headerRightItems;
  return {
    ...options,
    ...(left ? { headerLeft: createHeaderItemsFallback(left({})) } : {}),
    ...(right ? { headerRight: createHeaderItemsFallback(right({})) } : {}),
  };
}
function createHeaderItemsFallback(items: NativeStackHeaderItem[]) {
  return function HeaderItems() {
    return <HeaderItemsFallback items={items} />;
  };
}
function HeaderItemsFallback({ items }: { items: NativeStackHeaderItem[] }) {
  const [open, setOpen] = useState(false);
  const color = usePalette();
  const actions = items.filter((item) => item.type === "button" || item.type === "menu");
  if (!actions.length) return null;
  const first = actions[0],
    title = actions.length === 1 ? (first?.label ?? "") : t("ticket.selection.more");
  function menuRows(entries: NativeStackHeaderItemMenu["menu"]["items"]): ReactNode {
    return entries.map((item, index) =>
      item.type === "submenu" ? (
        <Section key={`${index}:${item.label}`} title={item.label}>
          {menuRows(item.items)}
        </Section>
      ) : item.hidden ? null : (
        <Row
          key={`${index}:${item.label}`}
          title={item.label}
          {...(item.description ? { caption: item.description } : {})}
          disabled={item.disabled ?? false}
          selected={item.state === "on"}
          onPress={() => {
            setOpen(false);
            item.onPress();
          }}
        />
      ),
    );
  }
  return (
    <>
      <SystemButton
        title={title}
        color={color.accent}
        disabled={actions.length === 1 && first?.disabled}
        onPress={() => {
          if (actions.length === 1 && first?.type === "button") first.onPress();
          else setOpen(true);
        }}
      />
      <Sheet title={title} open={open} onClose={() => setOpen(false)}>
        {actions.map((item, index) =>
          item.type === "menu" ? (
            <Section key={`${index}:${item.label}`} title={item.label}>
              {menuRows(item.menu.items)}
            </Section>
          ) : (
            <Row
              key={`${index}:${item.label}`}
              title={item.label}
              disabled={item.disabled ?? false}
              onPress={() => {
                setOpen(false);
                item.onPress();
              }}
            />
          ),
        )}
      </Sheet>
    </>
  );
}
export function Brand() {
  const color = usePalette();
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 18 }}
      accessibilityLabel="Kanvil"
      accessible
    >
      <Svg width={58} height={34} viewBox={brandMark.viewBox}>
        <Path d={brandMark.path} fill={color.accent} />
      </Svg>
      <Text
        style={{ fontSize: 29, fontWeight: "700", letterSpacing: -0.7, color: color.foreground }}
      >
        Kanvil
      </Text>
    </View>
  );
}
export function Button({
  title,
  onPress,
  disabled = false,
  primary = false,
  danger = false,
  accessibilityLabel,
  compact = false,
  plain = false,
  disclosure = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  accessibilityLabel?: string;
  compact?: boolean;
  plain?: boolean;
  disclosure?: boolean;
}) {
  const color = usePalette();
  const formAction = useContext(FormAction);
  useEffect(() => {
    if (!primary || !formAction) return undefined;
    formAction({ title, onPress, disabled });
    return () => formAction(undefined);
  }, [primary, formAction, title, onPress, disabled]);
  if (primary && formAction) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled }}
      onPress={() => {
        Keyboard.dismiss();
        onPress();
      }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          borderColor: plain ? "transparent" : primary ? color.accent : color.line,
          backgroundColor: plain ? "transparent" : primary ? color.accent : color.background,
          opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
        },
        compact && { paddingHorizontal: 10, paddingVertical: 8 },
        disclosure && { flexDirection: "row", justifyContent: "space-between" },
      ]}
    >
      <Text
        style={{
          color: danger
            ? color.danger
            : primary
              ? color.accentForeground
              : plain
                ? color.accent
                : color.foreground,
          fontWeight: primary || plain ? "600" : "500",
          fontSize: 15,
          flexShrink: 1,
        }}
      >
        {title}
      </Text>
      {disclosure && <Ionicons name="chevron-down" size={16} color={color.muted} />}
    </Pressable>
  );
}
export function Field({ label, ...props }: ComponentProps<typeof TextInput> & { label: string }) {
  const color = usePalette();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: color.muted }]}>{label}</Text>
      <TextInput
        autoCapitalize={props.secureTextEntry ? "none" : "sentences"}
        autoCorrect={!props.secureTextEntry}
        {...props}
        accessibilityLabel={label}
        placeholderTextColor={color.muted}
        keyboardAppearance={useColorScheme() === "dark" ? "dark" : "light"}
        style={[
          styles.input,
          { color: color.foreground, borderColor: color.line, backgroundColor: color.background },
          props.multiline && { minHeight: 110, textAlignVertical: "top" },
          props.style,
        ]}
      />
    </View>
  );
}
export function MarkdownField({
  label,
  value,
  onChangeText,
  maxLength,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  maxLength?: number;
}) {
  const input = useRef<ComponentRef<typeof TextInput>>(null),
    color = usePalette();
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  function apply(format: MarkdownFormat) {
    const edit = formatMarkdown(value, selection.start, selection.end, format);
    onChangeText(value.slice(0, edit.from) + edit.text + value.slice(edit.to));
    setSelection({ start: edit.start, end: edit.end });
    input.current?.focus();
  }
  return (
    <View style={{ gap: 8 }}>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 12 }}
      >
        {markdownFormats.map((format) => (
          <SystemButton
            key={format}
            title={formats[format].label}
            color={color.accent}
            disabled={format === "link" && selection.start === selection.end}
            onPress={() => apply(format)}
          />
        ))}
      </ScrollView>
      <Field
        ref={input}
        label={label}
        value={value}
        onChangeText={onChangeText}
        multiline
        selection={selection}
        onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
        {...(maxLength ? { maxLength } : {})}
      />
    </View>
  );
}
export function TicketPicker({
  projectId,
  label,
  value,
  onChange,
  excludeId,
}: {
  projectId: string;
  label: string;
  value: string | null;
  onChange: (id: string | null) => void;
  excludeId?: string;
}) {
  const { api } = useConnection(),
    [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const q = useDeferredValue(query);
  const ticket = useQuery({
    ...api.query("get_ticket", { projectId, ticketId: value ?? "" }),
    enabled: !!value,
  });
  const matches = useQuery({
    ...api.query("list_tickets", { projectId, q, limit: 50 }),
    enabled: open,
  });
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: usePalette().muted }]}>{label}</Text>
      <Button
        disclosure
        title={
          ticket.data
            ? `${ticket.data.ticket.key} · ${ticket.data.ticket.title}`
            : t("ticket.picker.noParent")
        }
        onPress={() => {
          setQuery("");
          setOpen(true);
        }}
      />
      <Sheet title={label} open={open} onClose={() => setOpen(false)}>
        <Field
          label={t("ticket.picker.searchLabel", { label })}
          value={query}
          onChangeText={setQuery}
          placeholder={t("ticket.picker.searchPlaceholder")}
          autoFocus
        />
        <Button
          title={t("ticket.picker.noParent")}
          onPress={() => {
            onChange(null);
            setOpen(false);
          }}
        />
        <ErrorNotice error={matches.error} />
        {matches.isPending ? (
          <Loading />
        ) : (
          matches.data?.items
            .filter((item) => item.id !== excludeId)
            .map((item) => (
              <TicketRow
                key={item.id}
                ticket={item}
                onPress={() => {
                  onChange(item.id);
                  setOpen(false);
                }}
              />
            ))
        )}
      </Sheet>
    </View>
  );
}
export function Sheet({
  title,
  open,
  onClose,
  children,
  scroll = true,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  scroll?: boolean;
}) {
  const color = usePalette();
  const [submit, setSubmit] = useState<ButtonAction>();
  return (
    <Modal
      visible={open}
      presentationStyle="pageSheet"
      animationType="slide"
      onRequestClose={onClose}
      allowSwipeDismissal={false}
    >
      <SafeAreaProvider style={{ backgroundColor: color.surface }}>
        <NavigationIndependentTree>
          <NavigationContainer theme={useColorScheme() === "dark" ? DarkTheme : DefaultTheme}>
            <SheetStack.Navigator
              screenOptions={{
                headerShadowVisible: false,
                contentStyle: { backgroundColor: color.surface },
                headerStyle: { backgroundColor: color.surface },
                headerTintColor: color.accent,
              }}
            >
              <SheetStack.Screen
                name="Sheet"
                options={{
                  title,
                  headerLeft: createHeaderFallback(
                    { title: t("common.action.close"), onPress: onClose },
                    color.accent,
                  ),
                  headerRight: createHeaderFallback(submit, color.accent),
                  unstable_headerLeftItems: () => [
                    createHeaderAction(t("common.action.close"), onClose, {
                      type: "sfSymbol",
                      name: "xmark",
                    }),
                  ],
                  unstable_headerRightItems: () =>
                    submit
                      ? [
                          {
                            ...createHeaderAction(
                              submit.title,
                              submit.onPress,
                              { type: "sfSymbol", name: "checkmark" },
                              submit.disabled,
                            ),
                            variant: "done",
                          },
                        ]
                      : [],
                }}
              >
                {() => (
                  <FormAction value={setSubmit}>
                    <Screen scroll={scroll}>{children}</Screen>
                  </FormAction>
                )}
              </SheetStack.Screen>
            </SheetStack.Navigator>
          </NavigationContainer>
        </NavigationIndependentTree>
      </SafeAreaProvider>
    </Modal>
  );
}
export function Choice({
  label,
  value,
  options,
  onChange,
  selected,
  onToggle,
  emptyLabel = t("ticket.field.noValue"),
  disabled = false,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  selected?: string[];
  onToggle?: (value: string) => void;
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const color = usePalette(),
    [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const current = selected
    ? options
        .filter((option) => selected.includes(option.value))
        .map((option) => option.label)
        .join(", ") || emptyLabel
    : (options.find((option) => option.value === value)?.label ?? value);
  return (
    <View style={styles.field}>
      <Row
        compact
        title={label}
        disabled={disabled}
        accessibilityLabel={t("native.labelValue", { label, value: current })}
        onPress={() => {
          setQuery("");
          setOpen(true);
        }}
        trailing={
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center", maxWidth: "56%" }}>
            <Text style={{ color: color.muted, fontSize: 15, flexShrink: 1 }}>
              {selected && selected.length > 1
                ? t("ticket.selection.selected", { count: selected.length })
                : current}
            </Text>
            <Ionicons name="chevron-down" color={color.muted} size={14} accessible={false} />
          </View>
        }
      />
      <Sheet title={label} open={open} onClose={() => setOpen(false)}>
        {options.length > 7 && (
          <Field
            label={t("ticket.property.search", { label })}
            value={query}
            onChangeText={setQuery}
            autoFocus
            autoCorrect={false}
          />
        )}
        {options
          .filter((option) => option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
          .map((option) =>
            selected ? (
              <Check
                key={option.value}
                label={option.label}
                checked={selected.includes(option.value)}
                onChange={() => onToggle?.(option.value)}
              />
            ) : (
              <Row
                key={option.value}
                title={option.label}
                selected={option.value === value}
                trailing={
                  option.value === value ? (
                    <Ionicons name="checkmark" size={20} color={color.accent} accessible={false} />
                  ) : (
                    <View />
                  )
                }
                onPress={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              />
            ),
          )}
      </Sheet>
    </View>
  );
}
export function Check({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const color = usePalette();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={styles.check}
    >
      <Ionicons
        name={checked ? "checkbox" : "square-outline"}
        size={24}
        color={checked ? color.accent : color.muted}
      />
      <Text style={{ color: color.foreground, flex: 1, fontSize: 15, lineHeight: 22 }}>
        {label}
      </Text>
    </Pressable>
  );
}
// Date and custom-field editors extend the same Choice/Field/Check controls used by forms.
export function NativeDatePicker(
  props: Pick<
    ComponentProps<typeof DateTimePicker>,
    "value" | "minimumDate" | "maximumDate" | "timeZoneName" | "onChange"
  >,
) {
  return (
    <DateTimePicker
      {...props}
      mode="date"
      display={Platform.OS === "ios" ? "inline" : "default"}
      locale={activeLocale()}
      accentColor={usePalette().accent}
      style={Platform.OS === "ios" ? { height: 360, alignSelf: "stretch" } : undefined}
    />
  );
}
export function DateField({
  label,
  value,
  onChange,
  dayBoundary,
  bounds,
  clearable = true,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  dayBoundary?: "start" | "end";
  bounds?: { from?: string | null; to?: string | null };
  clearable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [today] = useState(() => new Date());
  const color = usePalette();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: color.muted }]}>{label}</Text>
      <Button
        disclosure
        title={
          value
            ? formatDate(value, {
                dateStyle: "medium",
                ...(!dayBoundary ? { timeZone: "UTC" } : {}),
              })
            : t("ticket.date.placeholder")
        }
        accessibilityLabel={label}
        onPress={() => setOpen(true)}
      />
      <Sheet title={label} open={open} onClose={() => setOpen(false)}>
        <NativeDatePicker
          {...(!dayBoundary ? { timeZoneName: "UTC" } : {})}
          value={value ? new Date(dayBoundary ? value : `${value}T12:00:00Z`) : today}
          {...(bounds?.from ? { minimumDate: new Date(bounds.from) } : {})}
          {...(bounds?.to ? { maximumDate: new Date(bounds.to) } : {})}
          onChange={(event, date) => {
            if (event.type === "set" && date) {
              if (dayBoundary) {
                date.setHours(
                  dayBoundary === "end" ? 23 : 0,
                  dayBoundary === "end" ? 59 : 0,
                  dayBoundary === "end" ? 59 : 0,
                  dayBoundary === "end" ? 999 : 0,
                );
                onChange(date.toISOString());
              } else onChange(date.toISOString().slice(0, 10));
            }
            if (Platform.OS === "android") setOpen(false);
          }}
        />
        {clearable && (
          <Button
            title={t("ticket.date.clear", { label })}
            onPress={() => {
              onChange(null);
              setOpen(false);
            }}
          />
        )}
      </Sheet>
    </View>
  );
}
export function CustomFieldInput({
  field,
  value,
  onChange,
}: {
  field: Pick<CustomField, "name" | "type" | "options">;
  value: CustomFieldValue | null | undefined;
  onChange: (value: CustomFieldValue | null) => void;
}) {
  if (field.type === "checkbox")
    return <Check label={field.name} checked={value === true} onChange={onChange} />;
  if (field.type === "date")
    return (
      <DateField
        label={field.name}
        value={typeof value === "string" ? value : null}
        onChange={onChange}
      />
    );
  if (field.type === "select" || field.type === "multiselect")
    return (
      <Choice
        label={field.name}
        value={typeof value === "string" ? value : ""}
        options={[
          { value: "", label: t("ticket.field.noValue") },
          ...field.options.map((option) => ({ value: option.id, label: option.name })),
        ]}
        {...(field.type === "multiselect"
          ? {
              selected: Array.isArray(value) ? value : [],
              onToggle: (option: string) => {
                const previous = Array.isArray(value) ? value : [];
                onChange(
                  option
                    ? previous.includes(option)
                      ? previous.filter((item) => item !== option)
                      : [...previous, option]
                    : [],
                );
              },
            }
          : {})}
        onChange={(next) => onChange(next || null)}
      />
    );
  return (
    <Field
      label={field.name}
      value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
      keyboardType={field.type === "number" ? "decimal-pad" : "default"}
      onChangeText={(next) => onChange(next === "" ? null : next)}
    />
  );
}
export function ErrorNotice({ error }: { error: unknown }) {
  const color = usePalette();
  return error ? (
    <Text
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{ color: color.danger, marginVertical: 12 }}
    >
      {errorMessage(error)}
    </Text>
  ) : null;
}
export function Loading() {
  const color = usePalette();
  return (
    <ActivityIndicator
      accessibilityLabel={t("native.ui.loading")}
      color={color.accent}
      style={{ margin: 24 }}
    />
  );
}
export function Body({
  children,
  muted = false,
  small = false,
}: {
  children: ReactNode;
  muted?: boolean;
  small?: boolean;
}) {
  const color = usePalette();
  return (
    <Text
      style={{
        color: muted ? color.muted : color.foreground,
        lineHeight: small ? 20 : 24,
        fontSize: small ? 13 : 16,
      }}
    >
      {children}
    </Text>
  );
}
export function Heading({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  const color = usePalette();
  return (
    <Text
      accessibilityRole="header"
      style={[
        styles.heading,
        { color: compact ? color.muted : color.foreground },
        compact && { fontSize: 14, letterSpacing: 0, fontWeight: "600" },
      ]}
    >
      {children}
    </Text>
  );
}
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const color = usePalette();
  return (
    <View
      style={{
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: color.line,
        paddingVertical: 20,
        gap: 8,
      }}
    >
      <Heading compact>{title}</Heading>
      {children}
    </View>
  );
}
export function Screen({
  children,
  scroll = true,
  style,
  form = false,
  background,
  safeArea = true,
}: {
  children: ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  form?: boolean;
  background?: string | null;
  safeArea?: boolean;
}) {
  const color = usePalette();
  const navigation = useContext(NavigationContext);
  const content = (
    <ImageSurface value={!!background}>
      <View style={[{ flex: 1, backgroundColor: color.surface }, style]}>
        {background && (
          <AccountImage uri={background} style={[StyleSheet.absoluteFill, { opacity: 0.08 }]} />
        )}
        <SafeAreaView edges={navigation && safeArea ? ["left", "right"] : []} style={{ flex: 1 }}>
          {scroll ? (
            <Scroll
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              contentContainerStyle={{
                padding: 22,
                paddingBottom: 48,
                gap: 16,
                ...(!navigation ? { width: "100%", maxWidth: 560, alignSelf: "center" } : {}),
              }}
            >
              {children}
            </Scroll>
          ) : (
            children
          )}
        </SafeAreaView>
      </View>
    </ImageSurface>
  );
  return form ? <NativeForm>{content}</NativeForm> : content;
}
// Screen's scrolling primitive also serves layouts that own their scrolling content.
export function Scroll(props: ComponentProps<typeof ScrollView>) {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      {...props}
    />
  );
}
function NativeForm({ children }: { children: ReactNode }) {
  const navigation = useNavigation(),
    color = usePalette(),
    [submit, setSubmit] = useState<ButtonAction>();
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: createHeaderFallback(submit, color.accent),
      unstable_headerRightItems: () =>
        submit
          ? [
              {
                ...createHeaderAction(
                  submit.title,
                  submit.onPress,
                  { type: "sfSymbol", name: "checkmark" },
                  submit.disabled,
                ),
                variant: "done",
              },
            ]
          : [],
    });
  }, [navigation, submit, color.accent]);
  return <FormAction value={setSubmit}>{children}</FormAction>;
}
export function Pager({
  offset,
  total,
  limit = 25,
  onChange,
  noun,
}: {
  offset: number;
  total: number | undefined;
  limit?: number;
  onChange: (offset: number) => void;
  noun: string;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        paddingVertical: 16,
      }}
    >
      <Button
        compact
        title={t("shell.ui.previousPage", { noun })}
        disabled={!offset}
        onPress={() => onChange(Math.max(0, offset - limit))}
      />
      {total !== undefined && (
        <Body small muted>
          {t("shell.ui.pageRange", {
            from: formatNumber(total ? offset + 1 : 0),
            to: formatNumber(Math.min(total, offset + limit)),
            total: formatNumber(total),
          })}
        </Body>
      )}
      <Button
        compact
        title={t("shell.ui.nextPage", { noun })}
        disabled={total === undefined || offset + limit >= total}
        onPress={() => onChange(offset + limit)}
      />
    </View>
  );
}
export function List<T>(props: LegendListProps<T>) {
  return (
    <LegendList
      recycleItems
      keyboardDismissMode="interactive"
      contentInsetAdjustmentBehavior="automatic"
      {...props}
    />
  );
}
export function Row({
  title,
  caption,
  leading,
  trailing,
  overline,
  metadata,
  onPress,
  onLongPress,
  selected,
  compact = false,
  disabled = false,
  accessibilityLabel,
  style,
}: {
  title: string;
  caption?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  overline?: string;
  metadata?: ReactNode;
  onPress: () => void;
  onLongPress?: (() => void) | undefined;
  selected?: boolean | undefined;
  compact?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const color = usePalette();
  const imageSurface = useContext(ImageSurface);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ ...(selected !== undefined ? { selected } : {}), disabled }}
      disabled={disabled}
      onLongPress={onLongPress}
      onPress={() => {
        Keyboard.dismiss();
        onPress();
      }}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          minHeight: 44,
          paddingVertical: compact ? 12 : 18,
          paddingHorizontal: compact ? 0 : 20,
          gap: 12,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderColor: color.line,
          backgroundColor:
            pressed || selected
              ? color.accentSurface
              : imageSurface
                ? "transparent"
                : color.surface,
        },
        style,
      ]}
    >
      {leading}
      <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
        {overline && (
          <Text
            style={{
              color: color.muted,
              fontSize: 12,
              fontWeight: "500",
              fontVariant: ["tabular-nums"],
            }}
          >
            {overline}
          </Text>
        )}
        <Text
          style={{
            color: color.foreground,
            fontSize: compact ? 15 : 17,
            fontWeight: "600",
            lineHeight: 25,
            letterSpacing: -0.2,
          }}
        >
          {title}
        </Text>
        {caption && (
          <Text style={{ color: color.muted, fontSize: 12, lineHeight: 18 }}>{caption}</Text>
        )}
        {metadata && <View style={[styles.actions, { marginTop: 3 }]}>{metadata}</View>}
      </View>
      {trailing ?? (
        <Ionicons name="chevron-forward" size={16} color={color.muted} accessible={false} />
      )}
    </Pressable>
  );
}
export function TicketRow({
  ticket,
  onPress,
  onLongPress,
  selected,
}: {
  ticket: Ticket;
  onPress: () => void;
  onLongPress?: (() => void) | undefined;
  selected?: boolean | undefined;
}) {
  return (
    <Row
      title={ticket.title}
      overline={ticket.key}
      metadata={
        <>
          <Status ticket={ticket} />
          <Body muted small>
            {priorityText(ticket.priority)}
          </Body>
          {ticket.difficulty && (
            <Body muted small>
              {difficultyLabels[ticket.difficulty]}
            </Body>
          )}
        </>
      }
      onPress={onPress}
      onLongPress={onLongPress}
      selected={selected}
    />
  );
}
// A ticket's workflow state, tinted by its category. Older servers show the canonical status.
export function Status({ ticket }: { ticket: Pick<Ticket, "projectId" | "status" | "stateId"> }) {
  const color = usePalette(),
    { api } = useConnection();
  const workflow = useQuery({
    ...api.query("list_workflow_states", { projectId: ticket.projectId }),
    select: presentWorkflow,
    enabled: !!ticket.stateId,
  });
  const name = workflow.data?.find((state) => state.id === ticket.stateId)?.name;
  const stateColor = workflow.data?.find((state) => state.id === ticket.stateId)?.color;
  const mode = useColorScheme() === "dark" ? "dark" : "light";
  return (
    <Text
      style={{
        color:
          stateColor && stateColor !== "default"
            ? nativeAccentColor(stateColor, mode, color)
            : color[stateTones[ticket.status]],
        fontSize: 13,
        fontWeight: "500",
        lineHeight: 20,
      }}
    >
      ● {name ?? stateLabels[ticket.status]}
    </Text>
  );
}
// A mention has nothing to open, so it reads as emphasized "@Name" text instead of a link.
class MarkdownRenderer extends Renderer {
  override link(...[children, href, styles, title]: Parameters<Renderer["link"]>) {
    return href.startsWith(mentionScheme)
      ? this.text(children, { ...styles, fontWeight: "600" })
      : super.link(children, href, styles, title);
  }
}
const markdownRenderer = new MarkdownRenderer();
export function Markdown({ children }: { children: string }) {
  const colorScheme = useColorScheme(),
    color = usePalette();
  const theme = useMemo(
    () => ({
      colors: {
        text: color.foreground,
        link: color.accent,
        border: color.line,
        code: color.surface,
      },
    }),
    [color],
  );
  const elements = useMarkdown(children, {
    colorScheme: colorScheme === "dark" ? "dark" : "light",
    theme,
    renderer: markdownRenderer,
  });
  return <View>{elements}</View>;
}
export const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  field: { gap: 8 },
  label: { fontSize: 13, fontWeight: "500" },
  input: { borderWidth: 1, borderRadius: 10, padding: 14, minHeight: 48, fontSize: 16 },
  heading: { fontSize: 21, fontWeight: "600", letterSpacing: -0.4 },
  check: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: 10 },
  modal: { flex: 1, justifyContent: "flex-end" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
});
