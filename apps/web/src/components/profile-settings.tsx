import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { photoResultSchema } from "@kanvil/contracts/instance";
import { api, auth, useIdentity } from "../data.tsx";
import { Button, ErrorNotice, SectionHeading } from "../ui.tsx";
import { EditableHeading } from "./settings-layout.tsx";
import { Input as FileInput } from "@/components/ui/input";
import { UserAvatar } from "./user-avatar.tsx";
import { prepareImage } from "../lib/browser.ts";
import { ImageEditTrigger } from "./image-edit-trigger.tsx";
export function ProfileSettings() {
  const cache = useQueryClient();
  const identity = useIdentity(),
    session = auth.useSession(),
    file = useRef<HTMLInputElement>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(),
    [editError, setEditError] = useState<unknown>(),
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
              body: JSON.stringify(await prepareImage(value)),
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
      <SectionHeading title="Profile" />
      <EditableHeading
        name={identity.name}
        nameLabel="Display name"
        withDescription={false}
        canEdit
        pending={pending}
        error={editError}
        editLabel="Edit profile"
        media={
          <ImageEditTrigger
            label="Change photo"
            round
            disabled={pending}
            onClick={() => file.current?.click()}
          >
            <UserAvatar name={identity.name} image={identity.image} className="size-16 text-xl" />
          </ImageEditTrigger>
        }
        onSave={async ({ name }) => {
          setEditError(undefined);
          setPending(true);
          try {
            const result = await auth.updateUser({ name });
            if (result.error) throw new Error(result.error.message);
            await refreshProfile();
            setMessage("Profile saved");
          } catch (cause) {
            setEditError(cause);
            throw cause;
          } finally {
            setPending(false);
          }
        }}
      >
        <p className="mb-0 text-sm break-all text-muted-foreground">{identity.email}</p>
      </EditableHeading>
      {identity.image && (
        <Button
          className="mt-5"
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
      <FileInput
        ref={file}
        type="file"
        disabled={pending}
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-label="Profile photo file"
        onChange={(event) => {
          const chosen = event.currentTarget.files?.[0];
          if (chosen) void photo(chosen);
          event.currentTarget.value = "";
        }}
      />
      <ErrorNotice error={error} />
      {message && (
        <p role="status" className="mt-4 mb-0 text-sm text-muted-foreground">
          {message}
        </p>
      )}
    </section>
  );
}
