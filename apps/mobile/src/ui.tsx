import { MenuView, type MenuAction } from "@expo/ui/community/menu";
import { nativeMenuSymbol } from "./native-menu-symbols.ts";
import SegmentedControl from "@expo/ui/community/segmented-control";
import { inlineItemCount } from "./pane-layout.ts";
import { ticketScheduleText } from "@kanvil/contracts/schedule";
import { LegendList, type LegendListProps } from "@legendapp/list/react-native";
import {
  lazy,
  Suspense,
  createElement,
  isValidElement,
  createContext,
  useCallback,
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
  Switch,
  I18nManager,
  Button as SystemButton,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
  useWindowDimensions,
  type ViewStyle,
  type StyleProp,
} from "react-native";
import {
  ReservedRegionsProvider,
  useReservedRegions,
  useReservedRegionsReady,
  type ReservedRegion,
} from "react-native-reserved-regions";
import { usableViewport } from "./pane-layout.ts";
import { SafeAreaView } from "react-native-safe-area-context";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  NavigationContainer,
  NavigationIndependentTree,
  DefaultTheme,
  DarkTheme,
  useNavigation,
  useNavigationContainerRef,
  NavigationContext,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackHeaderItem,
  type NativeStackHeaderItemMenu,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import {
  HeaderButton,
  createHeaderAction,
  createHeaderFallback,
  type HeaderAction,
} from "./navigation-actions.tsx";
import { markdownIcons } from "@kanvil/contracts/icons";
import { ProjectIcon } from "./project-icon.tsx";
import {
  PropertyValue,
  TicketTag,
  TicketGlyph,
  useTicketCatalog,
  propertyDescription,
} from "./ticket-values.tsx";
export { PropertyValue, TicketGlyph, UserAvatar } from "./ticket-values.tsx";
import { useNativePalette } from "./theme.ts";
import { AccountImage } from "./image.tsx";
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
import { useConnection, useWorkspace, useAllProjects, useNow, LiveStatus } from "./data.tsx";
import { AfterSheet, useProjectNavigation } from "./navigation.ts";
import {
  errorMessage,
  mentionScheme,
  isPresetColor,
  projectIconColors,
  type Ticket,
  type CustomField,
  type CustomFieldValue,
} from "@kanvil/contracts";
import { activeLocale, formatDate, formatNumber, formatList, t } from "@kanvil/contracts/i18n";
// Shared UI glyphs decorate controls whose text already provides their accessible name.
function DecorativeIcon(props: ComponentProps<typeof Ionicons>) {
  return (
    <Ionicons
      {...props}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
export const usePalette = useNativePalette;
type SheetRoutes = { Hidden: undefined; Sheet: undefined };
const SheetStack = createNativeStackNavigator<SheetRoutes>();
type ButtonAction = HeaderAction;
const FormAction = createContext<((action: ButtonAction | undefined) => void) | null>(null);
const ImageSurface = createContext(false);
const InsetsConsumed = createContext(false);
const PaddedContent = createContext(false);
const ScrollingHeader = createContext<ReactNode>(null);
const scrollInsetsDefaults: Pick<
  ComponentProps<typeof ScrollView>,
  | "contentInsetAdjustmentBehavior"
  | "automaticallyAdjustKeyboardInsets"
  | "automaticallyAdjustsScrollIndicatorInsets"
> = {
  contentInsetAdjustmentBehavior: "automatic",
  automaticallyAdjustKeyboardInsets: true,
  automaticallyAdjustsScrollIndicatorInsets: true,
};

const ViewportContext = createContext<{
  bounds: { width: number; height: number };
  regions: readonly ReservedRegion[];
} | null>(null);
export function useNativeViewport() {
  const viewport = useContext(ViewportContext);
  if (!viewport) throw new Error("A native viewport requires Screen");
  return viewport;
}
// Shared by ordinary screens and list/detail panes; coordinates remain physical in RTL.
export function ViewportPane({
  children,
  rect,
  viewportWidth,
  visible = true,
}: {
  children: ReactNode;
  rect: ReservedRegion["frame"];
  viewportWidth: number;
  visible?: boolean;
}) {
  return (
    <View
      pointerEvents={visible ? "auto" : "none"}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
      style={{
        position: "absolute",
        start: I18nManager.isRTL ? viewportWidth - rect.x - rect.width : rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        opacity: visible ? 1 : 0,
        overflow: "hidden",
      }}
    >
      {children}
    </View>
  );
}
function ViewportContent({
  children,
  bounds,
  allowDivision,
}: {
  children: ReactNode;
  bounds: { width: number; height: number };
  allowDivision: boolean;
}) {
  const regions = useReservedRegions(),
    ready = useReservedRegionsReady();
  if (!ready || !bounds.width || !bounds.height) return <Loading />;
  const rect = allowDivision ? { x: 0, y: 0, ...bounds } : usableViewport(bounds, regions);
  const localRegions = regions.map((region) => ({
    ...region,
    frame: {
      ...region.frame,
      x: region.frame.x - rect.x,
      y: region.frame.y - rect.y,
    },
  }));
  return (
    <View style={{ flex: 1 }}>
      <ViewportPane rect={rect} viewportWidth={bounds.width}>
        <ViewportContext
          value={{ bounds: { width: rect.width, height: rect.height }, regions: localRegions }}
        >
          {children}
        </ViewportContext>
      </ViewportPane>
    </View>
  );
}
export function MeasuredViewport({
  children,
  allowDivision = false,
}: {
  children: ReactNode;
  allowDivision?: boolean;
}) {
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  return (
    <ReservedRegionsProvider
      style={{ flex: 1 }}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        if (width > 0 && height > 0) setBounds({ width, height });
      }}
    >
      <ViewportContent bounds={bounds} allowDivision={allowDivision}>
        {children}
      </ViewportContent>
    </ReservedRegionsProvider>
  );
}
// One native screen boundary owns bar insets; nested content measures its own fold coordinates.
function ContentArea({
  children,
  enabled = true,
  allowDivision,
  scrollInsets,
}: {
  children: ReactNode;
  enabled?: boolean;
  allowDivision: boolean;
  scrollInsets: boolean;
}) {
  const consumed = useContext(InsetsConsumed);
  return (
    <SafeAreaProvider style={{ flex: 1 }}>
      <SafeAreaView
        edges={
          enabled && !consumed
            ? scrollInsets
              ? ["left", "right"]
              : ["left", "right", "top", "bottom"]
            : []
        }
        style={{ flex: 1 }}
      >
        <InsetsConsumed value={consumed || enabled}>
          <MeasuredViewport allowDivision={allowDivision}>{children}</MeasuredViewport>
        </InsetsConsumed>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

// Extend the native item description once: UIKit owns iOS bars; Android uses the same actions
// through our existing Sheet/Row primitives. Choice is flat and cannot represent bar submenus.
export function nativeHeaderOptions<const T extends NativeStackNavigationOptions>(options: T) {
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
          interaction={item.state === undefined ? "action" : "choice"}
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
              interaction="action"
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
const IOSMenu = lazy(() => import("./native-menu.ios.tsx"));
export function Menu({
  title,
  items,
  children,
  fill = false,
}: {
  title: string;
  items: NativeStackHeaderItemMenu["menu"]["items"];
  children: ReactNode;
  fill?: boolean;
}) {
  const [width, setWidth] = useState(0);
  const handlers = new Map<string, () => void>();
  function actions(entries: NativeStackHeaderItemMenu["menu"]["items"], prefix = ""): MenuAction[] {
    return entries.map((item, index) => {
      const id = `${prefix}${index}`;
      if (item.type === "submenu")
        return {
          id,
          title: item.label,
          ...(item.inline === undefined ? {} : { displayInline: item.inline }),
          subactions: actions(item.items, `${id}.`),
        };
      handlers.set(id, item.onPress);
      return {
        id,
        title: item.label,
        ...(item.state === "on" || item.state === "off" ? { state: item.state } : {}),
        attributes: {
          ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
          ...(item.hidden === undefined ? {} : { hidden: item.hidden }),
          ...(item.destructive === undefined ? {} : { destructive: item.destructive }),
        },
      };
    });
  }
  const content = fill ? <View style={{ width }}>{children}</View> : children;
  const menu =
    Platform.OS === "ios" ? (
      <Suspense fallback={content}>
        <IOSMenu title={title} items={items}>
          {content}
        </IOSMenu>
      </Suspense>
    ) : (
      <MenuView
        title={title}
        actions={actions(items)}
        onPressAction={({ nativeEvent }) => handlers.get(nativeEvent.event)?.()}
      >
        {content}
      </MenuView>
    );
  // SwiftUI measures menu labels intrinsically; form rows take their measured RN container width.
  return fill ? (
    <View
      style={{ alignSelf: "stretch", minHeight: 44 }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {width > 0 && menu}
    </View>
  ) : (
    menu
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
  leading,
  trailing,
  children,
  dismissKeyboard = true,
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
  leading?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
  dismissKeyboard?: boolean;
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
        if (dismissKeyboard) Keyboard.dismiss();
        onPress();
      }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          borderWidth: 0,
          borderColor: primary ? color.accent : color.line,
          backgroundColor: primary
            ? color.accent
            : pressed
              ? color.accentSurface
              : compact && !plain
                ? color.background
                : "transparent",
          alignItems: primary ? "center" : "flex-start",
          opacity: disabled ? 0.45 : 1,
          paddingHorizontal: primary ? 16 : 0,
        },
        compact && { paddingHorizontal: 9, paddingVertical: 7 },
        !!(disclosure || leading || trailing) && {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        },
        disclosure && { justifyContent: "space-between" },
      ]}
    >
      {leading}
      {children ?? (
        <Text
          style={{
            color: danger
              ? color.danger
              : primary
                ? color.accentForeground
                : compact
                  ? color.foreground
                  : color.accent,
            fontWeight: primary || plain ? "600" : "500",
            fontSize: 15,
            flexShrink: 1,
          }}
        >
          {title}
        </Text>
      )}
      {trailing}
      {disclosure && <DecorativeIcon name="chevron-down" size={16} color={color.muted} />}
    </Pressable>
  );
}
export function Field({
  label,
  variant = "standard",
  labelHidden = false,
  ...props
}: ComponentProps<typeof TextInput> & {
  label: string;
  variant?: "standard" | "title" | "search";
  labelHidden?: boolean;
}) {
  const color = usePalette(),
    [focused, setFocused] = useState(false);
  return (
    <View
      style={
        variant === "standard" && !props.multiline && !labelHidden
          ? {
              flexDirection: "row",
              alignItems: "center",
              minHeight: 52,
              gap: 12,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: focused ? color.accent : color.line,
            }
          : styles.field
      }
    >
      {!labelHidden && (
        <Text
          style={[
            styles.label,
            { color: props.multiline ? color.muted : color.foreground },
            !props.multiline &&
              variant === "standard" && {
                width: "34%",
                maxWidth: 180,
                fontSize: 15,
                lineHeight: 21,
              },
          ]}
        >
          {label}
        </Text>
      )}
      <TextInput
        autoCapitalize={props.secureTextEntry ? "none" : "sentences"}
        autoCorrect={!props.secureTextEntry}
        {...props}
        accessibilityLabel={label}
        onFocus={(event) => {
          setFocused(true);
          props.onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          props.onBlur?.(event);
        }}
        placeholderTextColor={color.muted}
        keyboardAppearance={useColorScheme() === "dark" ? "dark" : "light"}
        style={[
          styles.input,
          {
            color: color.foreground,
            borderColor: focused ? color.accent : color.line,
            backgroundColor: "transparent",
            ...(!props.multiline && !labelHidden && variant === "standard"
              ? { flex: 1, minWidth: 0, textAlign: I18nManager.isRTL ? "left" : "right" }
              : {}),
            ...(variant === "search"
              ? { paddingHorizontal: 12, backgroundColor: color.background, borderRadius: 10 }
              : {}),
          },
          props.multiline && {
            minHeight: variant === "title" ? 42 : 88,
            textAlignVertical: "top",
          },
          variant === "title" && {
            paddingHorizontal: 0,
            paddingVertical: 8,
            borderWidth: 0,
            backgroundColor: "transparent",
            fontSize: 24,
            lineHeight: 30,
            fontWeight: "600",
            letterSpacing: -0.4,
          },
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
  status,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  maxLength?: number;
  status?: ReactNode;
  autoFocus?: boolean;
}) {
  const input = useRef<ComponentRef<typeof TextInput>>(null),
    color = usePalette();
  const [selection, setSelection] = useState({ start: 0, end: 0 }),
    [preview, setPreview] = useState(false);
  function apply(format: MarkdownFormat) {
    const edit = formatMarkdown(value, selection.start, selection.end, format);
    onChangeText(value.slice(0, edit.from) + edit.text + value.slice(edit.to));
    setSelection({ start: edit.start, end: edit.end });
    input.current?.focus();
  }
  return (
    <View style={{ gap: 6 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.label, { color: color.muted }]}>{label}</Text>
          {status}
        </View>
        <SegmentedControl
          values={[t("detail.markdown.write"), t("detail.markdown.preview")]}
          selectedIndex={preview ? 1 : 0}
          onChange={({ nativeEvent }) => setPreview(nativeEvent.selectedSegmentIndex === 1)}
          accessibilityLabel={label}
          style={{ minWidth: 168, height: 32 }}
        />
      </View>
      {!preview && (
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          style={{ backgroundColor: color.background, borderRadius: 10 }}
          contentContainerStyle={{ gap: 0, paddingHorizontal: 2 }}
        >
          {markdownFormats.map((format) => (
            <Button
              compact
              plain
              dismissKeyboard={false}
              key={format}
              title=""
              accessibilityLabel={formats[format].label}
              leading={<TicketGlyph name={markdownIcons[format]} color={color.muted} />}
              disabled={format === "link" && selection.start === selection.end}
              onPress={() => apply(format)}
            />
          ))}
        </ScrollView>
      )}
      {preview ? (
        <Markdown>{value}</Markdown>
      ) : (
        <Field
          ref={input}
          label={label}
          labelHidden
          autoFocus={autoFocus}
          style={{ minHeight: 144 }}
          value={value}
          onChangeText={onChangeText}
          multiline
          selection={selection}
          onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
          {...(maxLength ? { maxLength } : {})}
        />
      )}
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
function SheetCloseButton() {
  const navigation = useNavigation(),
    color = usePalette();
  return (
    <HeaderButton
      action={{ title: t("common.action.close"), onPress: () => navigation.goBack() }}
      color={color.accent}
    />
  );
}
export function Sheet({
  title,
  open,
  onClose,
  onDismissed,
  children,
  scroll = true,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  onDismissed?: () => void;
  children: ReactNode;
  scroll?: boolean;
}) {
  const color = usePalette(),
    parentAfterSheet = useContext(AfterSheet);
  const pending = useRef<(() => void) | undefined>(undefined);
  const [submit, setSubmit] = useState<ButtonAction>();
  const navigation = useNavigationContainerRef<SheetRoutes>();
  const [presented, setPresented] = useState(false);
  const close = useCallback(() => navigation.goBack(), [navigation]);
  const afterSheet = useCallback(
    (action: () => void) => {
      pending.current = action;
      close();
    },
    [close],
  );
  const dark = useColorScheme() === "dark";
  useEffect(() => {
    if (!open && presented && navigation.isReady() && navigation.canGoBack()) navigation.goBack();
  }, [open, presented, navigation]);
  if (!open && !presented) return null;
  // Full-screen native presentation keeps one touch surface and gives the presenting screen
  // an appearance event after dismissal, so its temporary navigator can be removed safely.
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <NavigationIndependentTree>
        <NavigationContainer
          ref={navigation}
          onReady={() => setPresented(true)}
          theme={dark ? DarkTheme : DefaultTheme}
          initialState={{ index: 1, routes: [{ name: "Hidden" }, { name: "Sheet" }] }}
          onStateChange={(state) => {
            if (state?.routes[state.index]?.name === "Hidden") onClose();
          }}
        >
          <SheetStack.Navigator
            screenOptions={{
              headerShadowVisible: false,
              contentStyle: { backgroundColor: color.surface },
              headerStyle: { backgroundColor: color.surface },
              headerTintColor: color.accent,
            }}
          >
            <SheetStack.Screen
              name="Hidden"
              options={{ headerShown: false, contentStyle: { backgroundColor: "transparent" } }}
              listeners={{
                transitionEnd: (event) => {
                  if (!open && !event.data.closing) {
                    setPresented(false);
                    const action = pending.current;
                    pending.current = undefined;
                    onDismissed?.();
                    if (action) {
                      if (parentAfterSheet) parentAfterSheet(action);
                      else action();
                    }
                  }
                },
              }}
            >
              {() => null}
            </SheetStack.Screen>
            <SheetStack.Screen
              name="Sheet"
              options={{
                presentation: "fullScreenModal",
                gestureEnabled: false,
                title,
                headerLeft: SheetCloseButton,
                headerRight: createHeaderFallback(submit, color.accent),
                unstable_headerLeftItems: () => [
                  createHeaderAction(t("common.action.close"), close, {
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
                            { visibilityPriority: "high", identifier: "sheet-submit" },
                          ),
                          variant: "done",
                        },
                      ]
                    : [],
              }}
            >
              {() => (
                <InsetsConsumed value={false}>
                  <SafeAreaProvider style={{ backgroundColor: color.surface }}>
                    <FormAction value={setSubmit}>
                      <AfterSheet value={afterSheet}>
                        <Screen scroll={scroll}>{children}</Screen>
                      </AfterSheet>
                    </FormAction>
                  </SafeAreaProvider>
                </InsetsConsumed>
              )}
            </SheetStack.Screen>
          </SheetStack.Navigator>
        </NavigationContainer>
      </NavigationIndependentTree>
    </View>
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
  compact = false,
  summary,
  inline = false,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; leading?: ReactNode; symbol?: string }[];
  onChange: (value: string) => void;
  selected?: string[];
  onToggle?: (value: string) => void;
  emptyLabel?: string;
  disabled?: boolean;
  compact?: boolean;
  summary?: ReactNode;
  inline?: boolean;
}) {
  const color = usePalette(),
    [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const current = selected
    ? options
        .filter((option) => selected.includes(option.value))
        .map((option) => option.label)
        .join(", ") || emptyLabel
    : (options.find((option) => option.value === value)?.label ?? (value || emptyLabel));
  const anchored = !selected && options.length > 0 && options.length <= 7;
  const choices = (
    <>
      {options.length > 7 && (
        <Field
          label={t("ticket.property.search", { label })}
          value={query}
          onChangeText={setQuery}
          autoFocus
          variant="search"
          labelHidden
          placeholder={t("ticket.property.search", { label })}
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
              variant="checkbox"
              leading={option.leading}
              onChange={() => onToggle?.(option.value)}
            />
          ) : (
            <Row
              key={option.value}
              title={option.label}
              leading={option.leading}
              accessibilityLabel={t("native.labelValue", { label, value: option.label })}
              interaction="choice"
              selected={option.value === value}
              trailing={option.value === value ? undefined : <View />}
              onPress={() => {
                onChange(option.value);
                setOpen(false);
              }}
            />
          ),
        )}
    </>
  );
  const trigger = compact ? (
    <Button
      compact
      plain={!!summary}
      title={current}
      disabled={disabled}
      leading={summary ? undefined : options.find((option) => option.value === value)?.leading}
      accessibilityLabel={t("native.labelValue", { label, value: current })}
      onPress={() => {
        if (!anchored) {
          setQuery("");
          setOpen(true);
        }
      }}
    >
      {summary}
    </Button>
  ) : (
    <Row
      compact
      title={label}
      disabled={disabled}
      accessibilityLabel={t("native.labelValue", { label, value: current })}
      onPress={() => {
        if (!anchored) {
          setQuery("");
          setOpen(true);
        }
      }}
      trailing={
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", maxWidth: "56%" }}>
          {options.find((option) => option.value === value)?.leading}
          {summary ?? (
            <Text style={{ color: color.muted, fontSize: 15, flexShrink: 1 }}>
              {selected && selected.length > 1
                ? t("ticket.selection.selected", { count: selected.length })
                : current}
            </Text>
          )}
          <DecorativeIcon name="chevron-down" color={color.muted} size={14} accessible={false} />
        </View>
      }
    />
  );
  const items: NativeStackHeaderItemMenu["menu"]["items"] = options.map((option) => {
    const symbol = option.symbol ? nativeMenuSymbol(option.symbol) : undefined;
    return {
      type: "action",
      label: option.label,
      state: option.value === value ? "on" : "off",
      ...(symbol ? { icon: { type: "sfSymbol", name: symbol } } : {}),
      onPress: () => {
        if (!disabled) onChange(option.value);
      },
    };
  });
  return (
    <View style={[styles.field, compact && { maxWidth: "100%", alignSelf: "flex-start" }]}>
      {anchored && !disabled ? (
        <Menu title={label} items={items} fill={!compact}>
          {trigger}
        </Menu>
      ) : (
        trigger
      )}
      {!anchored &&
        (inline ? (
          open && <View>{choices}</View>
        ) : (
          <Sheet title={label} open={open} onClose={() => setOpen(false)}>
            {choices}
          </Sheet>
        ))}
    </View>
  );
}
// Icon, workflow and label editors share color names, actual swatches and custom color entry.
export function ColorChoice({
  label,
  value,
  onChange,
  presetsOnly = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  presetsOnly?: boolean;
}) {
  const custom = !isPresetColor(value);
  return (
    <>
      <Choice
        label={label}
        value={custom ? "custom" : value}
        onChange={(next) => onChange(next === "custom" ? "#" : next)}
        options={[
          ...projectIconColors.map((tone) => ({
            value: tone,
            label: t(`settings.color.${tone}`),
            leading: <TicketTag tag={tone} color={tone} indicatorOnly />,
          })),
          ...(presetsOnly ? [] : [{ value: "custom", label: t("settings.color.custom") }]),
        ]}
      />
      {custom && !presetsOnly && (
        <Field
          label={t("settings.color.custom")}
          value={value}
          onChangeText={onChange}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={7}
          placeholder="#3458c5"
        />
      )}
    </>
  );
}
export function Check({
  label,
  checked,
  onChange,
  disabled = false,
  leading,
  variant = "switch",
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  leading?: ReactNode;
  variant?: "switch" | "checkbox";
}) {
  const color = usePalette();
  if (variant === "switch")
    return (
      <View
        style={{
          minHeight: 52,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: color.line,
        }}
      >
        {leading}
        <Text style={{ color: color.foreground, fontSize: 15, lineHeight: 22, flex: 1 }}>
          {label}
        </Text>
        <Switch
          accessibilityLabel={label}
          disabled={disabled}
          value={checked}
          onValueChange={onChange}
          trackColor={{ true: color.accent }}
        />
      </View>
    );
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={styles.check}
    >
      <DecorativeIcon
        name={checked ? "checkbox" : "square-outline"}
        size={24}
        color={checked ? color.accent : color.muted}
      />
      {leading}
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
export function ErrorNotice({
  error,
  onRetry,
  retrying = false,
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const color = usePalette();
  if (!error) return null;
  const message = (
    <Text
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{ color: color.danger, marginVertical: 12 }}
    >
      {errorMessage(error)}
    </Text>
  );
  return onRetry ? (
    <View>
      {message}
      <Button plain title={t("common.action.retry")} disabled={retrying} onPress={onRetry} />
      {retrying && <Loading />}
    </View>
  ) : (
    message
  );
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
export function Heading({
  children,
  compact = false,
  disclosure,
  leading,
  count,
}: {
  children: ReactNode;
  compact?: boolean;
  leading?: ReactNode;
  count?: number;
  disclosure?: {
    expanded: boolean;
    count?: number;
    countLabel?: string;
    leading?: ReactNode;
    label: string;
    onPress: () => void;
  };
}) {
  const color = usePalette(),
    padded = useContext(PaddedContent);
  const title = (
    <Text
      accessibilityRole="header"
      style={[
        styles.heading,
        { color: compact && !disclosure ? color.muted : color.foreground },
        compact && { fontSize: 13, lineHeight: 20, letterSpacing: 0, fontWeight: "600" },
      ]}
    >
      {children}
    </Text>
  );
  return disclosure ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={disclosure.label}
      accessibilityState={{ expanded: disclosure.expanded }}
      {...(disclosure.count === undefined
        ? {}
        : {
            accessibilityValue: {
              text: disclosure.countLabel ?? t("ticket.list.count", { count: disclosure.count }),
            },
          })}
      onPress={disclosure.onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: padded ? 0 : 20,
        paddingVertical: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        backgroundColor: pressed ? color.accentSurface : "transparent",
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: color.line,
      })}
    >
      {disclosure.leading}
      <View style={{ flexShrink: 1, minWidth: 0 }}>{title}</View>
      {disclosure.count !== undefined && (
        <Text style={{ color: color.muted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
          {formatNumber(disclosure.count)}
        </Text>
      )}
      <View style={{ flex: 1 }} />
      <DecorativeIcon
        name={
          disclosure.expanded
            ? "chevron-down"
            : I18nManager.isRTL
              ? "chevron-back"
              : "chevron-forward"
        }
        size={14}
        color={color.muted}
        accessible={false}
      />
    </Pressable>
  ) : leading || count !== undefined ? (
    <View
      accessible
      accessibilityRole="header"
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 }}
    >
      {leading}
      <View style={{ flex: 1 }}>{title}</View>
      {count !== undefined && (
        <Text style={{ color: color.muted, fontSize: 12 }}>{formatNumber(count)}</Text>
      )}
    </View>
  ) : (
    title
  );
}
export function Section({
  title,
  children,
  collapsible = false,
  initiallyOpen = false,
  summary,
  count,
  countLabel,
}: {
  title: string;
  children: ReactNode;
  count?: number | undefined;
  countLabel?: string;
  collapsible?: boolean;
  initiallyOpen?: boolean;
  summary?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  return (
    <View
      style={{
        paddingTop: 8,
        gap: 8,
      }}
    >
      <Heading
        compact
        {...(collapsible
          ? {
              disclosure: {
                expanded,
                ...(count === undefined
                  ? {}
                  : { count, countLabel: countLabel ?? formatNumber(count) }),
                label: t(expanded ? "shell.ui.hideValue" : "shell.ui.showValue", { label: title }),
                onPress: () => setExpanded((value) => !value),
              },
            }
          : {})}
      >
        {title}
      </Heading>
      {!collapsible || expanded ? children : summary}
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
  allowDivision = false,
  scrollRef,
  header,
  scrollInsets = scroll,
}: {
  children: ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  form?: boolean;
  background?: string | null;
  safeArea?: boolean;
  allowDivision?: boolean;
  scrollRef?: ComponentProps<typeof ScrollView>["ref"];
  header?: ReactNode;
  scrollInsets?: boolean;
}) {
  const color = usePalette(),
    live = useContext(LiveStatus),
    boundary = !useContext(InsetsConsumed);
  const navigation = useContext(NavigationContext),
    inheritedHeader = useContext(ScrollingHeader);
  const ios = Platform.OS === "ios",
    modern = ios && Number.parseInt(String(Platform.Version), 10) >= 26;
  const nativeScroll = !!navigation && ios && scrollInsets && !background;
  useLayoutEffect(() => {
    if (!navigation || !boundary || !ios) return;
    navigation.setOptions(
      nativeHeaderOptions({
        headerTransparent: nativeScroll,
        headerStyle: { backgroundColor: nativeScroll ? "transparent" : color.surface },
        headerBlurEffect: nativeScroll && !modern ? "systemMaterial" : "none",
        ...(modern ? { scrollEdgeEffects: { top: "soft", bottom: "soft" } } : {}),
      }),
    );
  }, [navigation, boundary, ios, nativeScroll, modern, color.surface]);
  const status =
    boundary && (live === "offline" || live === "signedOut") ? (
      <View style={{ paddingHorizontal: 16, paddingVertical: 6 }} accessibilityLiveRegion="polite">
        <Body small muted>
          {t(`native.connection.${live}`)}
        </Body>
      </View>
    ) : null;
  const top =
    status || header || (!boundary && inheritedHeader) ? (
      <>
        {!boundary && inheritedHeader}
        {status}
        {header}
      </>
    ) : null;
  const content = (
    <ImageSurface value={!!background}>
      <View style={[{ flex: 1, backgroundColor: color.surface }, style]}>
        {background && (
          <AccountImage uri={background} style={[StyleSheet.absoluteFill, { opacity: 0.08 }]} />
        )}
        <ContentArea
          enabled={!!navigation && safeArea}
          allowDivision={allowDivision}
          scrollInsets={nativeScroll}
        >
          <ScrollingHeader value={top}>
            <PaddedContent value={scroll}>
              {scroll ? (
                <Scroll
                  ref={scrollRef}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode="interactive"
                  contentContainerStyle={{
                    paddingHorizontal: 16,
                    paddingTop: 12,
                    paddingBottom: 40,
                    gap: 12,
                    width: "100%",
                    maxWidth: navigation ? 720 : 560,
                    alignSelf: "center",
                  }}
                >
                  {children}
                </Scroll>
              ) : (
                children
              )}
            </PaddedContent>
          </ScrollingHeader>
        </ContentArea>
      </View>
    </ImageSurface>
  );
  return form ? <NativeForm>{content}</NativeForm> : content;
}
// Screen's scrolling primitive also serves layouts that own their scrolling content.
export function Scroll({ children, ...props }: ComponentProps<typeof ScrollView>) {
  const header = useContext(ScrollingHeader);
  return (
    <ScrollView {...scrollInsetsDefaults} {...props}>
      <ScrollingHeader value={props.horizontal ? header : null}>
        {!props.horizontal && header}
        {children}
      </ScrollingHeader>
    </ScrollView>
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
                  { visibilityPriority: "high", identifier: "form-submit" },
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
  if (!offset && (total === undefined || total <= limit)) return null;
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
export function List<T>({
  onRefresh,
  ...props
}: Omit<LegendListProps<T>, "onRefresh" | "refreshing"> & {
  onRefresh?: () => Promise<unknown>;
}) {
  const [refreshing, setRefreshing] = useState(false),
    header = useContext(ScrollingHeader);
  const original = props.ListHeaderComponent;
  const listHeader = header ? (
    <>
      {header}
      {isValidElement(original) ? original : original ? createElement(original) : null}
    </>
  ) : (
    original
  );
  async function refresh() {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } catch {
      /* The owning query renders the failure; this state tracks only the gesture. */
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <ScrollingHeader value={null}>
      <LegendList
        recycleItems
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        {...scrollInsetsDefaults}
        {...props}
        ListHeaderComponent={listHeader}
        // Recycled rows memoize data; renderer state also owns selection and active styling.
        extraData={props.extraData ?? props.renderItem}
        refreshing={refreshing}
        {...(onRefresh
          ? {
              onRefresh: () => {
                void refresh();
              },
            }
          : {})}
      />
    </ScrollingHeader>
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
  active = false,
  dense = false,
  compact = false,
  disabled = false,
  accessibilityLabel,
  style,
  interaction = "navigate",
  emphasized = false,
  captionLines,
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
  active?: boolean;
  dense?: boolean;
  compact?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  interaction?: "navigate" | "choice" | "action" | "content";
  emphasized?: boolean;
  captionLines?: number;
}) {
  const color = usePalette();
  const imageSurface = useContext(ImageSurface),
    padded = useContext(PaddedContent);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{
        ...(selected !== undefined || active ? { selected: selected ?? active } : {}),
        disabled,
      }}
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
          paddingVertical: compact || dense ? 10 : 12,
          paddingHorizontal: compact || padded ? 0 : 16,
          gap: 12,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderColor: color.line,
          borderStartWidth: 2,
          borderStartColor: active || selected ? color.accent : "transparent",
          backgroundColor:
            selected || active
              ? color.accentSurface
              : pressed
                ? color.background
                : imageSurface
                  ? "transparent"
                  : color.surface,
        },
        style,
      ]}
    >
      {leading}
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
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
            fontSize: compact ? 15 : 16,
            fontWeight: emphasized ? "600" : "500",
            lineHeight: 23,
            letterSpacing: -0.2,
          }}
        >
          {title}
        </Text>
        {caption && (
          <Text
            numberOfLines={captionLines}
            style={{ color: color.muted, fontSize: 12, lineHeight: 18 }}
          >
            {caption}
          </Text>
        )}
        {metadata && <View style={[styles.actions, { columnGap: 10, rowGap: 2 }]}>{metadata}</View>}
      </View>
      {trailing ??
        ((selected || interaction === "navigate") && (
          <DecorativeIcon
            name={selected ? "checkmark" : "chevron-forward"}
            size={16}
            color={selected ? color.accent : color.muted}
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        ))}
    </Pressable>
  );
}
export function TicketRow({
  ticket,
  onPress,
  onLongPress,
  selected,
  active = false,
  showStatus = true,
  selecting = false,
  showProject = false,
  density = "compact",
}: {
  ticket: Pick<Ticket, "id" | "projectId" | "key" | "title" | "status"> & Partial<Ticket>;
  onPress: () => void;
  onLongPress?: (() => void) | undefined;
  selected?: boolean | undefined;
  active?: boolean;
  showStatus?: boolean;
  selecting?: boolean;
  showProject?: boolean;
  density?: "standard" | "compact" | "schedule";
}) {
  const schedule = density === "schedule";
  const color = usePalette(),
    projects = useAllProjects(),
    now = useNow();
  const project = showProject
    ? projects.data?.find((item) => item.id === ticket.projectId)
    : undefined;
  const overdue =
    !!ticket.dueAt &&
    new Date(ticket.dueAt).getTime() < now &&
    !["done", "cancelled"].includes(ticket.status);
  const catalog = useTicketCatalog(ticket.projectId, ticket.stateId, ticket.assigneeId);
  const spoken = formatList([
    ticket.key,
    ticket.title,
    propertyDescription(
      { property: "status", value: ticket.status, stateId: ticket.stateId },
      catalog,
    ),
    ...(ticket.priority === undefined
      ? []
      : [propertyDescription({ property: "priority", value: ticket.priority }, catalog)]),
    ...(ticket.kind === undefined
      ? []
      : [propertyDescription({ property: "kind", value: ticket.kind }, catalog)]),
    ...(ticket.difficulty === undefined
      ? []
      : [propertyDescription({ property: "difficulty", value: ticket.difficulty }, catalog)]),
    ...(ticket.assigneeId === undefined
      ? []
      : [propertyDescription({ property: "assignee", value: ticket.assigneeId }, catalog)]),
    ...(ticket.labels?.length
      ? [
          t("ticket.tags.summary", {
            label: t("ticket.tags.labels"),
            tags: formatList(ticket.labels),
          }),
        ]
      : []),
    ...(ticket.scopes?.length
      ? [
          t("ticket.tags.summary", {
            label: t("ticket.tags.scopes"),
            tags: formatList(ticket.scopes),
          }),
        ]
      : []),
    ...(ticket.startAt || ticket.dueAt ? [ticketScheduleText(ticket)] : []),
  ]);
  return (
    <Row
      title={ticket.title}
      accessibilityLabel={spoken}
      dense
      style={schedule ? { paddingVertical: 8, paddingHorizontal: 12 } : undefined}
      active={active}
      leading={
        !showStatus ? (
          <View style={{ alignSelf: "flex-start", paddingTop: 3 }}>
            <PropertyValue
              projectId={ticket.projectId}
              property="status"
              value={ticket.status}
              stateId={ticket.stateId ?? null}
              iconOnly
            />
          </View>
        ) : undefined
      }
      trailing={
        selecting ? (
          <DecorativeIcon
            name={selected ? "checkmark-circle" : "ellipse-outline"}
            size={22}
            color={selected ? color.accent : color.muted}
          />
        ) : (
          false
        )
      }
      metadata={
        <View style={{ gap: 4, width: "100%" }}>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              columnGap: schedule ? 6 : 10,
              rowGap: 4,
            }}
          >
            {project && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <ProjectIcon project={project} size={14} />
                <Body muted small>
                  {project.name}
                </Body>
              </View>
            )}
            <Body muted small>
              {ticket.key}
            </Body>
            {showStatus && (
              <PropertyValue
                projectId={ticket.projectId}
                property="status"
                value={ticket.status}
                stateId={ticket.stateId ?? null}
                iconOnly
              />
            )}
            {ticket.priority !== undefined && ticket.priority !== "none" && (
              <PropertyValue
                projectId={ticket.projectId}
                property="priority"
                value={ticket.priority}
                iconOnly
              />
            )}
            {!schedule && ticket.kind !== undefined && (
              <PropertyValue
                projectId={ticket.projectId}
                property="kind"
                value={ticket.kind}
                iconOnly
              />
            )}
            {density === "standard" && ticket.difficulty && (
              <PropertyValue
                projectId={ticket.projectId}
                property="difficulty"
                value={ticket.difficulty}
                iconOnly
              />
            )}
            {ticket.assigneeId && (
              <PropertyValue
                projectId={ticket.projectId}
                property="assignee"
                value={ticket.assigneeId ?? null}
                iconOnly
              />
            )}
            {!schedule && (ticket.dueAt || ticket.startAt) && (
              <View
                accessible
                accessibilityLabel={
                  ticket.dueAt
                    ? t("native.ticket.due", { date: formatDate(ticket.dueAt) })
                    : t("native.ticket.starts", { date: formatDate(ticket.startAt ?? "") })
                }
                style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
              >
                <TicketGlyph
                  name="calendar-clock"
                  color={overdue ? color.danger : color.muted}
                  size={14}
                />
                <Text style={{ color: overdue ? color.danger : color.muted, fontSize: 12 }}>
                  {formatDate(ticket.dueAt ?? ticket.startAt ?? "", {
                    month: "short",
                    day: "numeric",
                  })}
                </Text>
              </View>
            )}
          </View>
          <TicketTags
            projectId={ticket.projectId}
            tags={ticket.labels ?? []}
            scopes={ticket.scopes ?? []}
            preview={density !== "standard"}
          />
        </View>
      }
      onPress={onPress}
      onLongPress={onLongPress}
      selected={selected}
    />
  );
}

