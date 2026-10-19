import { t } from "@kanvil/contracts/i18n";
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
    if (!document.execCommand("copy")) throw new Error(t("shell.browser.copyFailed"));
  } finally {
    area.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
}
// Saves text as a file through a temporary link.
export function downloadFile(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type })),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(new Error(t("shell.browser.readFailed"))), {
      once: true,
    });
    reader.addEventListener(
      "load",
      () =>
        typeof reader.result === "string"
          ? resolve(reader.result.slice(reader.result.indexOf(",") + 1))
          : reject(new Error(t("shell.browser.encodeFailed"))),
      { once: true },
    );
    reader.readAsDataURL(blob);
  });
}

// Resizes an upload for the server's image limit: a `size` square for "cover" and "contain", or
// at most `size` on its longer side for "inside", stepping the quality down until it fits.
export async function prepareImage(
  file: File,
  {
    fit = "cover",
    format = "image/jpeg",
    size = 256,
  }: {
    fit?: "cover" | "contain" | "inside";
    format?: "image/jpeg" | "image/png";
    size?: number;
  } = {},
) {
  if (file.size > 10000000) throw new Error(t("shell.browser.imageTooBig"));
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    const scale =
      fit === "inside"
        ? Math.min(1, size / Math.max(bitmap.width, bitmap.height))
        : (fit === "cover" ? Math.max : Math.min)(size / bitmap.width, size / bitmap.height);
    const width = Math.round(bitmap.width * scale),
      height = Math.round(bitmap.height * scale);
    canvas.width = fit === "inside" ? width : size;
    canvas.height = fit === "inside" ? height : size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("shell.browser.cannotResize"));
    context.drawImage(
      bitmap,
      (canvas.width - width) / 2,
      (canvas.height - height) / 2,
      width,
      height,
    );
    for (const quality of [0.9, 0.75, 0.6, 0.45]) {
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error(t("shell.browser.prepareFailed")))),
          format,
          quality,
        ),
      );
      if (blob.size <= 500000) return { contentType: format, data: await blobToBase64(blob) };
    }
    throw new Error(t("shell.browser.stillTooLarge"));
  } finally {
    bitmap.close();
  }
}
