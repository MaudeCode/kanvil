# Kanvil branding

The approved anvil is traced vector artwork. `brandMark` in [theme.ts](../packages/contracts/src/theme.ts) is its source geometry. The web and native `Brand` components render that path directly. Edit this source and run `pnpm assets:generate` to regenerate the files; avoid editing individual exports.

The generator produces:

- Web: SVG and ICO favicons, a Safari pinned-tab mark, an Apple touch icon, a web manifest with regular/maskable icons, and a social-sharing image.
- Branding: transparent, blue, and white SVG marks in `apps/web/public/brand/`. The README selects a mark for the reader's theme.
- Native: the opaque application icon, adaptive and monochrome foreground, notification mark, and light/dark launch-screen images. Expo configuration connects these files to the native builds.

The app-icon exports have square backgrounds; the operating system supplies the corner mask. Standalone marks have transparent backgrounds. The anvil keeps its natural proportions, with optical centering for square icons and extra space for adaptive masking.

The self-hosted service serves these public files and fonts, with uncached HTML and an absolute social-image URL based on `KANVIL_URL`. Native icons and launch screens require a new binary; changing the image files alone does not update an installed app.
