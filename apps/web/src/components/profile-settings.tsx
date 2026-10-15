import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Camera, Trash2, Pencil } from "lucide-react";
import { photoResultSchema } from "@kanvil/contracts/instance";
import { api, auth, useIdentity } from "../data.tsx";
import { Button, ErrorNotice, Input, Modal, SectionHeading } from "../ui.tsx";
import { Input as FileInput } from "@/components/ui/input";
import { UserAvatar } from "./user-avatar.tsx";
import { blobToBase64 } from "../lib/browser.ts";
async function normalizePhoto(file: File) {
  if (file.size > 10000000) throw new Error("Choose a photo smaller than 10 MB.");
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
  const cache = useQueryClient();
  const identity = useIdentity(),
    session = auth.useSession(),
    file = useRef<HTMLInputElement>(null),
    [pending, setPending] = useState(false),
    [editing, setEditing] = useState(false),
    [name, setName] = useState(identity.name),
    [error, setError] = useState<unknown>(),
    [message, setMessage] = useState("");
  async function refreshProfile() {
    await Promise.all([session.refetch(), cache.invalidateQueries({ queryKey: ["kanvil"] })]);
  }
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
      await refreshProfile();
      setMessage(value ? "Photo updated" : "Photo removed");
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <section>
      <SectionHeading
        title="Profile"
        action={
          <Button
            disabled={pending}
            onClick={() => {
              setName(identity.name);
              setError(undefined);
              setEditing(true);
            }}
          >
            <Pencil />
            Edit profile
          </Button>
        }
      />
      <div className="profile-overview">
        <UserAvatar name={identity.name} image={identity.image} className="size-16 text-xl" />
        <div className="min-w-0 flex-1">
          <h3 className="mb-1 text-base">{identity.name}</h3>
          <p className="mb-0 break-all text-sm text-muted-foreground">{identity.email}</p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
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
        <span className="text-xs text-muted-foreground">PNG, JPEG, or WebP</span>
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
      {!editing && <ErrorNotice error={error} />}{" "}
      {message && (
        <p role="status" className="mt-4 mb-0 text-sm text-muted-foreground">
          {message}
        </p>
      )}
      <Modal title="Edit profile" open={editing} onOpenChange={setEditing} busy={pending}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setError(undefined);
            setPending(true);
            void auth
              .updateUser({ name })
              .then(async (result) => {
                if (result.error) throw new Error(result.error.message);
                await refreshProfile();
                setEditing(false);
                setMessage("Profile saved");
              })
              .catch(setError)
              .finally(() => setPending(false));
          }}
        >
          <Input
            disabled={pending}
            label="Display name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={120}
            autoFocus
          />
          <p className="text-sm text-muted-foreground">Your sign-in email is {identity.email}.</p>
          <ErrorNotice error={error} />
          <div className="dialog-actions">
            <Button disabled={pending} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={pending || name.trim() === identity.name}
            >
              {pending ? "Saving…" : "Save profile"}
            </Button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
