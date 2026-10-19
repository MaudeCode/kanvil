import { useAuthError } from "./hooks/use-auth-error.ts";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  infoSchema,
  notificationCategories,
  notificationCategoryLabels,
  reminderUnits,
  reminderUnitSchema,
  type NotificationPreferences,
} from "@kanvil/contracts";
import { notificationCategoryIcons } from "./lib/notification-categories.ts";
import { api, auth, useIdentity } from "./data.tsx";
import {
  Button,
  ErrorNotice,
  Input,
  Modal,
  SectionHeading,
  Loading,
  FormActions,
  Select,
  SelectItem,
} from "./ui.tsx";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { SettingsLayout, SettingsPanel, SettingRow } from "./components/settings-layout.tsx";
import { Credentials } from "./components/credentials-settings.tsx";
import { NotificationChannels } from "./components/delivery-settings.tsx";
import { ProfileSettings } from "./components/profile-settings.tsx";
import { AppearanceSettings } from "./components/appearance.tsx";
import { TicketDisplayPreferences } from "./components/ticket-list-controls.tsx";
import {
  preferences as browserPreferences,
  resetPreferences,
  usePreference,
} from "./hooks/use-preference.ts";
import type { accountSections } from "./search.ts";
import { formText } from "./forms.ts";
export function AccountSettings({ section }: { section: (typeof accountSections)[number] }) {
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
    <SettingsLayout title="Settings" section={section}>
      <SettingsPanel value="account">
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
      </SettingsPanel>
      <SettingsPanel value="appearance">
        <AppearanceSettings />
      </SettingsPanel>
      <SettingsPanel value="preferences">
        <PreferenceSettings />
      </SettingsPanel>
      <SettingsPanel value="credentials">
        <Credentials />
      </SettingsPanel>
      <SettingsPanel value="notifications">
        <NotificationPreferences pushAvailable={info.data?.push ?? false} />
        <NotificationChannels emailAvailable={info.data?.email ?? false} />
      </SettingsPanel>
    </SettingsLayout>
  );
}
function PreferenceSettings() {
  const identity = useIdentity(),
    [weekStart, setWeekStart] = usePreference(browserPreferences.weekStart),
    [sidebar, setSidebar] = usePreference(browserPreferences.sidebar);
  return (
    <>
      <section className="[&>.setting-row:last-child]:border-b-0">
        <SectionHeading title="Behavior" />
        <SettingRow title="Week starts on" description="Applies to every date picker.">
          <Select
            label="Week starts on"
            labelHidden
            className="mb-0 w-44"
            value={weekStart}
            onValueChange={(value) =>
              setWeekStart(browserPreferences.weekStart.schema.parse(value))
            }
          >
            <SelectItem value="sunday">Sunday</SelectItem>
            <SelectItem value="monday">Monday</SelectItem>
            <SelectItem value="saturday">Saturday</SelectItem>
          </Select>
        </SettingRow>
        <SettingRow
          title="Sidebar on launch"
          description="Takes effect the next time Kanvil opens."
        >
          <Select
            label="Sidebar on launch"
            labelHidden
            className="mb-0 w-44"
            value={sidebar}
            onValueChange={(value) => setSidebar(browserPreferences.sidebar.schema.parse(value))}
          >
            <SelectItem value="last">As last left</SelectItem>
            <SelectItem value="expanded">Expanded</SelectItem>
            <SelectItem value="collapsed">Collapsed</SelectItem>
          </Select>
        </SettingRow>
      </section>
      <section>
        <SectionHeading title="Ticket lists" />
        <div className="grid max-w-sm gap-3">
          <TicketDisplayPreferences />
        </div>
      </section>
      <section className="[&>.setting-row:last-child]:border-b-0">
        <SettingRow
          title="Reset preferences"
          description="Restores these choices to their defaults in this browser."
        >
          <Button
            variant="outline"
            onClick={() => {
              resetPreferences(identity.id, Object.values(browserPreferences));
              toast.success("Preferences reset");
            }}
          >
            Reset preferences
          </Button>
        </SettingRow>
      </section>
    </>
  );
}
function NotificationPreferences({ pushAvailable }: { pushAvailable: boolean }) {
  const cache = useQueryClient(),
    options = api.notificationPreferences(),
    preferences = useQuery(options),
    update = useMutation({
      mutationFn: (value: NotificationPreferences) => api.setNotificationPreferences(value),
      networkMode: "always",
      retry: false,
      onSuccess: (value) => cache.setQueryData(options.queryKey, value),
    });
  // The pending write shows immediately; a failure falls back to the saved value.
  const shown = update.isPending ? update.variables : preferences.data;
  const save = (change: Partial<NotificationPreferences>) => {
    if (shown) update.mutate({ ...shown, ...change });
  };
  return (
    <>
      <section className="[&>.setting-row:last-child]:border-b-0">
        <SectionHeading title="Notifications" />
        <ErrorNotice error={preferences.error ?? update.error} />
        {preferences.isPending ? (
          <Loading />
        ) : (
          shown && (
            <>
              <SettingRow
                title="Inbox"
                description="Updates to tickets you follow appear in Kanvil."
              >
                <Switch
                  aria-label="Subscribed ticket updates in Inbox"
                  checked={shown.inApp}
                  disabled={update.isPending}
                  onCheckedChange={(checked) => save({ inApp: checked })}
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
                  checked={shown.push}
                  disabled={update.isPending || !pushAvailable}
                  onCheckedChange={(checked) => save({ push: checked })}
                />
              </SettingRow>
            </>
          )
        )}
      </section>
      {shown && (
        <section className="[&>.setting-row:last-child]:border-b-0">
          <SectionHeading title="Categories" />
          {notificationCategories.map((category) => {
            const Icon = notificationCategoryIcons[category];
            return (
              <SettingRow
                key={category}
                compact
                title={
                  <span className="inline-flex items-center gap-2">
                    <Icon aria-hidden className="size-4 text-muted-foreground" />
                    {notificationCategoryLabels[category]}
                  </span>
                }
              >
                <Switch
                  aria-label={`${notificationCategoryLabels[category]} notifications`}
                  checked={shown.categories[category]}
                  disabled={update.isPending}
                  onCheckedChange={(checked) =>
                    save({ categories: { ...shown.categories, [category]: checked } })
                  }
                />
              </SettingRow>
            );
          })}
          <SettingRow
            title="Due soon reminder"
            description="How long before a followed ticket’s due date."
          >
            <div className="flex items-center gap-2">
              <ReminderAmount
                key={shown.reminderLead.amount}
                value={shown.reminderLead.amount}
                disabled={update.isPending || !shown.categories.due_soon}
                onCommit={(amount) => save({ reminderLead: { ...shown.reminderLead, amount } })}
              />
              <Select
                label="Reminder unit"
                labelHidden
                className="mb-0 w-32"
                value={shown.reminderLead.unit}
                disabled={update.isPending || !shown.categories.due_soon}
                onValueChange={(value) =>
                  save({
                    reminderLead: { ...shown.reminderLead, unit: reminderUnitSchema.parse(value) },
                  })
                }
              >
                {reminderUnits.map((unit) => (
                  <SelectItem key={unit} value={unit}>
                    {unit.charAt(0).toUpperCase() + unit.slice(1)}
                  </SelectItem>
                ))}
              </Select>
            </div>
          </SettingRow>
        </section>
      )}
    </>
  );
}
// Commits on blur or Enter so typing a two-digit amount saves once.
function ReminderAmount({
  value,
  disabled,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  onCommit: (amount: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const commit = () => {
    const amount = Number(draft);
    if (Number.isInteger(amount) && amount >= 1 && amount <= 999) {
      if (amount !== value) onCommit(amount);
    } else setDraft(String(value));
  };
  return (
    <Input
      label="Reminder amount"
      labelHidden
      type="number"
      inputMode="numeric"
      min={1}
      max={999}
      className="w-20"
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}
