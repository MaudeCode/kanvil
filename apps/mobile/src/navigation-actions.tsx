import type {
  NativeStackHeaderItemButton,
  NativeStackHeaderItemMenu,
  NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import { Button, type ColorValue } from "react-native";
import { t } from "@kanvil/contracts/i18n";

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

export function sidebarHeaderItem(onPress: () => void) {
  return createHeaderAction(
    t("shell.action.sidebar"),
    onPress,
    { type: "sfSymbol", name: "sidebar.left" },
    false,
    {
      identifier: "sidebar-toggle",
      visibilityPriority: "high",
    },
  );
}

export function paneNavigationOptions(
  minimize: boolean,
  allowBack = false,
): Pick<NativeStackNavigationOptions, "headerMinimizationEnabled" | "gestureEnabled"> {
  return { headerMinimizationEnabled: minimize, gestureEnabled: allowBack };
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
    createHeaderAction(title, showPicker, { type: "sfSymbol", name: "square.stack.3d.up" }, false, {
      identifier: "switch-project",
      visibilityPriority: "high",
      sharesBackground: false,
    }),
  ];
}
