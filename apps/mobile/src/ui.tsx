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
import { useMarkdown } from "react-native-marked";
import { palettes } from "@kanvil/contracts/theme";
import { errorMessage, stateLabels, stateTones, type Ticket } from "@kanvil/contracts";

export const usePalette = () => palettes[useColorScheme() === "dark" ? "dark" : "light"];
export function Button({
  title,
  onPress,
  disabled = false,
  primary = false,
  danger = false,
  accessibilityLabel,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  accessibilityLabel?: string;
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
          borderColor: color.line,
          backgroundColor: primary ? color.accent : color.surface,
          opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
        },
      ]}
    >
      <Text
        style={{
          color: danger ? color.danger : primary ? color.surface : color.foreground,
          fontWeight: "600",
          fontSize: 15,
        }}
      >
        {title}
      </Text>
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
          { color: color.foreground, borderColor: color.line, backgroundColor: color.surface },
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
          accessibilityLabel="Dismiss"
          accessibilityRole="button"
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
        <SafeAreaView
          edges={["bottom"]}
          style={{ backgroundColor: color.surface, maxHeight: "88%" }}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            contentContainerStyle={{ padding: 20, gap: 16 }}
          >
            <Heading>{title}</Heading>
            {children}
            <Button title="Close" onPress={onClose} />
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
    [open, setOpen] = useState(false);
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: color.muted }]}>{label}</Text>
      <Button
        title={options.find((option) => option.value === value)?.label ?? value}
        accessibilityLabel={`${label}: ${options.find((option) => option.value === value)?.label ?? value}`}
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
      <Text style={{ color: checked ? color.accent : color.muted, fontSize: 22 }}>
        {checked ? "☑" : "☐"}
      </Text>
      <Text style={{ color: color.foreground, flex: 1 }}>{label}</Text>
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
    <ActivityIndicator accessibilityLabel="Loading" color={color.accent} style={{ margin: 24 }} />
  );
}
export function Body({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  const color = usePalette();
  return (
    <Text style={{ color: muted ? color.muted : color.foreground, lineHeight: 23, fontSize: 15 }}>
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
        paddingVertical: 22,
        gap: 12,
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
      style={[{ flex: 1, backgroundColor: color.background }, style]}
    >
      {scroll ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={{ padding: 20, paddingBottom: 48, gap: 14 }}
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
  onPress,
}: {
  title: string;
  caption?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
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
        paddingVertical: 18,
        paddingHorizontal: 20,
        gap: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: color.line,
        backgroundColor: pressed ? color.accentSurface : color.background,
      })}
    >
      {leading}
      <View style={{ flex: 1, gap: 7 }}>
        <Text style={{ color: color.foreground, fontSize: 16, fontWeight: "600", lineHeight: 23 }}>
          {title}
        </Text>
        {caption && (
          <Text style={{ color: color.muted, fontSize: 12, lineHeight: 18 }}>{caption}</Text>
        )}
      </View>
      {trailing}
    </Pressable>
  );
}
export function Status({ value }: { value: Ticket["status"] }) {
  const color = usePalette();
  return (
    <Text style={{ color: color[stateTones[value]], fontSize: 12 }}>● {stateLabels[value]}</Text>
  );
}
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
  });
  return <View>{elements}</View>;
}
export const styles = StyleSheet.create({
  button: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  field: { gap: 8 },
  label: { fontSize: 12, fontWeight: "600" },
  input: { borderWidth: 1, borderRadius: 6, padding: 12, minHeight: 46, fontSize: 16 },
  heading: { fontSize: 20, fontWeight: "700", letterSpacing: -0.4 },
  check: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: 10 },
  modal: { flex: 1, justifyContent: "flex-end" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
});
