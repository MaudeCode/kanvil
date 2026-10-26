import { useState } from "react";
import { Alert, Share } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as Crypto from "expo-crypto";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  authResult,
  credentialInput,
  credentialsSchema,
  createdCredentialSchema,
  okSchema,
  scopes,
} from "@kanvil/contracts";
import { photoResultSchema } from "@kanvil/contracts/instance";
import {
  builtInThemes,
  decodeThemeFile,
  encodeThemeFile,
  validateTheme,
  type ThemeDefinition,
} from "@kanvil/contracts/themes";
import { formatDate, t } from "@kanvil/contracts/i18n";
import { useAllProjects, useConnection, useIdentity, useOperation } from "./data.tsx";
import {
  Body,
  Button,
  Check,
  Choice,
  DateField,
  ErrorNotice,
  Field,
  Loading,
  Row,
  Section,
  Sheet,
} from "./ui.tsx";
import { chooseImage } from "./media.ts";
import { AccountImage } from "./image.tsx";
import { setAppearance, useAppearance } from "./theme.ts";

export function ProfileSettings({ onDeleted }: { onDeleted: () => Promise<void> }) {
  const { api, auth } = useConnection(),
    identity = useIdentity(),
    cache = useQueryClient();
  const [name, setName] = useState(identity.name),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>();
  async function photo(clear = false) {
    setPending(true);
    setError(undefined);
    try {
      const image = clear ? undefined : await chooseImage();
      if (!clear && !image) return;
      await api.request(
        "/api/v1/profile/photo",
        photoResultSchema,
        clear
          ? { method: "DELETE" }
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(image),
            },
      );
      await auth.getSession();
      await cache.invalidateQueries({ queryKey: ["kanvil"] });
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <Section title={t("settings.profile.title")}>
      {identity.image && (
        <AccountImage uri={identity.image} style={{ width: 80, height: 80, borderRadius: 40 }} />
      )}
      <Field
        label={t("settings.profile.displayName")}
        value={name}
        onChangeText={setName}
        maxLength={120}
      />
      <Body muted>{identity.email}</Body>
      <ErrorNotice error={error} />
      <Button
        title={t("common.action.save")}
        primary
        disabled={!name.trim() || pending}
        onPress={() => {
          setPending(true);
          setError(undefined);
          void auth
            .updateUser({ name })
            .then((result) => {
              authResult(result);
              return auth.getSession();
            })
            .catch(setError)
            .finally(() => setPending(false));
        }}
      />
      <Button
        title={t("settings.profile.changePhoto")}
        disabled={pending}
        onPress={() => {
          void photo();
        }}
      />
      <Button
        title={t("settings.profile.removePhoto")}
        disabled={pending}
        onPress={() => {
          void photo(true);
        }}
      />
      <AccountDeletion user={identity} own onDeleted={onDeleted} />
    </Section>
  );
}

// Profile and administration share the same impact, blockers and typed-email confirmation.
export function AccountDeletion({
  user,
  own = false,
  onDeleted,
}: {
  user: { id: string; email: string };
  own?: boolean;
  onDeleted: () => Promise<unknown> | void;
}) {
  const { api } = useConnection();
  const [deleting, setDeleting] = useState(false),
    [confirmation, setConfirmation] = useState("");
  const impact = useQuery({
    ...api.query("get_account_impact", { userId: user.id }),
    enabled: deleting,
  });
  const remove = useOperation("delete_account");
  const label = t(own ? "settings.lifecycle.deleteOwnAccount" : "settings.lifecycle.deleteAccount");
  return (
    <>
      <Button
        title={label}
        danger
        onPress={() => {
          setConfirmation("");
          setDeleting(true);
        }}
      />
      <Sheet
        title={label}
        open={deleting}
        onClose={() => {
          if (!remove.isPending) setDeleting(false);
        }}
      >
        {impact.isPending ? (
          <Loading />
        ) : (
          impact.data && (
            <>
              <Body>{t("settings.lifecycle.profileErased")}</Body>
              <Body>{t("settings.lifecycle.sessions", { count: impact.data.sessions })}</Body>
              <Body>{t("settings.lifecycle.keptAccount")}</Body>
              {impact.data.blockers.map((item) => (
                <Body key={item.code}>{item.message}</Body>
              ))}
            </>
          )
        )}
        <Field
          label={t("native.login.email")}
          value={confirmation}
          onChangeText={setConfirmation}
          autoCapitalize="none"
          keyboardType="email-address"
        />
        <ErrorNotice error={impact.error ?? remove.error} />
        <Button
          title={label}
          danger
          disabled={
            confirmation !== user.email ||
            !impact.data ||
            !!impact.data.blockers.length ||
            remove.isPending
          }
          onPress={() => {
            void remove
              .mutateAsync({ userId: user.id, confirmEmail: confirmation })
              .then(onDeleted)
              .catch(() => {});
          }}
        />
      </Sheet>
    </>
  );
}

