import { useEffect, type ReactNode } from "react";
import { View } from "react-native";
import { MeasuredViewport, useNativeViewport, ViewportPane } from "./ui.tsx";
import { paneLayout, usableViewport } from "./pane-layout.ts";

type SplitProps = {
  primary: ReactNode;
  secondary: ReactNode;
  secondaryActive: boolean;
  primaryHidden?: boolean;
  enabled?: boolean;
  onChange?: (state: { collapsed: boolean; secondaryVisible: boolean }) => void;
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
  const layout = paneLayout(bounds, regions, enabled),
    collapsed = layout.collapsed,
    detailOnly = secondaryActive && (collapsed || primaryHidden);
  useEffect(() => {
    onChange?.({ collapsed, secondaryVisible: secondaryActive });
  }, [collapsed, secondaryActive, onChange]);
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
