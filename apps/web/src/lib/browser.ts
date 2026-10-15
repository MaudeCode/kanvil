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
