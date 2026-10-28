import { useLayoutEffect, type ReactNode } from "react";
import { View } from "react-native";
import { MeasuredViewport, useNativeViewport, ViewportPane } from "./ui.tsx";
import { paneLayout, usableViewport } from "./pane-layout.ts";

export type SplitState = { collapsed: boolean; secondaryVisible: boolean };
type SplitProps = {
  primary: ReactNode;
  secondary: ReactNode;
  secondaryActive: boolean;
  primaryHidden?: boolean;
  enabled?: boolean;
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
  enabled = true,
  onChange,
}: SplitProps) {
  const { bounds, regions } = useNativeViewport();
  const adaptive = paneLayout(bounds, regions),
    layout = enabled ? adaptive : paneLayout(bounds, regions, false),
    collapsed = layout.collapsed,
    detailOnly = secondaryActive && (collapsed || primaryHidden);
  useLayoutEffect(() => {
    // Report responsive capacity even while the sidebar is inactive, before the next push.
    onChange?.({ collapsed: adaptive.collapsed, secondaryVisible: secondaryActive });
  }, [adaptive.collapsed, secondaryActive, onChange]);
  const first = (
    <ViewportPane
      key="primary"
      rect={layout.primary}
      viewportWidth={bounds.width}
      visible={!detailOnly}
    >
      {primary}
    </ViewportPane>
  );
  const second = (
    <ViewportPane
      key="secondary"
      rect={primaryHidden && secondaryActive ? usableViewport(bounds, regions) : layout.secondary}
      viewportWidth={bounds.width}
      visible={!collapsed || secondaryActive}
      inheritHeader={detailOnly}
    >
      {secondary}
    </ViewportPane>
  );
  return <View style={{ flex: 1 }}>{detailOnly ? [second, first] : [first, second]}</View>;
}
