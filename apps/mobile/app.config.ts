import type { ExpoConfig } from "expo/config";
const config: ExpoConfig = {
  name: "Kanvil",
  slug: "kanvil",
  version: "0.1.0",
  scheme: "kanvil",
  icon: "./assets/icon.png",
  orientation: "default",
  platforms: ["ios", "android"],
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: "com.maudecode.kanvil",
    supportsTablet: true,
    infoPlist: { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } },
  },
  android: { package: "com.maudecode.kanvil" },
  plugins: [
    "expo-secure-store",
    "expo-document-picker",
    "expo-notifications",
    "expo-font",
    ["expo-build-properties", { ios: { enableSceneSupport: true } }],
  ],
};
export default config;
