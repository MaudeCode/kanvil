// The device's interface language: the saved choice, the device's preferred languages, and the
// root that re-renders the app when it changes. The choice belongs to this device and survives
// signing out and changing servers.
import { Fragment, useSyncExternalStore, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getLocales } from "expo-localization";
import { I18nextProvider } from "react-i18next";
import {
  applyLocale,
  i18n,
  localePreference,
  resolveLocale,
  type LocalePreference,
} from "@kanvil/contracts/i18n";

const storageKey = "kanvil:locale";
export async function savedLocalePreference(): Promise<LocalePreference> {
  try {
    return localePreference.parse(await AsyncStorage.getItem(storageKey));
  } catch {
    return "system";
  }
}
// Applies a choice before the first screen and on every change. A language whose catalog fails
// to load leaves the app in English instead of blocking it.
export async function startLocale(preference?: LocalePreference) {
  const choice = preference ?? (await savedLocalePreference());
  try {
    await applyLocale(
      resolveLocale(
        choice,
        getLocales().map((locale) => locale.languageTag),
      ),
    );
  } catch (error) {
    console.error(error);
  }
}
export async function setLocalePreference(preference: LocalePreference) {
  if (preference === "system") await AsyncStorage.removeItem(storageKey);
  else await AsyncStorage.setItem(storageKey, preference);
  await startLocale(preference);
}
function subscribe(listener: () => void) {
  i18n.on("languageChanged", listener);
  return () => i18n.off("languageChanged", listener);
}
export const useLanguage = () => useSyncExternalStore(subscribe, () => i18n.language);
// Remounts its children when the language changes, so every label and format reads the new
// language at once.
export function LocaleRoot({ children }: { children: ReactNode }) {
  const language = useLanguage();
  return (
    <I18nextProvider i18n={i18n}>
      <Fragment key={language}>{children}</Fragment>
    </I18nextProvider>
  );
}
