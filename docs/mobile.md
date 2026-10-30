# Native app

Kanvil uses Expo SDK 58 with its compatible React Native and React versions. Web and native use the same contracts, ticket defaults, draft format, API client, settings catalogs, themes, Markdown editing commands, schedule calculations, and realtime recovery. Controls and navigation use their platform's renderer; the web DOM controls cannot provide native inputs, navigation, or document pickers.

## Development

Activate the repository's Node and pnpm versions, then install dependencies. Start the backend and web app with `pnpm dev`. Start the native development server separately:

```sh
pnpm --filter @kanvil/mobile dev
pnpm --filter @kanvil/mobile ios
# On a host with the Android SDK:
pnpm --filter @kanvil/mobile android
```

Enter your server's origin in the app. An iOS simulator can reach the host through `http://localhost:5180`; a phone needs your reachable HTTPS address. Release builds require HTTPS. Local development allows HTTP. The server must expose its auth and API endpoints at the origin's root.

Native projects are generated from `app.config.ts` and its Expo plugins. Keep `ios/` and `android/` untracked. SDK 58 enables Expo's scene lifecycle by default. Use Xcode 27.1 or newer for iPhone Duo support; see [Expo's Duo guidance](https://expo.dev/blog/supporting-iphone-duo).

## Navigation and capabilities

Projects, My work, Inbox, Search, and Settings use the native tab controller, with a browsing stack under each tab so navigation remains reachable inside projects and tickets. A searchable workspace/project picker is available in every browsing header. Project switching replaces the current project destination and restores its filters, search, layout, calendar anchor, selected ticket, and list position for the current account. Workspace switching leaves old project routes. Workspace selection and page actions use native navigation-bar items and menus on iOS, allowing UIKit to place them in the Duo rail. Android renders the same action descriptions through shared header controls and sheets. Pickers and form sheets use a full-screen native stack presentation, with Cancel/Close and the primary action in native bars. The presenting screen completes its return transition before the temporary navigator is removed, preserving touches through repeated and nested sheets. Sheet actions that open a ticket editor wait for that native dismissal before presenting its modal. The signed-out surface paints the entire window, including the rail's safe area.

Ticket lists provide workflow sections, filters, saved views, planning, bulk edits, and List/Board/Calendar/Timeline layouts. List and Board previews and calendar details use one adaptive pane layout. UIKit's active reserved-region measurements place panes on either side of the fold on iOS 27.1+; Android fold geometry comes from the same provider. Other devices split when both minimum pane sizes fit. Both React Native panes stay mounted, preserving scroll positions and form state when folding. Compact layouts show the active pane. Forms, pickers, and ordinary lists stay on one usable facet while the fold is active. Safe areas are measured inside the native screen and consumed once at the shared content boundary; modal windows start fresh inset ownership. The alpha Screens split controller is unsuitable here because it cannot be nested in another navigator and cannot customize its column headers; see [Expo's limitations](https://docs.expo.dev/versions/latest/sdk/router/split-view/#known-limitations).

Secondary scope and active-query summaries belong to scrolling content. Views, filters and creation use native bar items. Single-scroller iOS screens and wide ticket lists extend under translucent system bars with native soft scroll edges; Board, Calendar, and image backgrounds retain explicit safe inset handling where native edge attachment is ambiguous. Compact native titles use semantic foreground colour and system typography. Settings and forms use inset grouped sections; document and collection screens stay plain. Horizontal safe areas and fold exclusion remain owned by the shared content boundary.

Project directories show identity and counts; project information remains available through the project settings action or a long press. Ticket rows wrap their full titles and use a measured line of metadata, label dots and scope text, with filled tags and every property available in detail. Search comments have a short excerpt and a readable preview; role permissions expand in place.

Native settings expose account/profile security, appearance and custom themes, API credentials, notification rules and delivery channels, workspace membership/roles/labels, project workflow/custom fields/access/lifecycle, tracker imports, repositories, and calendar feeds. Instance administrators also have user, workspace, storage, search, event-broker, and authentication settings. The server remains responsible for permissions, validation, version checks, and destructive-operation blockers.

The pinned Screens patch sizes the tabs controller to its measured host before window attachment, so UIKit constructs its bars for the active display on an unfolded cold launch. It preserves equal native bar-item configurations and commits changed arrays through UIKit's animated setters. Item identifiers and grouping stay stable while searching; the active primary action has higher visibility than menus and the project picker. UIKit owns push/pop motion; native tabs use a short opacity transition through the public tab-controller animation delegate. Both tab and in-page changes honor Reduce Motion. The classic screen explicitly associates its measured content scroll view using `setContentScrollView:forEdge:` and refreshes edge settings after layout, including split-pane changes. Shared List/Scroll layout callbacks request soft edges after their actual scroll view exists. Screen preserves its native stacking context so Fabric cannot hoist a background leaf ahead of the scroll-content chain.

## Sessions and cached data

Better Auth's Expo plugin stores session cookies and its session cache in SecureStore, with a separate namespace for each normalized server origin. Ticket caches and drafts use AsyncStorage, scoped to both that origin and account. Successful reads remain cached after network or server failures; explicit client-side API rejections such as revoked access are excluded from persistence. Mutation state is never persisted for later automatic submission. Failed offline writes remain drafts and must be explicitly saved again.

Local login and explicitly linked OIDC accounts use the same project permissions. PocketID redirects to the server's `/api/auth/callback/oidc`; the Expo integration completes the return to `kanvil://auth/callback`. Ticket links use `kanvil://projects/<projectId>/tickets/<ticketId>`.

Attachment selection uses the native document picker. Uploads and downloads use the authenticated API. Downloaded files open through the system share sheet, and temporary attachment copies are removed afterward.

## Push notifications

Set the public `EXPO_PUBLIC_EAS_PROJECT_ID` UUID when generating/building the native project. This populates Expo's `extra.eas.projectId`; it is an identifier, not a secret. Use your Expo project and configure APNs and FCM credentials following the [Expo push setup guide](https://docs.expo.dev/push-notifications/push-notifications-setup/). Enable the optional server transport as described in [self-hosting](self-hosting.md).

Settings has a global push preference and an action to enable or disable this device. Permission is requested only when enabling. Device tokens are stored in SecureStore, refreshed after app activation/token changes, and bound to the server login session. Sign-out clears the local token marker and server session revocation removes the registration. Notification taps open a ticket only on the currently connected server; the normal API still checks access. Without a configured push project, the app keeps Inbox and realtime available and explains the missing build configuration.

Outbox commits, receipt processing, retry/restart behavior, membership revocation during delivery, account changes on a shared device, and session revocation are tested with an isolated transport. Native Inbox/push preference changes were checked against a second HTTP client on the iOS simulator. Real APNs/FCM delivery and notification-tap routing have not been validated; they need signing/push configuration and an authorized notification source. The unconfigured simulator rejected an injected notification with `UNErrorDomain 2003: Source is not authorized`.

Local search in Projects, My work, and project tickets opens on demand from their native options/Views menu, using a stacked search field that collapses with scrolling on iOS. Closing the native search field or dismissing its keyboard retains the query; the removable search row clears it. Platforms that expose a search Cancel callback also clear the query on Cancel. Compact ticket detail hides list search and restores it on Back. The dedicated Search tab keeps its native stacked input available; result-type filters use a native menu. Workspace roots show the workspace name as a picker action; Search keeps its result-type choice on that same strip. The picker changes workspace in place; selecting the current project dismisses it without resetting the active screen.

Ticket-list status headers expand and collapse their rows, pin below the native bar while scrolling, and are pushed away by the next section. Counts include every matching ticket. Normal disclosure choices are retained by project and collection; search starts with matching sections expanded and keeps temporary choices until the query changes. Clearing search restores normal disclosure choices. Views uses one native grouped menu for layouts, All tickets/Planning, saved views, section controls, and explicit selection. The native Views action contains the same layout palette, symbols and filter controls. Active queries and filter counts also appear on its badge. Saved views have a searchable management sheet. Active filter clauses combine property, operator, and values; Add filter reveals further properties. Planning always uses a Planned/Archived list. Ticket rows use the same canonical status, priority, kind, and difficulty symbols as web, alongside assignment, dates, colored labels, and scopes. My work groups by due window or project; Calendar shows work density and a day agenda, and Timeline keeps ticket identity beside the chart. Rows wrap full titles, flow labels and scopes together in measured previews, and distinguish the open split-view ticket from bulk selection. Native Markdown inputs put formatting above the keyboard on iOS; Android retains its inline toolbar. Profile-name saves use the native header while other account operations retain their independent transaction boundaries. Cached revalidation leaves the pull-to-refresh indicator idle; a user pull owns its visible lifecycle. The native tab controller disables automatic minimization, and connection status stays inside screen content rather than resizing the navigator. Empty results, loading additional batches, and failed reads have separate states.

The composer puts the title, compact property choices, and description first. Finite property choices use anchored native menus; searchable and multiple choices use sheets. Markdown uses a native Write/Preview segment and a continuous formatting strip; acceptance criteria and advanced properties expand in place. Closing retains the visible local draft; Discard explicitly removes it. Detail reuses those property values for quick edits, and comments compose in a sheet with native submission. Settings titles identify the current section, with color previews and compact reorder actions. Account, workspace, project and administrator sections are direct rows on the main Settings page in compact layouts; the rail does not hide them in a section menu. Choosing a project there reveals its section rows in place.

Native rail actions have semantic symbols and stable identifiers. Create is high priority in an unselected project list, Edit in visible detail, Done and Fields during selection, and Save in editors. Views has default priority, secondary ticket/settings menus low priority; list controls disappear in compact detail and selection. Search lowers secondary browsing priorities while typing. UIKit owns the actual overflow decision; priority is a preference, not a fixed rail width or guaranteed pin. Application menus avoid the system overflow ellipsis.

The native-stack type patch permits explicitly clearing `headerSearchBarOptions`, matching its existing runtime nullish check. This removes list search from compact detail and selection mode without replacing the system bar.

Settings navigation uses a flat sidebar with rounded, tinted selections and semantic foreground text. Each section has its own native route identity, scoped to its workspace or project where applicable, so changing sections cannot transfer scroll momentum or form state. Returning to a section restores its own mounted page. Shared rows use inset rounded feedback for browsing, choice sheets, and project pickers; selected rows keep their accessible state and checkmarks. Grouped forms remain separate from navigation, and row text continues to wrap.

Wide split layouts keep their translucent native bar at a stable height while either pane scrolls. The Screens/native-stack patch exposes UIKit's iOS 27 minimization policy separately from translucency; compact routes and standalone detail pages retain automatic minimization. The signed-binary gate verifies this native override alongside the tab sizing fix. All flat split layouts share an adjustable divider and saved sidebar width, constrained to keep both panes usable; a measured physical fold fixes the divider instead. Ticket and Settings sidebars share the semantic sidebar background and rounded, tinted active rows. A collapsed or sole collection uses the normal screen surface, matching the exposed canvas beneath the native rail; the sidebar palette applies only beside a visible secondary pane. Both expose the same native sidebar toggle. Board uses the available width before a ticket is selected and keeps active query/filter and read-error summaries visible after loading.

Wide search opens inside the native bar without hiding it or stacking an extra row over both panes. Split-browsing scrollers keep the same inset owner across folding and presentations. They use measured bar clearance instead of inheriting automatic inset changes from another scroller or a search/sheet presentation. Non-minimizing native screens report the current public bar frame, so rotation updates the measurement without frozen or device-specific padding. In-place split browsers reserve horizontal gestures for their content and divider; native Back gestures remain available on standalone ticket routes and compact Settings pages. Compact split detail returns through its native list Back action.

Native bars stay transparent with their soft scroll edges. A project's name is a labeled system bar button that opens the existing project picker, replacing the duplicate fixed project title. Other translucent native titles use the existing titleView slot with a content-sized regular UIGlassEffect, semantic text attributes and Dynamic Type. Its label is an accessibility heading; its intrinsic size follows the title. No scrolling pixels, viewport layers or full-width header backgrounds are masked. Sticky headings retain their owning pane surface and next-section push-off. The resize target remains the 44-point grip, with the rest of the divider passing touches through.

On iOS 27.1+, native vertical-bar compression prefers action items, compressing integrated tabs before actions when space is constrained. UIKit still owns tab expansion; this is not a permanently minimized tab policy. Split detail keeps its ticket actions to sidebar, Edit and List options, alongside the project picker. Expanded native tabs otherwise overlap lower controls despite visibility priorities. List options places checked ordering criteria and direction first, with Views and secondary creation/ticket actions in the same native menu. Browsing without detail retains direct New ticket. Common and currently selected criteria appear first; the remaining contract-defined criteria stay under More. Ordering uses the same filter callback and saved-view reset as the Filters sheet. The project button has a disclosure chevron; directory and Search rows navigate without selection checks, which belong only to the picker.

The root-scroll collector stops at nested scroll views and child screens, keeping system edge configuration scoped to the owning screen. No per-scroll-view opacity mask or bounds observer remains to carry into a recycled Timeline chart or code pane.

## Checks

The native sidebar button hides or restores the ticket list while keeping its scroll position and the open ticket's drafts mounted. The choice is retained per project during the account session. The native workspace/project picker replaces the project-level Back button; Back from compact ticket detail still returns to its list. Settings keeps one persistent category list outside its native detail stack on wide and book layouts. Each column scrolls independently; category selection replaces the visible detail without a slide, including the first selection, and retains the list position. Compact displays use the same detail stack at full width. Standalone reading and editing screens prefer the right-hand facet while a fold is active, falling back only when it is too constrained.

```sh
pnpm --filter @kanvil/mobile typecheck
pnpm --filter @kanvil/mobile exec expo install --check
pnpm --filter @kanvil/mobile export
```

Export checks both iOS and Android JavaScript bundles. It does not replace native compilation or device validation. Build and simulator results are recorded separately from physical-device and store-release validation. Signing and App Store publication are separate release actions.

Initial simulator validation includes native owner/project/ticket creation, Markdown rendering, authenticated realtime, deep links, session restoration, persisted drafts across termination, and a concurrent server update preventing an overwrite. Switching between cached ticket deep links kept each comment draft with its original ticket.

The navigation overhaul was compiled with Xcode 27.1 and exercised against the disposable HTTPS fixture on iPhone Duo (iOS 27.1) and a standard iPhone (iOS 27.0). Checks included native tabs and bar menus, workspace switching, project creation, list/detail collapse, Calendar and Timeline with scheduled data, an unsaved edit retained across folding and then saved into both panes, sign-out/in, and consecutive project-settings saves verified against the server's version. Login background samples match the rail in both appearances on the open and closed Duo. Web regression tests and desktop/390px visual checks cover the extracted shared code. These simulator checks do not establish physical-Duo behavior or real push delivery.

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

After changing a native dependency patch, regenerate the native project and reinstall Pods. CocoaPods can retain a path to an older pnpm patch directory even when the dependency version is unchanged. A JavaScript export or incremental archive does not establish which native implementation was linked. Verify the archived executable before exporting, and repeat against the executable extracted from the final IPA:

```sh
node scripts/verify-ios-tabs.ts /path/to/Kanvil.xcarchive/Products/Applications/Kanvil.app/Kanvil
```

This macOS build check uses Xcode's disassembler to require the tab host's compiled sizing call before controller attachment. It rejects a stale binary without that fix. It does not establish physical-device startup behavior.

## Local startup diagnostics

For a native startup failure that cannot be reproduced on the available simulator, make an explicit diagnostic candidate with `EXPO_PUBLIC_STARTUP_DIAGNOSTICS=1` set during prebuild, JavaScript export, and native compilation:

```sh
EXPO_PUBLIC_STARTUP_DIAGNOSTICS=1 pnpm --filter @kanvil/mobile exec expo prebuild --platform ios
EXPO_PUBLIC_STARTUP_DIAGNOSTICS=1 pnpm --filter @kanvil/mobile exec expo run:ios --configuration Release
```

The config plugin starts the recorder before JavaScript. It records app-owned window/scene geometry, loaded controller and native-bar geometry, item counts, OS/build versions, and lifecycle events. It avoids loading controller views and never reads labels, titles, ticket text, URLs, credentials, or account identifiers. Sampling is bounded after startup/activation, and unchanged samples are omitted. The atomically replaced `kanvil-native-startup.json` file in the app cache is capped at 1 MiB and retained across process launches so cold and foreground-return states can be compared.

Only diagnostic candidates expose Settings → Share in the server section. After reproducing the failure, background and return if needed to restore navigation, then share that JSON file. Sharing is manual; the recorder has no network transport. Rebuild without the variable to disable recording and remove the export action. Simulator results remain separate from physical-device confirmation, and the simulator OS must match the affected device before claiming a reproduction.

## Native OIDC fixture

The Expo authentication proxy requires an HTTPS identity provider, including during local development. For simulator checks, start the disposable TLS provider and backend with:

```sh
pnpm native:auth-fixture --simulator <booted-simulator-udid>
```

This generates a private temporary certificate, trusts its public certificate in the selected simulator, starts PocketID at `https://localhost:51411`, and runs an isolated Kanvil backend on port 5188. The backend trusts the certificate through its own `NODE_EXTRA_CA_CERTS` setting. Certificate trust is scoped to that simulator and test process. Stop the fixture with Ctrl-C to remove its container, database, and temporary private key. The simulator's temporary trust entry expires with the test certificate.

The fixture uses its own fixed test-only API key and accepts no real PocketID URL or credentials. It is exclusive with `pnpm test:oidc`, which uses the same loopback provider port. Native builds and Metro are started separately using the development commands above.

Workspace access is explicit in browsing headers, including ticket and Settings panes. The shared scope button names the active workspace and project and opens the combined picker with workspace choices already visible. Workspace scope rows open workspace choices directly. Selecting the current workspace does not reset the current project or detail; selecting another workspace leaves old scoped routes before selecting the new scope.
