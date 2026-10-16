# Appearance and themes

Kanvil's default **Aligned** palette uses neutral light/dark surfaces and an indigo accent. The layout follows Linear's [current interface guidance](https://linear.app/now/behind-the-latest-design-refresh): compact headers, quieter navigation, softer separators, and more information in each row. Kanvil keeps its own branding and shadcn components.

Choose Light, Dark, or System under **Settings → Appearance**. Search the theme gallery by name. Choices and custom themes persist in this browser. The default respects the system appearance; switching palettes does not change that preference.

The picker follows T3 Code's System/Light/Dark preview tiles and paired color orbs. A light or dark orb assigns a theme only to that appearance; System switches between the two saved choices. Selecting a theme entry applies both appearances and clears the mix. Rings and sun/moon markers indicate the assigned appearances without checkmarks. Theme entries expose duplicate actions, plus edit, export, and delete actions for custom themes. Create theme starts from the current light/dark mix; Add theme imports the existing version-one JSON format. Removing a custom theme resets only appearances that used it. T3 Code's MIT notice for the adapted preview artwork is included in `/third-party-themes.txt`.

## Bundled palettes

| Theme                               | Light / dark palette source                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Aligned                             | Kanvil's adaptation of Linear's neutral interface                                                                  |
| Catppuccin Mocha, Macchiato, Frappé | [Catppuccin](https://github.com/catppuccin/palette); Latte in light mode                                           |
| Solarized                           | [Ethan Schoonover's Solarized](https://ethanschoonover.com/solarized/)                                             |
| GitHub                              | [GitHub Primer](https://github.com/primer/primitives)                                                              |
| Dracula                             | [Dracula and Alucard](https://github.com/dracula/dracula-theme)                                                    |
| One Dark                            | [Atom One Dark](https://github.com/atom/one-dark-syntax) and [One Light](https://github.com/atom/one-light-syntax) |
| Nord                                | [Nord](https://www.nordtheme.com/docs/colors-and-palettes/)                                                        |
| Tokyo Night, Tokyo Night Storm      | [Tokyo Night](https://github.com/folke/tokyonight.nvim); Day in light mode                                         |
| Gruvbox                             | [Gruvbox](https://github.com/morhetz/gruvbox)                                                                      |
| Rosé Pine, Rosé Pine Moon           | [Rosé Pine](https://rosepinetheme.com/palette/); Dawn in light mode                                                |
| Everforest                          | [Everforest](https://github.com/sainnhe/everforest)                                                                |
| Monokai                             | [Monokai](https://github.com/tanvirtin/monokai.nvim); a Kanvil light adaptation                                    |
| Night Owl                           | [Night Owl and Light Owl](https://github.com/sdras/night-owl-vscode-theme)                                         |
| Ayu                                 | [Ayu](https://github.com/ayu-theme/ayu-colors)                                                                     |

These are interface adaptations, not editor syntax themes. Backgrounds and accent families come from the upstream palettes; shades are adjusted where needed for readable buttons and text. Derived surfaces, sidebar text, muted text, and status colors use the shared theme helper. Tests enforce at least 4.5:1 text contrast across the principal surfaces in both modes. Palette notices ship at `/third-party-themes.txt`.

Old built-in selections resolve to the corresponding named palette. The former default selections, including `linear`, resolve to Aligned. Existing custom themes keep their IDs and colors, and their version-one JSON import/export format is unchanged.

## Density

Tickets are grouped into collapsible status sections with counts. Ordering applies within each status. All matching tickets are shown, with no pagination or Load more controls.

Ticket lists default to Compact rows. **Display → Row spacing → Comfortable** adds room without hiding titles or labels. **Display → Label display → All labels** shows every full label and scope inline, wrapping as needed. Property visibility, row spacing, and label display are personal browser preferences. Search, filters, and ordering remain shareable through the URL and saved views. Touch controls retain their larger targets on phones.

The ticket list uses one view/action toolbar under the location bar. The project name appears once in the location bar, beside its settings cog. Open the magnifying glass for search and the view dropdown for saved views, saving the current filter, deleting a selected saved view, or selecting all displayed tickets. On narrow screens, metadata shares a line instead of repeating property headings. Label/scope previews show two tags on wider layouts and one on narrow layouts; opening a preview reveals every full tag. Ticket titles remain unclipped.
