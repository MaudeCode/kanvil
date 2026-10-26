import type {
  NativeStackHeaderItemButton,
  NativeStackHeaderItemMenu,
} from "@react-navigation/native-stack";
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
  policy: Pick<NativeStackHeaderItemButton, "visibilityPriority" | "identifier" | "variant"> = {},
): NativeStackHeaderItemButton {
  return {
    type: "button",
    label: title,
    accessibilityLabel: title,
    icon,
    onPress,
    disabled,
    ...(policy.visibilityPriority
      ? { sharesBackground: policy.visibilityPriority !== "high" }
      : {}),
    ...policy,
  };
}

// Menus need their own semantic symbol; UIKit reserves ellipsis for system overflow.
export function createHeaderMenu(
  title: string,
  icon: NonNullable<NativeStackHeaderItemMenu["icon"]>,
  items: NativeStackHeaderItemMenu["menu"]["items"],
  policy: Pick<NativeStackHeaderItemMenu, "visibilityPriority" | "identifier" | "badge"> = {},
): NativeStackHeaderItemMenu {
  return {
    type: "menu",
    label: title,
    accessibilityLabel: title,
    icon,
    menu: { items },
    sharesBackground: true,
    visibilityPriority: "low",
    ...policy,
  };
}

// All browsing headers share the same picker, including headers that replace Back for a Split.
export function projectHeaderItems(showPicker: () => void, title: string, back?: HeaderAction) {
  return [
    ...(back
      ? [
          createHeaderAction(back.title, back.onPress, {
            type: "sfSymbol",
            name: "chevron.backward",
          }),
        ]
      : []),
    createHeaderAction(title, showPicker, { type: "sfSymbol", name: "folder" }),
  ];
}
