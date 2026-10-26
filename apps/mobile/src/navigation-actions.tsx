import type { NativeStackHeaderItemButton } from "@react-navigation/native-stack";
import { Button, type ColorValue } from "react-native";

export type HeaderAction = Pick<NativeStackHeaderItemButton, "onPress" | "disabled"> & {
  title: string;
};
export function createHeaderFallback(action: HeaderAction | undefined, color: ColorValue) {
  return function HeaderButton() {
    return action ? (
      <Button
        title={action.title}
        onPress={action.onPress}
        disabled={action.disabled}
        color={color}
      />
    ) : null;
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
