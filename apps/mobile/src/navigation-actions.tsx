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
  policy: Pick<
    NativeStackHeaderItemButton,
    "visibilityPriority" | "identifier" | "variant" | "sharesBackground"
  > = {},
): NativeStackHeaderItemButton {
  return {
    type: "button",
    label: title,
    accessibilityLabel: title,
    icon,
    onPress,
    disabled,
    identifier: `action:${icon.type === "sfSymbol" ? icon.name : title}`,
    visibilityPriority: "high",
    sharesBackground: false,
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
    identifier: `menu:${icon.type === "sfSymbol" ? icon.name : title}`,
    icon,
    menu: { items },
    sharesBackground: true,
    visibilityPriority: "low",
    ...policy,
  };
}

// Route placeholders and loaded ticket panes use the same native item identities.
export function ticketHeaderItems(edit: HeaderAction | undefined, more: HeaderAction) {
  return [
    ...(edit
      ? [
          createHeaderAction(
            edit.title,
            edit.onPress,
            { type: "sfSymbol", name: "square.and.pencil" },
            edit.disabled,
            { identifier: "ticket-edit" },
          ),
        ]
      : []),
    createHeaderAction(
      more.title,
      more.onPress,
      { type: "sfSymbol", name: "ticket" },
      more.disabled,
      {
        identifier: "ticket-actions",
        visibilityPriority: "low",
        sharesBackground: true,
      },
    ),
  ];
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
    createHeaderAction(title, showPicker, { type: "sfSymbol", name: "folder" }, false, {
      identifier: "switch-project",
      visibilityPriority: "low",
      sharesBackground: true,
    }),
  ];
}
