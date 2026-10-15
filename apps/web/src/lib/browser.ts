export async function copyText(value: string) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    /* Use the local fallback when browser clipboard permission is unavailable. */
  }
  const previous = document.activeElement,
    area = document.createElement("textarea");
  area.value = value;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  try {
    area.select();
    if (!document.execCommand("copy"))
      throw new Error("Copy failed. Select the text and copy it manually.");
  } finally {
    area.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
}
export function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(new Error("The file could not be read")), {
      once: true,
    });
    reader.addEventListener(
      "load",
      () =>
        typeof reader.result === "string"
          ? resolve(reader.result.slice(reader.result.indexOf(",") + 1))
          : reject(new Error("The file could not be encoded")),
      { once: true },
    );
    reader.readAsDataURL(blob);
  });
}

export async function prepareSquareImage(
  file: File,
  {
    fit = "cover",
    format = "image/jpeg",
  }: { fit?: "cover" | "contain"; format?: "image/jpeg" | "image/png" } = {},
) {
  if (file.size > 10000000) throw new Error("Choose an image smaller than 10 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot resize the image.");
    const scale = (fit === "cover" ? Math.max : Math.min)(256 / bitmap.width, 256 / bitmap.height);
    const width = bitmap.width * scale,
      height = bitmap.height * scale;
    context.drawImage(bitmap, (256 - width) / 2, (256 - height) / 2, width, height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("The image could not be prepared."))),
        format,
        0.9,
      ),
    );
    return { contentType: format, data: await blobToBase64(blob) };
  } finally {
    bitmap.close();
  }
}
