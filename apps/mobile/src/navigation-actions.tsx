import type { NativeStackHeaderItemButton } from "@react-navigation/native-stack";
import { Button, type ColorValue } from "react-native";

export type HeaderAction = Pick<NativeStackHeaderItemButton, "onPress" | "disabled"> & {
  title: string;
};
export function HeaderButton({
  action,
  color,
}: {
  action: HeaderAction | undefined;
  color: ColorValue;
}) {
  return action ? (
    <Button
      title={action.title}
      onPress={action.onPress}
      disabled={action.disabled}
      color={color}
    />
  ) : null;
}
export function createHeaderFallback(action: HeaderAction | undefined, color: ColorValue) {
  return function HeaderFallback() {
    return <HeaderButton action={action} color={color} />;
  };
}

// System bar items can move into Duo's rail; custom React header views cannot.
export function createHeaderAction(
  title: string,
  onPress: () => void,
  icon: NonNullable<NativeStackHeaderItemButton["icon"]>,
  disabled = false,
): NativeStackHeaderItemButton {
  return { type: "button", label: title, accessibilityLabel: title, icon, onPress, disabled };
}

// All browsing headers share the same picker, including headers that replace Back for a Split.
export function projectHeaderItems(showPicker: () => void, title: string, back?: HeaderAction) {
  return [
    ...(back
      ? [createHeaderAction(back.title, back.onPress, { type: "sfSymbol", name: "chevron.left" })]
      : []),
    createHeaderAction(title, showPicker, { type: "sfSymbol", name: "square.stack.3d.up" }),
  ];
}
