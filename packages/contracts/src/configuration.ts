import {
  type DeliveryKind,
  type ImportProvider,
  jiraEditionLabels,
  plankaSignInLabels,
  deliverySecretFields,
} from "./index.ts";
import { t } from "./i18n/index.ts";

// Provider forms share fields and wording across web and native. Secrets stay write-only.
type FieldSpec = {
  name: string;
  label: string;
  type?: "url" | "email" | "number";
  placeholder?: string;
  optional?: boolean;
};
// Empty non-secret edits clear a saved value; omitted secrets retain their write-only value.
export function deliverySettingsInput(
  kind: DeliveryKind,
  values: Record<string, string>,
  editing: boolean,
  cleared: string[] = [],
) {
  const settings: { kind: DeliveryKind; [field: string]: string | number | null } = { kind };
  for (const field of deliveryFields()[kind]) {
    const value = values[field.name]?.trim() ?? "";
    if (cleared.includes(field.name)) settings[field.name] = "";
    else if (value) settings[field.name] = field.type === "number" ? Number(value) : value;
    else if (editing && !deliverySecretFields[kind].includes(field.name)) settings[field.name] = "";
  }
  return settings;
}
// The inputs each kind needs; fields named in `deliverySecretFields` are write-only.
export const deliveryFields = (): Record<DeliveryKind, FieldSpec[]> => ({
  email: [{ name: "address", label: t("admin.delivery.field.address"), type: "email" }],
  ntfy: [
    {
      name: "server",
      label: t("admin.delivery.field.server"),
      type: "url",
      placeholder: "https://ntfy.sh",
      optional: true,
    },
    { name: "topic", label: t("admin.delivery.field.topic") },
    { name: "token", label: t("admin.delivery.field.accessToken"), optional: true },
  ],
  gotify: [
    {
      name: "server",
      label: t("admin.delivery.field.server"),
      type: "url",
      placeholder: "https://gotify.example.com",
    },
    { name: "token", label: t("admin.delivery.field.applicationToken") },
  ],
  webhook: [
    {
      name: "url",
      label: t("admin.delivery.field.endpointUrl"),
      type: "url",
      placeholder: "https://",
    },
    { name: "secret", label: t("admin.delivery.field.signingSecret"), optional: true },
  ],
  slack: [{ name: "url", label: t("admin.delivery.field.incomingWebhookUrl"), type: "url" }],
  discord: [{ name: "url", label: t("admin.delivery.field.webhookUrl"), type: "url" }],
  mattermost: [
    { name: "url", label: t("admin.delivery.field.incomingWebhookUrl"), type: "url" },
    {
      name: "channel",
      label: t("admin.delivery.field.channel"),
      placeholder: "town-square",
      optional: true,
    },
  ],
  telegram: [
    { name: "token", label: t("admin.delivery.field.botToken") },
    {
      name: "chatId",
      label: t("admin.delivery.field.chatId"),
      placeholder: t("admin.delivery.field.chatIdPlaceholder"),
    },
    { name: "topicId", label: t("admin.delivery.field.topicId"), type: "number", optional: true },
  ],
});

export const noCredentials = {
  edition: "cloud",
  signIn: "password",
  baseUrl: "",
  workspace: "",
  email: "",
  username: "",
  password: "",
  apiKey: "",
  token: "",
};
export type Credentials = typeof noCredentials;
type SourceField = {
  name: keyof Credentials;
  label: string;
  type?: "url" | "email" | "password";
  placeholder?: string;
  // A choice between these values instead of text.
  choices?: Record<string, string>;
};
const site = (placeholder: string): SourceField => ({
  name: "baseUrl",
  label: t("admin.import.siteUrl"),
  type: "url",
  placeholder,
});
// The connection fields each source asks for, in order; some depend on an earlier choice.
export const sourceFields: Record<ImportProvider, (credentials: Credentials) => SourceField[]> = {
  linear: () => [{ name: "token", label: t("admin.import.apiKey"), type: "password" }],
  jira: ({ edition }) => [
    { name: "edition", label: t("admin.import.jiraEdition"), choices: jiraEditionLabels },
    site(edition === "cloud" ? "https://example.atlassian.net" : "https://jira.example.com"),
    ...(edition === "cloud"
      ? [
          {
            name: "email",
            label: t("admin.import.accountEmail"),
            type: "email",
          } satisfies SourceField,
          {
            name: "token",
            label: t("admin.import.apiToken"),
            type: "password",
          } satisfies SourceField,
        ]
      : [
          {
            name: "token",
            label: t("admin.import.personalToken"),
            type: "password",
          } satisfies SourceField,
        ]),
  ],
  trello: () => [
    { name: "apiKey", label: t("admin.import.apiKey"), type: "password" },
    { name: "token", label: t("admin.import.token"), type: "password" },
  ],
  plane: () => [
    { ...site("https://api.plane.so"), label: t("admin.import.apiUrl") },
    { name: "workspace", label: t("admin.import.workspaceSlug"), placeholder: "my-team" },
    { name: "token", label: t("admin.import.apiToken"), type: "password" },
  ],
  planka: ({ signIn }) => [
    site("https://planka.example.com"),
    { name: "signIn", label: t("admin.import.signInWith"), choices: plankaSignInLabels },
    ...(signIn === "password"
      ? [
          { name: "username", label: t("admin.import.username") } satisfies SourceField,
          {
            name: "password",
            label: t("admin.import.password"),
            type: "password",
          } satisfies SourceField,
        ]
      : [
          {
            name: "token",
            label: t("admin.import.apiKey"),
            type: "password",
          } satisfies SourceField,
        ]),
  ],
  kaneo: () => [
    site("https://kaneo.example.com"),
    { name: "token", label: t("admin.import.apiKey"), type: "password" },
  ],
};

const failures: Record<string, string> = {
  get blocked_address() {
    return t("admin.delivery.failure.blockedAddress");
  },
  get redirect_blocked() {
    return t("admin.delivery.failure.redirectBlocked");
  },
  get dns_error() {
    return t("admin.delivery.failure.dnsError");
  },
  get network_error() {
    return t("admin.delivery.failure.networkError");
  },
  get timeout() {
    return t("admin.delivery.failure.timeout");
  },
  get invalid_endpoint() {
    return t("admin.delivery.failure.invalidEndpoint");
  },
  get email_unavailable() {
    return t("admin.delivery.failure.emailUnavailable");
  },
  get smtp_error() {
    return t("admin.delivery.failure.smtpError");
  },
  // Repository connections.
  get access_revoked() {
    return t("admin.delivery.failure.accessRevoked");
  },
  get repository_mismatch() {
    return t("admin.delivery.failure.repositoryMismatch");
  },
};
export const failureText = (code: string) =>
  failures[code] ??
  (code.startsWith("http_")
    ? t("admin.delivery.failure.http", { status: code.slice(5) })
    : code.startsWith("smtp_")
      ? t("admin.delivery.failure.smtp", { code: code.slice(5) })
      : code.replaceAll("_", " "));