export function CredentialsSettings() {
  const { api } = useConnection(),
    cache = useQueryClient(),
    projects = useAllProjects();
  const list = useQuery({
    queryKey: ["kanvil", "credentials"],
    queryFn: () => api.request("/api/v1/credentials", credentialsSchema),
  });
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [granted, setGranted] = useState<(typeof scopes)[number][]>(["read"]),
    [expiry, setExpiry] = useState("90"),
    [customDate, setCustomDate] = useState<string | null>(null),
    [secret, setSecret] = useState("");
  const create = useMutation({
    mutationFn: async () => {
      const expiresIn =
        expiry === "never"
          ? null
          : expiry === "custom" && customDate
            ? Math.floor((new Date(`${customDate}T23:59:59Z`).getTime() - Date.now()) / 1000)
            : Number(expiry) * 86400;
      const input = credentialInput.parse({
        name,
        projectIds: selected,
        scopes: granted,
        expiresIn,
      });
      return api.request("/api/v1/credentials", createdCredentialSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    },
    onSuccess: async (value) => {
      setSecret(value.key);
      await list.refetch();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api.request(`/api/v1/credentials/${encodeURIComponent(id)}`, okSchema, { method: "DELETE" }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["kanvil", "credentials"] }),
  });
  return (
    <Section title={t("settings.credentials.title")}>
      <ErrorNotice error={list.error ?? revoke.error} />
      {list.isPending ? (
        <Loading />
      ) : (
        list.data?.map((item) => (
          <Row
            key={item.id}
            title={item.name ?? t("settings.credentials.untitled")}
            caption={
              item.expiresAt
                ? formatDate(item.expiresAt, { dateStyle: "medium" })
                : t("settings.credentials.never")
            }
            onPress={() =>
              Alert.alert(
                t("settings.credentials.revoke"),
                item.name
                  ? t("settings.credentials.revokeNamed", { name: item.name })
                  : t("settings.credentials.revokeUnnamed"),
                [
                  { text: t("common.action.cancel"), style: "cancel" },
                  {
                    text: t("common.action.confirm"),
                    style: "destructive",
                    onPress: () => revoke.mutate(item.id),
                  },
                ],
              )
            }
          />
        ))
      )}
      <Button
        title={t("settings.credentials.create")}
        onPress={() => {
          create.reset();
          setSecret("");
          setName("");
          setSelected([]);
          setOpen(true);
        }}
      />
      <Sheet
        title={t("settings.credentials.create")}
        open={open}
        onClose={() => {
          if (!create.isPending) {
            setOpen(false);
            setSecret("");
          }
        }}
      >
        {secret ? (
          <>
            <Body>{t("settings.credentials.copyNow")}</Body>
            <Body>{secret}</Body>
            <Button
              title={t("native.detail.share")}
              onPress={() => {
                void Share.share({ message: secret });
              }}
            />
          </>
        ) : (
          <>
            <Field
              label={t("settings.credentials.name")}
              value={name}
              onChangeText={setName}
              maxLength={100}
            />
            <Choice
              label={t("settings.credentials.projects")}
              value=""
              selected={selected}
              options={(projects.data ?? [])
                .filter((item) => !item.archivedAt)
                .map((item) => ({ value: item.id, label: item.name }))}
              onChange={() => {}}
              onToggle={(value) =>
                setSelected((previous) =>
                  previous.includes(value)
                    ? previous.filter((item) => item !== value)
                    : [...previous, value],
                )
              }
            />
            {scopes.map((scope) => (
              <Check
                key={scope}
                label={t(`settings.credentials.permission.${scope}.name`)}
                checked={granted.includes(scope)}
                onChange={(checked) =>
                  setGranted((previous) =>
                    checked ? [...previous, scope] : previous.filter((item) => item !== scope),
                  )
                }
              />
            ))}
            <Choice
              label={t("settings.credentials.expires")}
              value={expiry}
              options={(["7", "30", "90", "365", "custom", "never"] as const).map((value) => ({
                value,
                label: t(`settings.credentials.expiry.${value}`),
              }))}
              onChange={setExpiry}
            />
            {expiry === "custom" && (
              <DateField
                label={t("settings.credentials.expiresOn")}
                value={customDate}
                onChange={setCustomDate}
              />
            )}
            <ErrorNotice error={create.error} />
            <Button
              title={t("settings.credentials.create")}
              primary
              disabled={
                !name.trim() ||
                !selected.length ||
                !granted.length ||
                (expiry === "custom" && !customDate) ||
                create.isPending
              }
              onPress={() => create.mutate()}
            />
          </>
        )}
      </Sheet>
    </Section>
  );
}

export function AppearanceSettings() {
  const settings = useAppearance(),
    themes = [...builtInThemes, ...settings.custom];
  const [editing, setEditing] = useState<ThemeDefinition>(),
    [error, setError] = useState<unknown>();
  async function importFile() {
    setError(undefined);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "application/json",
        copyToCacheDirectory: true,
      });
      const asset = result.canceled ? undefined : result.assets[0];
      if (!asset) return;
      const file = new File(asset.uri);
      try {
        const incoming = decodeThemeFile(await file.text());
        await setAppearance({
          custom: [
            ...settings.custom.filter((theme) => !incoming.some((item) => item.id === theme.id)),
            ...incoming,
          ],
        });
      } finally {
        if (file.exists) file.delete();
      }
    } catch (cause) {
      setError(cause);
    }
  }
  async function exportFile(theme: ThemeDefinition) {
    const file = new File(Paths.cache, `${theme.id}.json`);
    try {
      await file.write(encodeThemeFile([theme]));
      await Sharing.shareAsync(file.uri, { mimeType: "application/json", UTI: "public.json" });
    } catch (cause) {
      setError(cause);
    } finally {
      if (file.exists) file.delete();
    }
  }
  return (
    <>
      <Choice
        label={t("settings.appearance.colorScheme")}
        value={settings.mode}
        options={(["system", "light", "dark"] as const).map((value) => ({
          value,
          label: t(`settings.theme.mode.${value}`),
        }))}
        onChange={(value) => {
          const mode = value === "dark" || value === "light" ? value : "system";
          void setAppearance({ mode }).catch(setError);
        }}
      />
      <Choice
        label={t("settings.appearance.colorTheme")}
        value={settings.theme}
        options={themes.map((theme) => ({ value: theme.id, label: theme.name }))}
        onChange={(theme) => {
          void setAppearance({ theme, light: null, dark: null }).catch(setError);
        }}
      />
      {(["light", "dark"] as const).map((mode) => (
        <Choice
          key={mode}
          label={t("settings.appearance.paletteColor", {
            mode: t(`settings.theme.mode.${mode}`),
            color: t("settings.appearance.colorTheme"),
          })}
          value={settings[mode] ?? settings.theme}
          options={themes.map((theme) => ({ value: theme.id, label: theme.name }))}
          onChange={(id) => {
            void setAppearance({ [mode]: id }).catch(setError);
          }}
        />
      ))}
      <ErrorNotice error={error} />
      <Button
        title={t("settings.appearance.importFile")}
        onPress={() => {
          void importFile();
        }}
      />
      <Button
        title={t("settings.appearance.create")}
        onPress={() => {
          const theme = themes.find((item) => item.id === settings.theme) ?? builtInThemes[0];
          setEditing({
            ...theme,
            id: `custom-${Crypto.randomUUID()}`,
            name: t("settings.appearance.copyName", { name: theme.name }),
          });
        }}
      />
      {themes.map((theme) => (
        <Row
          key={theme.id}
          title={theme.name}
          onPress={() =>
            Alert.alert(theme.name, undefined, [
              { text: t("common.action.cancel"), style: "cancel" },
              {
                text: t("settings.appearance.export"),
                onPress: () => {
                  void exportFile(theme);
                },
              },
              ...(theme.id.startsWith("custom-")
                ? [
                    { text: t("settings.appearance.edit"), onPress: () => setEditing(theme) },
                    {
                      text: t("settings.appearance.delete"),
                      style: "destructive" as const,
                      onPress: () => {
                        void setAppearance({
                          custom: settings.custom.filter((item) => item.id !== theme.id),
                          theme: settings.theme === theme.id ? "aligned" : settings.theme,
                          light: settings.light === theme.id ? null : settings.light,
                          dark: settings.dark === theme.id ? null : settings.dark,
                        }).catch(setError);
                      },
                    },
                  ]
                : []),
            ])
          }
        />
      ))}
      <Sheet
        title={t("settings.appearance.edit")}
        open={!!editing}
        onClose={() => setEditing(undefined)}
      >
        {editing && (
          <ThemeEditor
            theme={editing}
            onSave={async (theme) => {
              await setAppearance({
                custom: [...settings.custom.filter((item) => item.id !== theme.id), theme],
                theme: theme.id,
              });
              setEditing(undefined);
            }}
          />
        )}
      </Sheet>
    </>
  );
}

