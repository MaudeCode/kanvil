import type { ExpoConfig } from "expo/config";
import { palettes } from "../../packages/contracts/src/theme.ts";
const applicationId = "dev.kil.kanvil";
const config: ExpoConfig = {
  name: "Kanvil",
  slug: "kanvil",
  version: process.env.KANVIL_IOS_VERSION ?? "0.1.0",
  scheme: "kanvil",
  icon: "./assets/icon.png",
  orientation: "default",
  platforms: ["ios", "android"],
  userInterfaceStyle: "automatic",
  ...(process.env.EXPO_PUBLIC_EAS_PROJECT_ID
    ? { extra: { eas: { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID } } }
    : {}),
  ios: {
    bundleIdentifier: applicationId,
    buildNumber: process.env.KANVIL_IOS_BUILD_NUMBER ?? "26",
    supportsTablet: true,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      KanvilStartupDiagnostics: process.env.EXPO_PUBLIC_STARTUP_DIAGNOSTICS === "1",
    },
  },
  android: {
    package: applicationId,
    versionCode: 13,
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      monochromeImage: "./assets/adaptive-icon.png",
      backgroundColor: palettes.light.accent,
    },
  },
  plugins: [
    "expo-secure-store",
    "expo-document-picker",
    [
      "expo-notifications",
      { icon: "./assets/notification-icon.png", color: palettes.light.accent },
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-light.png",
        backgroundColor: palettes.light.background,
        dark: { image: "./assets/splash-dark.png", backgroundColor: palettes.dark.background },
        imageWidth: 220,
        resizeMode: "contain",
      },
    ],
    "expo-font",
    "./plugins/with-startup-diagnostics.cjs",
  ],
};
export default config;
