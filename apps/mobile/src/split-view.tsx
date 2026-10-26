import { useEffect, useRef, type ReactNode } from "react";
import { Platform, View, useWindowDimensions } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Split, type SplitHostCommands } from "react-native-screens/experimental";

// Native counterpart of the web list/preview layout. UIKit owns collapse and fold avoidance;
// both columns stay mounted so folding cannot reset a ticket, form, or list position.
export function SplitView({
  primary,
  secondary,
  secondaryActive,
}: {
  primary: ReactNode;
  secondary: ReactNode;
  secondaryActive: boolean;
}) {
  const host = useRef<SplitHostCommands>(null),
    { width } = useWindowDimensions();
  useEffect(() => {
    host.current?.show(secondaryActive ? "secondary" : "primary");
  }, [secondaryActive]);
  if (Platform.OS === "ios" && Number.parseInt(Platform.Version, 10) >= 26)
    return (
      <Split.Host
        ref={host}
        style={{ flex: 1 }}
        preferredDisplayMode="oneBesideSecondary"
        topColumnForCollapsing={secondaryActive ? "secondary" : "primary"}
        columnMetrics={{
          minimumPrimaryColumnWidth: 280,
          maximumPrimaryColumnWidth: 420,
          preferredPrimaryColumnWidthOrFraction: 0.42,
          minimumSecondaryColumnWidth: 320,
        }}
        displayModeButtonVisibility="automatic"
      >
        <Split.Column>
          <SafeAreaProvider style={{ flex: 1, width: "100%", height: "100%" }}>
            {primary}
          </SafeAreaProvider>
        </Split.Column>
        <Split.Column>
          <SafeAreaProvider style={{ flex: 1, width: "100%", height: "100%" }}>
            {secondary}
          </SafeAreaProvider>
        </Split.Column>
      </Split.Host>
    );
  const wide = width >= 740;
  return (
    <View style={{ flex: 1, flexDirection: "row" }}>
      <View style={{ flex: wide ? 0.42 : 1, display: !wide && secondaryActive ? "none" : "flex" }}>
        {primary}
      </View>
      <View style={{ flex: wide ? 0.58 : 1, display: !wide && !secondaryActive ? "none" : "flex" }}>
        {secondary}
      </View>
    </View>
  );
}
