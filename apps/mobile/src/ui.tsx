import { LegendList, type LegendListProps } from "@legendapp/list/react-native";
import { useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
  type TextInputProps,
  type ViewStyle,
  type StyleProp,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Picker } from "@react-native-picker/picker";
import Ionicons from "@expo/vector-icons/Ionicons";
import Svg, { Path } from "react-native-svg";
import { Renderer, useMarkdown } from "react-native-marked";
import { brandMark, palettes } from "@kanvil/contracts/theme";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "./data.tsx";
import {
  errorMessage,
  mentionScheme,
  stateLabels,
  stateTones,
  type Ticket,
  presentWorkflow,
} from "@kanvil/contracts";
import { t } from "@kanvil/contracts/i18n";

export const usePalette = () => palettes[useColorScheme() === "dark" ? "dark" : "light"];
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
              ? color.surface
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
export function Field({ label, ...props }: TextInputProps & { label: string }) {
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
export function Sheet({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const color = usePalette();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={[styles.modal, { backgroundColor: color.backdrop }]}
      >
        <Pressable
          accessibilityLabel={t("native.ui.dismiss")}
          accessibilityRole="button"
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
        <SafeAreaView
          edges={["bottom"]}
          style={{
            backgroundColor: color.surface,
            maxHeight: "88%",
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
          }}
        >
          <View
            style={{
              width: 36,
              height: 5,
              borderRadius: 3,
              backgroundColor: color.line,
              alignSelf: "center",
              marginTop: 10,
            }}
          />
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            contentContainerStyle={{ padding: 20, gap: 16 }}
          >
            <View style={[styles.actions, { justifyContent: "space-between" }]}>
              <View style={{ flex: 1 }}>
                <Heading>{title}</Heading>
              </View>
              <Button title={t("common.action.close")} plain compact onPress={onClose} />
            </View>
            {children}
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
export function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const color = usePalette(),
    [open, setOpen] = useState(false),
    selected = options.find((option) => option.value === value)?.label ?? value;
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: color.muted }]}>{label}</Text>
      <Button
        disclosure
        title={selected}
        accessibilityLabel={t("native.labelValue", { label, value: selected })}
        onPress={() => setOpen(true)}
      />
      <Sheet title={label} open={open} onClose={() => setOpen(false)}>
        <Picker
          accessibilityLabel={label}
          selectedValue={value}
          onValueChange={(next) => onChange(next)}
          itemStyle={{ color: color.foreground }}
          style={{ color: color.foreground }}
        >
          {options.map((option) => (
            <Picker.Item key={option.value} value={option.value} label={option.label} />
          ))}
        </Picker>
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
export function Heading({ children }: { children: ReactNode }) {
  const color = usePalette();
  return (
    <Text accessibilityRole="header" style={[styles.heading, { color: color.foreground }]}>
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
        paddingVertical: 26,
        gap: 14,
      }}
    >
      <Heading>{title}</Heading>
      {children}
    </View>
  );
}
export function Screen({
  children,
  scroll = true,
  style,
}: {
  children: ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const color = usePalette();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
      style={[{ flex: 1, backgroundColor: color.surface }, style]}
    >
      {scroll ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={{ padding: 22, paddingBottom: 48, gap: 16 }}
        >
          {children}
        </ScrollView>
      ) : (
        children
      )}
    </KeyboardAvoidingView>
  );
}
export function List<T>(props: LegendListProps<T>) {
  return <LegendList recycleItems keyboardDismissMode="interactive" {...props} />;
}
export function Row({
  title,
  caption,
  leading,
  trailing,
  overline,
  metadata,
  onPress,
}: {
  title: string;
  caption?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  overline?: string;
  metadata?: ReactNode;
  onPress: () => void;
}) {
  const color = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        Keyboard.dismiss();
        onPress();
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 22,
        paddingHorizontal: 20,
        gap: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: color.line,
        backgroundColor: pressed ? color.accentSurface : color.surface,
      })}
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
            fontSize: 17,
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
      {trailing ?? <Ionicons name="chevron-forward" size={16} color={color.muted} />}
    </Pressable>
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
  return (
    <Text
      style={{
        color: color[stateTones[ticket.status]],
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
