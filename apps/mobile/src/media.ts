import { Image } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { File } from "expo-file-system";
import { attachmentLimit } from "@kanvil/contracts";
import { photoInputSchema } from "@kanvil/contracts/instance";
import { t } from "@kanvil/contracts/i18n";

// Native equivalent of web's prepareImage. One pipeline serves account and project images.
export async function chooseImage() {
  const result = await DocumentPicker.getDocumentAsync({
    type: ["image/png", "image/jpeg", "image/webp"],
    copyToCacheDirectory: true,
  });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return undefined;
  const source = new File(asset.uri);
  let prepared: File | undefined;
  try {
    if (source.size > attachmentLimit) throw new Error(t("shell.browser.imageTooBig"));
    const { width, height } = await Image.getSize(asset.uri);
    const ratio = Math.min(1, 512 / Math.max(width, height));
    const image = await ImageManipulator.manipulateAsync(
      asset.uri,
      [
        {
          resize: {
            width: Math.max(1, Math.round(width * ratio)),
            height: Math.max(1, Math.round(height * ratio)),
          },
        },
      ],
      { format: ImageManipulator.SaveFormat.PNG, base64: true },
    );
    prepared = new File(image.uri);
    return photoInputSchema.parse({ contentType: "image/png", data: image.base64 });
  } finally {
    if (prepared?.exists) prepared.delete();
    if (source.exists) source.delete();
  }
}