// Ticket surfaces share a single wrapping label/scope flow.
export function TicketTags({
  projectId,
  tags,
  scopes = [],
  preview = false,
}: {
  projectId: string;
  tags: string[];
  scopes?: string[];
  preview?: boolean;
}) {
  const { api } = useConnection(),
    color = usePalette(),
    { fontScale } = useWindowDimensions();
  const catalog = useQuery({
    ...api.query("list_project_labels", { projectId }),
    enabled: tags.length > 0,
  });
  const [available, setAvailable] = useState(0),
    [widths, setWidths] = useState<Record<string, number>>({});
  const items = [
    ...tags.map((tag) => ({ tag, kind: "label" as const })),
    ...scopes.map((tag) => ({ tag, kind: "scope" as const })),
  ];
  const keyOf = (item: { tag: string; kind: string }) => `${fontScale}:${item.kind}:${item.tag}`;
  const overflowKey = `${fontScale}:overflow:${items.length}`;
  const measured =
    items.every((item) => widths[keyOf(item)] !== undefined) && widths[overflowKey] !== undefined;
  const count = !preview
    ? items.length
    : measured
      ? inlineItemCount(
          items.map((item) => widths[keyOf(item)] ?? 0),
          available,
          widths[overflowKey] ?? 0,
        )
      : 0;
  const label = formatList([
    ...(tags.length
      ? [t("ticket.tags.summary", { label: t("ticket.tags.labels"), tags: formatList(tags) })]
      : []),
    ...(scopes.length
      ? [t("ticket.tags.summary", { label: t("ticket.tags.scopes"), tags: formatList(scopes) })]
      : []),
  ]);
  function measure(key: string, width: number) {
    setWidths((previous) => (previous[key] === width ? previous : { ...previous, [key]: width }));
  }
  const chip = (item: { tag: string; kind: "label" | "scope" }, measuring = false) => (
    <TicketTag
      key={keyOf(item)}
      tag={item.tag}
      kind={item.kind}
      color={catalog.data?.find((entry) => entry.name === item.tag)?.color ?? "gray"}
      {...(measuring
        ? { onLayout: (event) => measure(keyOf(item), event.nativeEvent.layout.width) }
        : {})}
    />
  );
  if (!items.length) return null;
  return (
    <View
      accessible
      accessibilityLabel={label}
      onLayout={preview ? (event) => setAvailable(event.nativeEvent.layout.width) : undefined}
      style={[
        { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 5 },
        preview && { width: "100%", minHeight: 22 },
      ]}
    >
      {items.slice(0, count).map((item) => chip(item))}
      {count < items.length && (
        <Text
          style={{ color: color.muted, fontSize: 12, lineHeight: 18 }}
        >{`+${formatNumber(items.length - count)}`}</Text>
      )}
      {preview && (
        <View
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            position: "absolute",
            start: 0,
            top: 0,
            width: "100%",
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 5,
            opacity: 0,
          }}
        >
          {items.map((item) => chip(item, true))}
          <Text
            onLayout={(event) => measure(overflowKey, event.nativeEvent.layout.width)}
            style={{ fontSize: 12, lineHeight: 18 }}
          >{`+${formatNumber(items.length)}`}</Text>
        </View>
      )}
    </View>
  );
}

