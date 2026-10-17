import { useAuthError } from "./hooks/use-auth-error.ts";
import { UserRound, Palette, KeyRound, Bell } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { infoSchema } from "@kanvil/contracts";
import { api, auth } from "./data.tsx";
import { Button, ErrorNotice, Input, Modal, SectionHeading, Loading, FormActions } from "./ui.tsx";
import { TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { SettingsLayout, SettingRow } from "./components/settings-layout.tsx";
import { Credentials } from "./components/credentials-settings.tsx";
import { ProfileSettings } from "./components/profile-settings.tsx";
import { AppearanceSettings } from "./components/appearance.tsx";
import { accountSections } from "./search.ts";
import { formText } from "./forms.ts";
const personalSections = [
  { id: "account", label: "Profile & security", icon: UserRound },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "credentials", label: "API keys", icon: KeyRound },
  { id: "notifications", label: "Notifications", icon: Bell },
];
export function AccountSettings({
  section,
  onSectionChange,
}: {
  section: (typeof accountSections)[number];
  onSectionChange: (value: string) => void;
}) {
  const [error, setError] = useAuthError();
  const info = useQuery({
      queryKey: ["info"],
      queryFn: () => api.request("/api/v1/info", infoSchema),
    }),
    accounts = useQuery({
      queryKey: ["accounts"],
      refetchOnMount: "always",
      queryFn: async () => {
        const result = await auth.listAccounts();
        if (result.error) throw new Error(result.error.message);
        return result.data;
      },
    });
  const [passwordOpen, setPasswordOpen] = useState(false),
    [pending, setPending] = useState(false);
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const values = new FormData(event.currentTarget);
    if (values.get("next") !== values.get("confirm")) {
      setError(new Error("The new passwords do not match."));
      return;
    }
    setPending(true);
    try {
      const result = await auth.changePassword({
        currentPassword: formText(values, "current"),
        newPassword: formText(values, "next"),
        revokeOtherSessions: true,
      });
      if (result.error) throw new Error(result.error.message);
      setPasswordOpen(false);
      toast.success("Password updated. Other sessions signed out.");
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <SettingsLayout
      title="Settings"
      value={section}
      onChange={onSectionChange}
      sections={personalSections}
    >
      <TabsContent value="account">
        <ProfileSettings />
        <section>
          <SectionHeading title="Sign-in & security" />
          <SettingRow
            title="Local password"
            description="Changing your password signs out your other sessions."
          >
            <Button
              onClick={() => {
                setError(undefined);
                setPasswordOpen(true);
              }}
            >
              Change password
            </Button>
          </SettingRow>
          {info.data?.oidc && (
            <SettingRow
              title={info.data.oidc.name}
              description={
                accounts.data?.some((account) => account.providerId === "oidc")
                  ? "Use this identity provider to sign in to the same account."
                  : "Link your account before signing in through this provider."
              }
            >
              {accounts.data?.some((account) => account.providerId === "oidc") ? (
                <Badge variant="secondary">Linked</Badge>
              ) : (
                <Button
                  disabled={pending}
                  onClick={() => {
                    setPending(true);
                    setError(undefined);
                    void auth
                      .linkSocial({
                        provider: "oidc",
                        callbackURL: `${window.location.origin}/settings?section=account`,
                        errorCallbackURL: `${window.location.origin}/settings?section=account`,
                      })
                      .then((result) => {
                        if (result.error) throw new Error(result.error.message);
                      })
                      .catch(setError)
                      .finally(() => setPending(false));
                  }}
                >
                  Link {info.data.oidc.name}
                </Button>
              )}
            </SettingRow>
          )}
          {!passwordOpen && <ErrorNotice error={error} />}
          <ErrorNotice error={accounts.error ?? info.error} />
        </section>
        <Modal
          title="Change password"
          open={passwordOpen}
          onOpenChange={setPasswordOpen}
          busy={pending}
        >
          <form
            onSubmit={(event) => {
              void changePassword(event);
            }}
          >
            <Input
              label="Current password"
              name="current"
              type="password"
              autoComplete="current-password"
              required
            />
            <Input
              label="New password"
              name="next"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
            />
            <Input
              label="Confirm new password"
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
            />
            <FormActions
              error={error}
              pending={pending}
              submitLabel="Change password"
              onCancel={() => setPasswordOpen(false)}
            />
          </form>
        </Modal>
      </TabsContent>
      <TabsContent value="appearance">
        <AppearanceSettings />
      </TabsContent>
      <TabsContent value="credentials">
        <Credentials />
      </TabsContent>
      <TabsContent value="notifications">
        <NotificationPreferences pushAvailable={info.data?.push ?? false} />
      </TabsContent>
    </SettingsLayout>
  );
}
function NotificationPreferences({ pushAvailable }: { pushAvailable: boolean }) {
  const cache = useQueryClient(),
    options = api.notificationPreferences(),
    preferences = useQuery(options),
    update = useMutation({
      mutationFn: api.setNotificationPreferences,
      networkMode: "always",
      retry: false,
      onSuccess: (value) => cache.setQueryData(options.queryKey, value),
    });
  return (
    <section>
      <SectionHeading title="Notifications" />
      <ErrorNotice error={preferences.error ?? update.error} />
      {preferences.isPending ? (
        <Loading />
      ) : (
        preferences.data && (
          <>
            <SettingRow title="Inbox" description="Updates to tickets you follow appear in Kanvil.">
              <Switch
                aria-label="Subscribed ticket updates in Inbox"
                checked={update.isPending ? update.variables.inApp : preferences.data.inApp}
                disabled={update.isPending}
                onCheckedChange={(checked) =>
                  update.mutate({ ...preferences.data, inApp: checked })
                }
              />
            </SettingRow>
            <SettingRow
              title="Push notifications"
              description={
                pushAvailable
                  ? "Send updates to devices you’ve registered."
                  : "Push delivery is not enabled on this instance."
              }
            >
              <Switch
                aria-label="Push notifications on registered devices"
                checked={
                  update.isPending ? (update.variables.push ?? false) : preferences.data.push
                }
                disabled={update.isPending || !pushAvailable}
                onCheckedChange={(checked) =>
                  update.mutate({ inApp: preferences.data?.inApp ?? true, push: checked })
                }
              />
            </SettingRow>
          </>
        )
      )}
    </section>
  );
}
