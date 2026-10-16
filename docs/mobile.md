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

## Push notifications

Set the public `EXPO_PUBLIC_EAS_PROJECT_ID` UUID when generating/building the native project. This populates Expo's `extra.eas.projectId`; it is an identifier, not a secret. Use your Expo project and configure APNs and FCM credentials following the [Expo push setup guide](https://docs.expo.dev/push-notifications/push-notifications-setup/). Enable the optional server transport as described in [self-hosting](self-hosting.md).

Settings has a global push preference and an action to enable or disable this device. Permission is requested only when enabling. Device tokens are stored in SecureStore, refreshed after app activation/token changes, and bound to the server login session. Sign-out clears the local token marker and server session revocation removes the registration. Notification taps open a ticket only on the currently connected server; the normal API still checks access. Without a configured push project, the app keeps Inbox and realtime available and explains the missing build configuration.

Outbox commits, receipt processing, retry/restart behavior, membership revocation during delivery, account changes on a shared device, and session revocation are tested with an isolated transport. Native Inbox/push preference changes were checked against a second HTTP client on the iOS simulator. Real APNs/FCM delivery and notification-tap routing have not been validated; they need signing/push configuration and an authorized notification source. The unconfigured simulator rejected an injected notification with `UNErrorDomain 2003: Source is not authorized`.

## Checks

```sh
pnpm --filter @kanvil/mobile typecheck
pnpm --filter @kanvil/mobile exec expo install --check
pnpm --filter @kanvil/mobile export
```

Export checks both iOS and Android JavaScript bundles. It does not replace native compilation or device validation. Build and simulator results are recorded separately from physical-device and store-release validation. Signing and App Store publication are separate release actions.

Initial simulator validation includes native owner/project/ticket creation, Markdown rendering, authenticated realtime, deep links, session restoration, persisted drafts across termination, and a concurrent server update preventing an overwrite. Switching between cached ticket deep links kept each comment draft with its original ticket.

An ad-hoc-signed iOS Release app was also compiled with Xcode 27.1 and run on iOS 27 with Metro stopped. It rejected HTTP, signed in through a verified HTTPS fixture, showed complete parent/child/relationship titles, explicitly linked PocketID, and signed out/in through the system browser to the same workspace. The provider used its login-code flow after a virtual passkey enrollment. Local password login remained available. Cached reading and cold startup after the backend stopped were checked separately.

The Android arm64 Release APK compiled in GitHub Actions and passed signature and embedded-JavaScript verification. Android JavaScript exports also pass. The development host has no Android SDK, and Android device execution has not been performed. Physical-device passkeys, distribution signing, and store publication remain separate validation. See the [verification record](verification.md).

## Release builds and signing

`eas.json` provides `development`, `preview`, `simulator`, and `production` profiles, sharing the repository's Node/pnpm pins. `preview` produces an Android APK or an internally distributed iOS build; `simulator` produces an iOS simulator build. `production` uses store distribution defaults. Configure your Expo project ID, signing credentials, and push credentials before running an EAS build. Follow the [EAS build configuration guide](https://docs.expo.dev/build/eas-json/). Local builds do not require an Expo hosting account.

Generate the native project and build an embedded iOS Release app locally:

```sh
pnpm --filter @kanvil/mobile exec expo prebuild --platform ios
pnpm --filter @kanvil/mobile exec expo run:ios --configuration Release
```

A Release app requires HTTPS and includes its JavaScript bundle, so Metro is unnecessary. Keep simulator ad-hoc signing enabled; removing signing also removes the entitlements SecureStore needs. For an isolated simulator backend using HTTPS, run `pnpm native:auth-fixture --https --simulator <udid>` and connect to `https://localhost:5188`. Only this test process and selected simulator trust the temporary certificate.

Increment `ios.buildNumber` and `android.versionCode` in `app.config.ts` for subsequent distributed builds. Keep signing material outside the repository. Building a simulator app or preview APK does not publish to an app store or install on a physical device.

## Native OIDC fixture

The Expo authentication proxy requires an HTTPS identity provider, including during local development. For simulator checks, start the disposable TLS provider and backend with:

```sh
pnpm native:auth-fixture --simulator <booted-simulator-udid>
```

This generates a private temporary certificate, trusts its public certificate in the selected simulator, starts PocketID at `https://localhost:51411`, and runs an isolated Kanvil backend on port 5188. The backend trusts the certificate through its own `NODE_EXTRA_CA_CERTS` setting. Certificate trust is scoped to that simulator and test process. Stop the fixture with Ctrl-C to remove its container, database, and temporary private key. The simulator's temporary trust entry expires with the test certificate.

The fixture uses its own fixed test-only API key and accepts no real PocketID URL or credentials. It is exclusive with `pnpm test:oidc`, which uses the same loopback provider port. Native builds and Metro are started separately using the development commands above.
