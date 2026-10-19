import { useAuthError } from "./hooks/use-auth-error.ts";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  notificationCategories,
  notificationCategoryLabels,
  reminderUnits,
  reminderUnitSchema,
  type NotificationPreferences,
} from "@kanvil/contracts";
import { notificationCategoryIcons } from "./lib/notification-categories.ts";
import { api, auth, signOut, useIdentity, useInfo } from "./data.tsx";
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
  reportError,
} from "./ui.tsx";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { SettingsLayout, SettingsPanel, SettingRow } from "./components/settings-layout.tsx";
import { Credentials } from "./components/credentials-settings.tsx";
import { NotificationChannels } from "./components/delivery-settings.tsx";
import { ProfileSettings } from "./components/profile-settings.tsx";
import { DeleteAccountRow } from "./components/project-lifecycle.tsx";
import { AppearanceSettings } from "./components/appearance.tsx";
import { TicketDisplayPreferences } from "./components/ticket-list-controls.tsx";
import {
  preferences as browserPreferences,
  resetPreferences,
  usePreference,
} from "./hooks/use-preference.ts";
import type { accountSections } from "./search.ts";
import { formatDate, localeDetails, localePreference, locales, t } from "@kanvil/contracts/i18n";
import { setLocalePreference, useLocalePreference } from "./lib/locale.tsx";
import { formText } from "./forms.ts";
export function AccountSettings({ section }: { section: (typeof accountSections)[number] }) {
  const [error, setError] = useAuthError();
  const identity = useIdentity(),
    info = useInfo(),
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
      setError(new Error(t("settings.account.passwordMismatch")));
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
      toast.success(t("settings.account.passwordUpdated"));
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <SettingsLayout title={t("settings.account.title")} section={section}>
      <SettingsPanel value="account">
        <ProfileSettings />
        <section>
          <SectionHeading title={t("settings.account.security")} />
          <SettingRow
            title={t("settings.account.localPassword")}
            description={t("settings.account.localPasswordDescription")}
          >
            <Button
              onClick={() => {
                setError(undefined);
                setPasswordOpen(true);
              }}
            >
              {t("settings.account.changePassword")}
            </Button>
          </SettingRow>
          {info.data?.providers.map((provider) => {
            const linked = accounts.data?.some((account) => account.providerId === provider.id);
            return (
              <SettingRow
                key={provider.id}
                title={provider.name}
                description={
                  linked ? t("settings.account.oidcLinked") : t("settings.account.oidcUnlinked")
                }
              >
                {linked ? (
                  <Badge variant="secondary">{t("settings.account.linked")}</Badge>
                ) : (
                  <Button
                    disabled={pending}
                    onClick={() => {
                      setPending(true);
                      setError(undefined);
                      void auth
                        .linkSocial({
                          provider: provider.id,
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
                    {t("settings.account.link", { name: provider.name })}
                  </Button>
                )}
              </SettingRow>
            );
          })}
          <DeleteAccountRow
            account={identity}
            // The deletion ended every session; leave with the private data cleared.
            onDeleted={() =>
              signOut(identity).catch(() => {
                identity.clearPrivateData();
                window.location.assign("/login");
              })
            }
          />
          {!passwordOpen && <ErrorNotice error={error} />}
          <ErrorNotice error={accounts.error ?? info.error} />
        </section>
        <Modal
          title={t("settings.account.changePassword")}
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
              label={t("settings.account.currentPassword")}
              name="current"
              type="password"
              autoComplete="current-password"
              required
            />
            <Input
              label={t("settings.account.newPassword")}
              name="next"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
            />
            <Input
              label={t("settings.account.confirmPassword")}
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
              submitLabel={t("settings.account.changePassword")}
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
    [sidebar, setSidebar] = usePreference(browserPreferences.sidebar),
    { preference: language } = useLocalePreference();
  return (
    <>
      <section className="[&>.setting-row:last-child]:border-b-0">
        <SectionHeading title={t("settings.preferences.behavior")} />
        <SettingRow
          title={t("common.language.label")}
          description={t("settings.preferences.languageDescription")}
        >
          <Select
            label={t("common.language.label")}
            labelHidden
            className="mb-0 w-44"
            value={language}
            onValueChange={(value) =>
              void setLocalePreference(localePreference.parse(value)).catch(reportError)
            }
          >
            <SelectItem value="system">{t("common.language.system")}</SelectItem>
            {locales.map((locale) => (
              <SelectItem key={locale} value={locale} lang={locale}>
                {localeDetails[locale].name}
              </SelectItem>
            ))}
          </Select>
        </SettingRow>
        <SettingRow
          title={t("settings.preferences.weekStart")}
          description={t("settings.preferences.weekStartDescription")}
        >
          <Select
            label={t("settings.preferences.weekStart")}
            labelHidden
            className="mb-0 w-44"
            value={weekStart}
            onValueChange={(value) =>
              setWeekStart(browserPreferences.weekStart.schema.parse(value))
            }
          >
            <SelectItem value="language">{t("settings.preferences.weekStartLanguage")}</SelectItem>
            {/* 1 January 2023 was a Sunday. */}
            <SelectItem value="sunday">
              {formatDate(new Date(2023, 0, 1), { weekday: "long" })}
            </SelectItem>
            <SelectItem value="monday">
              {formatDate(new Date(2023, 0, 2), { weekday: "long" })}
            </SelectItem>
            <SelectItem value="saturday">
              {formatDate(new Date(2023, 0, 7), { weekday: "long" })}
            </SelectItem>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("settings.preferences.sidebar")}
          description={t("settings.preferences.sidebarDescription")}
        >
          <Select
            label={t("settings.preferences.sidebar")}
            labelHidden
            className="mb-0 w-44"
            value={sidebar}
            onValueChange={(value) => setSidebar(browserPreferences.sidebar.schema.parse(value))}
          >
            <SelectItem value="last">{t("settings.preferences.sidebarLast")}</SelectItem>
            <SelectItem value="expanded">{t("settings.preferences.sidebarExpanded")}</SelectItem>
            <SelectItem value="collapsed">{t("settings.preferences.sidebarCollapsed")}</SelectItem>
          </Select>
        </SettingRow>
      </section>
      <section>
        <SectionHeading title={t("settings.preferences.ticketLists")} />
        <div className="grid max-w-sm gap-3">
          <TicketDisplayPreferences />
        </div>
      </section>
      <section className="[&>.setting-row:last-child]:border-b-0">
        <SettingRow
          title={t("settings.preferences.reset")}
          description={t("settings.preferences.resetDescription")}
        >
          <Button
            variant="outline"
            onClick={() => {
              resetPreferences(identity.id, Object.values(browserPreferences));
              toast.success(t("settings.preferences.resetDone"));
            }}
          >
            {t("settings.preferences.reset")}
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
        <SectionHeading title={t("settings.notifications.title")} />
        <ErrorNotice error={preferences.error ?? update.error} />
        {preferences.isPending ? (
          <Loading />
        ) : (
          shown && (
            <>
              <SettingRow
                title={t("settings.notifications.inbox")}
                description={t("settings.notifications.inboxDescription")}
              >
                <Switch
                  aria-label={t("settings.notifications.inboxSwitch")}
                  checked={shown.inApp}
                  disabled={update.isPending}
                  onCheckedChange={(checked) => save({ inApp: checked })}
                />
              </SettingRow>
              <SettingRow
                title={t("settings.notifications.push")}
                description={
                  pushAvailable
                    ? t("settings.notifications.pushDescription")
                    : t("settings.notifications.pushUnavailable")
                }
              >
                <Switch
                  aria-label={t("settings.notifications.pushSwitch")}
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
          <SectionHeading title={t("settings.notifications.categories")} />
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
                  aria-label={t("settings.notifications.categorySwitch", {
                    label: notificationCategoryLabels[category],
                  })}
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
            title={t("settings.notifications.reminder")}
            description={t("settings.notifications.reminderDescription")}
          >
            <div className="flex items-center gap-2">
              <ReminderAmount
                key={shown.reminderLead.amount}
                value={shown.reminderLead.amount}
                disabled={update.isPending || !shown.categories.due_soon}
                onCommit={(amount) => save({ reminderLead: { ...shown.reminderLead, amount } })}
              />
              <Select
                label={t("settings.notifications.reminderUnit")}
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
                    {t(`settings.notifications.unit.${unit}`)}
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
      label={t("settings.notifications.reminderAmount")}
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
