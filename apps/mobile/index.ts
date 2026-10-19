// Hermes has no Intl.PluralRules; i18next needs it to choose plural forms.
import "intl-pluralrules";
import { registerRootComponent } from "expo";
import App from "./src/app.tsx";
registerRootComponent(App);
