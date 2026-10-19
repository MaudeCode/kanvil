import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { LocaleRoot, startLocale } from "./lib/locale.tsx";
import "./style.css";
const root = document.getElementById("root");
if (!root) throw new Error("The app root is missing");
// The first render already reads the chosen language.
void startLocale().then(() =>
  createRoot(root).render(
    <StrictMode>
      <LocaleRoot>
        <App />
      </LocaleRoot>
    </StrictMode>,
  ),
);
