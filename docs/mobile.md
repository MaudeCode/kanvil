# Native app

Kanvil uses Expo SDK 57 with its compatible React Native and React versions. Web and native use the same contracts, ticket defaults, draft format, API client, and realtime recovery. Controls and navigation use their platform's renderer; the web DOM controls cannot provide native inputs, navigation, or document pickers.

## Development

Activate the repository's Node and pnpm versions, then install dependencies. Start the backend and web app with `pnpm dev`. Start the native development server separately:

```sh
pnpm --filter @kanvil/mobile dev
pnpm --filter @kanvil/mobile ios
# On a host with the Android SDK:
pnpm --filter @kanvil/mobile android
```

Enter your server's origin in the app. An iOS simulator can reach the host through `http://localhost:5180`; a phone needs your reachable HTTPS address. Release builds require HTTPS. Local development allows HTTP. The server must expose its auth and API endpoints at the origin's root.

Native projects are generated from `app.config.ts` and its Expo plugins. Keep `ios/` and `android/` untracked. Expo's `enableSceneSupport` option is enabled for SDK 57 builds using Xcode 27; this uses Expo's scene lifecycle implementation. See the [Expo lifecycle guide](https://github.com/expo/fyi/blob/main/ios-scene-lifecycle.md).

## Sessions and cached data

Better Auth's Expo plugin stores session cookies and its session cache in SecureStore, with a separate namespace for each normalized server origin. Ticket caches and drafts use AsyncStorage, scoped to both that origin and account. Mutation state is never persisted for later automatic submission. Failed offline writes remain drafts and must be explicitly saved again.

Local login and explicitly linked OIDC accounts use the same project permissions. PocketID redirects to the server's `/api/auth/callback/oidc`; the Expo integration completes the return to `kanvil://auth/callback`. Ticket links use `kanvil://projects/<projectId>/tickets/<ticketId>`.

Attachment selection uses the native document picker. Uploads and downloads use the authenticated API. Downloaded files open through the system share sheet, and temporary attachment copies are removed afterward.

## Checks

```sh
pnpm --filter @kanvil/mobile typecheck
pnpm --filter @kanvil/mobile exec expo install --check
pnpm --filter @kanvil/mobile export
```

Export checks both iOS and Android JavaScript bundles. It does not replace native compilation or device validation. Build and simulator results are recorded separately from physical-device and store-release validation. Signing and App Store publication are separate release actions.

Current local validation includes an iOS 27 simulator build, native owner/project/ticket creation, Markdown rendering, authenticated realtime, deep links, session restoration, persisted drafts across termination, and a concurrent server update preventing an overwrite. Android JavaScript exports pass; an Android SDK is not installed on the development host, so Android device execution has not been performed. Native OIDC and release validation are tracked separately.