function ThemeEditor({
  theme,
  onSave,
}: {
  theme: ThemeDefinition;
  onSave: (theme: ThemeDefinition) => Promise<void>;
}) {
  const [draft, setDraft] = useState(theme),
    [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false);
  return (
    <>
      <Field
        label={t("settings.appearance.name")}
        value={draft.name}
        onChangeText={(name) => setDraft((previous) => ({ ...previous, name }))}
      />
      {(["light", "dark"] as const).map((mode) => (
        <Section key={mode} title={t(`settings.theme.mode.${mode}`)}>
          {(["background", "foreground", "sidebar", "primary", "primaryForeground"] as const).map(
            (color) => (
              <Field
                key={color}
                label={t(`settings.appearance.color.${color}`)}
                value={draft[mode][color]}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={(value) =>
                  setDraft((previous) => ({
                    ...previous,
                    [mode]: { ...previous[mode], [color]: value },
                  }))
                }
              />
            ),
          )}
        </Section>
      ))}
      <ErrorNotice error={error} />
      <Button
        title={t("settings.appearance.save")}
        primary
        disabled={pending}
        onPress={() => {
          try {
            const valid = validateTheme(draft);
            setPending(true);
            void onSave(valid)
              .catch(setError)
              .finally(() => setPending(false));
          } catch (cause) {
            setError(cause);
          }
        }}
      />
    </>
  );
}
