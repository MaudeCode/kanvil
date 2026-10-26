import { iconFromLibrary } from "@kanvil/contracts/icons";
import { AccountImage } from "./image.tsx";
import { View, useColorScheme } from "react-native";
import { SvgXml } from "react-native-svg";
import { nativeAccentColor } from "@kanvil/contracts/colors";
import type { Project } from "@kanvil/contracts";
import { useNativePalette as usePalette } from "./theme.ts";

import { useIconLibrary } from "./icon-library.ts";
export { useIconLibrary } from "./icon-library.ts";
export function ProjectIcon({
  project,
  size = 30,
}: {
  project: Pick<Project, "iconName" | "iconColor" | "image">;
  size?: number;
}) {
  const library = useIconLibrary(!project.image),
    palette = usePalette(),
    mode = useColorScheme() === "dark" ? "dark" : "light";
  const icon = iconFromLibrary(library.data, project.iconName ?? "folder-open");
  const color = nativeAccentColor(project.iconColor, mode, palette);
  return (
    <View
      accessible={false}
      style={{ width: size, height: size, justifyContent: "center", alignItems: "center" }}
    >
      {project.image ? (
        <AccountImage
          uri={project.image}
          style={{ width: size, height: size, resizeMode: "contain" }}
        />
      ) : icon ? (
        <SvgXml
          width={size}
          height={size}
          color={color}
          xml={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${library.data?.width ?? 24} ${library.data?.height ?? 24}">${icon.body}</svg>`}
        />
      ) : null}
    </View>
  );
}
