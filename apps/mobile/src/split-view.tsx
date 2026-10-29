import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { NavigationContext } from "@react-navigation/native";
import { formatNumber, t } from "@kanvil/contracts/i18n";
import {
  ErrorNotice,
  MeasuredViewport,
  useNativeViewport,
  usePalette,
  ViewportPane,
} from "./ui.tsx";
import {
  minimumPrimary,
  minimumSecondary,
  splitResizeTarget,
  paneLayout,
  primaryPaneWidth,
  usableViewport,
} from "./pane-layout.ts";
import { setAppearance, useAppearance } from "./theme.ts";
import { paneNavigationOptions } from "./navigation-actions.tsx";

export type SplitState = { collapsed: boolean; secondaryVisible: boolean };
type SplitProps = {
  primary: ReactNode;
  secondary: ReactNode;
  secondaryActive: boolean;
  primaryHidden?: boolean;
  secondaryHidden?: boolean;
  enabled?: boolean;
  nativeHeader?: boolean;
  minimumPrimaryWidth?: number;
  primaryHeader?: "scroll" | "frame";
  onChange?: (state: SplitState) => void;
};

// All content stays in its existing RN views; the native Screen supplies fold geometry.
export function SplitView(props: SplitProps) {
  return (
    <MeasuredViewport allowDivision>
      <Panes {...props} />
    </MeasuredViewport>
  );
}
function Panes({
  primary,
  secondary,
  secondaryActive,
  primaryHidden = false,
  secondaryHidden = false,
  enabled = true,
  nativeHeader = true,
  minimumPrimaryWidth = minimumPrimary,
  primaryHeader = "scroll",
  onChange,
}: SplitProps) {
  const { bounds, regions } = useNativeViewport();
  const navigation = useContext(NavigationContext),
    color = usePalette(),
    appearance = useAppearance();
  const [dragWidth, setDragWidth] = useState<number>(),
    [error, setError] = useState<unknown>(),
    [dragging, setDragging] = useState(false);
  const adaptive = paneLayout(
      bounds,
      regions,
      true,
      dragWidth ?? appearance.sidebarWidth,
      minimumPrimaryWidth,
    ),
    layout = enabled ? adaptive : paneLayout(bounds, regions, false),
    collapsed = layout.collapsed,
    detailOnly = secondaryActive && (collapsed || primaryHidden),
    primaryOnly = secondaryHidden && !secondaryActive;
  // A posture change must not transfer a mounted scroller between inset owners.
  const ownsInsets = nativeHeader || enabled;
  const resize = useRef({
    bounds,
    width: layout.primary.width,
    origin: 0,
    startWidth: 0,
    minimum: minimumPrimaryWidth,
  });
  useLayoutEffect(() => {
    resize.current.bounds = bounds;
    resize.current.width = layout.primary.width;
    resize.current.minimum = minimumPrimaryWidth;
  }, [bounds, layout.primary.width, minimumPrimaryWidth]);
  const commitWidth = (width: number) => {
    void setAppearance({
      sidebarWidth: primaryPaneWidth(bounds, width, minimumPrimaryWidth),
    }).catch(setError);
  };
  useLayoutEffect(() => {
    if (!nativeHeader || !navigation) return undefined;
    // One minimising bar cannot move two independent reading panes.
    navigation.setOptions(paneNavigationOptions(collapsed));
    return () => navigation.setOptions(paneNavigationOptions(true, true));
  }, [nativeHeader, navigation, collapsed]);
  useLayoutEffect(() => {
    // Report responsive capacity even while the sidebar is inactive, before the next push.
    onChange?.({ collapsed: adaptive.collapsed, secondaryVisible: secondaryActive });
  }, [adaptive.collapsed, secondaryActive, onChange]);
  const first = (
    <ViewportPane
      key="primary"
      rect={primaryOnly ? usableViewport(bounds, regions) : layout.primary}
      viewportWidth={bounds.width}
      visible={!detailOnly}
      // Paired columns use the sidebar palette; a sole collection shares its outer canvas.
      sidebar={!collapsed && !primaryOnly}
      insetHeader={primaryHeader === "frame"}
      manualInsets={ownsInsets}
    >
      {primary}
    </ViewportPane>
  );
  const second = (
    <ViewportPane
      key="secondary"
      rect={primaryHidden && secondaryActive ? usableViewport(bounds, regions) : layout.secondary}
      viewportWidth={bounds.width}
      visible={!primaryOnly && (!collapsed || secondaryActive)}
      inheritHeader={detailOnly}
      manualInsets={ownsInsets}
    >
      {secondary}
    </ViewportPane>
  );
  return (
    <View style={{ flex: 1 }}>
      {detailOnly ? [second, first] : [first, second]}
      {!detailOnly && !primaryOnly && !collapsed && "resizable" in layout && (
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: layout.primary.width - splitResizeTarget / 2,
            width: splitResizeTarget,
          }}
        >
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: splitResizeTarget / 2,
              width: StyleSheet.hairlineWidth,
              backgroundColor: color.line,
            }}
          />
          <View
            onStartShouldSetResponder={() => true}
            onResponderGrant={(event) => {
              resize.current.origin = event.nativeEvent.pageX;
              resize.current.startWidth = resize.current.width;
              setDragging(true);
            }}
            onResponderMove={(event) =>
              setDragWidth(
                primaryPaneWidth(
                  resize.current.bounds,
                  resize.current.startWidth + event.nativeEvent.pageX - resize.current.origin,
                  resize.current.minimum,
                ),
              )
            }
            onResponderRelease={(event) => {
              const width = primaryPaneWidth(
                resize.current.bounds,
                resize.current.startWidth + event.nativeEvent.pageX - resize.current.origin,
                resize.current.minimum,
              );
              void setAppearance({ sidebarWidth: width }).catch(setError);
              setDragWidth(undefined);
              setDragging(false);
            }}
            onResponderTerminate={() => {
              setDragWidth(undefined);
              setDragging(false);
            }}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={t("shell.primitive.resizeSidebar")}
            accessibilityValue={{
              min: minimumPrimaryWidth,
              max: Math.round(bounds.width - minimumSecondary),
              now: Math.round(layout.primary.width),
              text: formatNumber(layout.primary.width / bounds.width, {
                style: "percent",
                maximumFractionDigits: 0,
              }),
            }}
            accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
            onAccessibilityAction={(event) => {
              const action = event.nativeEvent.actionName;
              if (action === "increment" || action === "decrement")
                commitWidth(layout.primary.width + (action === "increment" ? 32 : -32));
            }}
            style={{
              position: "absolute",
              top: "50%",
              marginTop: -splitResizeTarget / 2,
              height: splitResizeTarget,
              width: splitResizeTarget,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <View
              pointerEvents="none"
              style={{
                width: 4,
                height: 32,
                borderRadius: 2,
                backgroundColor: dragging ? color.accent : color.muted,
              }}
            />
          </View>
        </View>
      )}
      {!!error && <ErrorNotice error={error} />}
    </View>
  );
}
