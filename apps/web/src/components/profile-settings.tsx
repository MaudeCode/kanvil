import { useRef, useState } from "react";
import { Camera, Trash2 } from "lucide-react";
import { photoResultSchema } from "@kanvil/contracts/instance";
import { api, auth, useIdentity } from "../data.tsx";
import { Button, ErrorNotice, Input } from "../ui.tsx";
import { Input as FileInput } from "@/components/ui/input";
import { UserAvatar } from "./user-avatar.tsx";
import { blobToBase64 } from "../lib/browser.ts";
async function normalizePhoto(file: File) {
  if (file.size > 10_000_000) throw new Error("Choose a photo smaller than 10 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot resize the photo.");
    const side = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      256,
      256,
    );
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("The photo could not be prepared."))),
        "image/jpeg",
        0.9,
      ),
    );
    return { contentType: "image/jpeg", data: await blobToBase64(blob) };
  } finally {
    bitmap.close();
  }
}
export function ProfileSettings() {
  const identity = useIdentity(),
    session = auth.useSession(),
    file = useRef<HTMLInputElement>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(),
    [message, setMessage] = useState("");
  async function photo(value?: File) {
    setPending(true);
    setError(undefined);
    setMessage("");
    try {
      await api.request(
        "/api/v1/profile/photo",
        photoResultSchema,
        value
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(await normalizePhoto(value)),
            }
          : { method: "DELETE" },
      );
      await session.refetch();
      setMessage(value ? "Photo updated" : "Photo removed");
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="mb-8">
      <div className="mb-6 flex flex-wrap items-center gap-5">
        <UserAvatar name={identity.name} image={identity.image} className="size-20 text-2xl" />
        <div className="space-y-2">
          <div className="actions">
            <Button disabled={pending} onClick={() => file.current?.click()}>
              <Camera />
              Change photo
            </Button>
            {identity.image && (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  void photo();
                }}
              >
                <Trash2 />
                Remove photo
              </Button>
            )}
          </div>
          <p className="mb-0 text-xs text-muted-foreground">
            PNG, JPEG, or WebP. Photos are cropped to a square.
          </p>
        </div>
        <FileInput
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          aria-label="Profile photo file"
          onChange={(event) => {
            const chosen = event.currentTarget.files?.[0];
            if (chosen) void photo(chosen);
            event.currentTarget.value = "";
          }}
        />
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const name = new FormData(event.currentTarget).get("name");
          if (typeof name !== "string") return;
          setError(undefined);
          setMessage("");
          setPending(true);
          void auth
            .updateUser({ name })
            .then(async (result) => {
              if (result.error) throw new Error(result.error.message);
              await session.refetch();
              setMessage("Profile saved");
            })
            .catch(setError)
            .finally(() => setPending(false));
        }}
      >
        <Input
          label="Display name"
          name="name"
          defaultValue={identity.name}
          required
          maxLength={120}
        />
        <Input label="Email" value={identity.email} readOnly />
        <Button type="submit" disabled={pending}>
          Save profile
        </Button>
      </form>
      <ErrorNotice error={error} />
      {message && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
}