export function RemovableSummary({
  value,
  label,
  icon = "search",
  onClear,
}: {
  value: string;
  label: string;
  icon?: ComponentProps<typeof Ionicons>["name"];
  onClear: () => void;
}) {
  const color = usePalette();
  return value.trim() ? (
    <Row
      title={value}
      dense
      accessibilityLabel={t("native.labelValue", {
        label,
        value,
      })}
      leading={<DecorativeIcon name={icon} size={16} color={color.muted} accessible={false} />}
      trailing={
        <DecorativeIcon name="close-circle" size={18} color={color.muted} accessible={false} />
      }
      onPress={onClear}
    />
  ) : null;
}

export function ContextBar({ children }: { children: ReactNode }) {
  const padded = useContext(PaddedContent);
  return (
    <View
      style={{
        paddingHorizontal: padded ? 0 : 16,
        paddingVertical: 4,
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 4,
      }}
    >
      {children}
    </View>
  );
}
export function WorkspaceScope({ children }: { children?: ReactNode }) {
  const { active } = useWorkspace(),
    { showPicker } = useProjectNavigation(),
    color = usePalette();
  return (
    <ContextBar>
      <Button
        compact
        plain
        title={active?.name ?? t("shell.app.noWorkspaceSelected")}
        accessibilityLabel={t("native.labelValue", {
          label: t("native.navigation.switchProject"),
          value: active?.name ?? t("shell.app.noWorkspaceSelected"),
        })}
        leading={<TicketGlyph name="building-2" size={16} color={color.muted} />}
        trailing={
          <DecorativeIcon name="chevron-down" size={12} color={color.muted} accessible={false} />
        }
        onPress={showPicker}
      />
      {children}
    </ContextBar>
  );
}
// Compatibility entrypoint for relationships and schedules, using the common property renderer.
export function Status({ ticket }: { ticket: Pick<Ticket, "projectId" | "status" | "stateId"> }) {
  return (
    <PropertyValue
      projectId={ticket.projectId}
      property="status"
      value={ticket.status}
      stateId={ticket.stateId}
    />
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
    styles: {
      text: { fontSize: 16, lineHeight: 24 },
      h1: { fontSize: 22, lineHeight: 29 },
      h2: { fontSize: 20, lineHeight: 27 },
      h3: { fontSize: 18, lineHeight: 25 },
      h4: { fontSize: 16, lineHeight: 23 },
    },
  });
  return <View>{elements}</View>;
}
export const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    minWidth: 44,
    borderWidth: 0,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  field: { gap: 8 },
  label: { fontSize: 13, fontWeight: "500" },
  input: {
    borderWidth: 0,
    borderRadius: 0,
    paddingVertical: 10,
    paddingHorizontal: 0,
    minHeight: 48,
    fontSize: 16,
  },
  heading: { fontSize: 21, fontWeight: "600", letterSpacing: -0.4 },
  check: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: 10 },
  modal: { flex: 1, justifyContent: "flex-end" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
});
