import { Image, type ImageStyle, type StyleProp } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { serverImageURI } from "@kanvil/contracts/media";
import { useConnection, useIdentity } from "./data.tsx";

// Cookies are never attached to external images or arbitrary server routes.
export function AccountImage({ uri, style }: { uri: string; style: StyleProp<ImageStyle> }) {
  const connection = useConnection(),
    identity = useIdentity();
  const image = serverImageURI(connection.baseUrl, uri);
  const headers = useQuery({
    queryKey: ["image-session", connection.baseUrl, identity.id],
    queryFn: connection.headers,
    enabled: !!image,
    staleTime: 60000,
  });
  return image && headers.data ? (
    <Image
      source={{ uri: image, headers: headers.data }}
      style={style}
      accessibilityIgnoresInvertColors
    />
  ) : null;
}
