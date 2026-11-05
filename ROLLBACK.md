# SpectorClient — v1.6.45 redesign and safe rollback

**Complete v1.6.44 backup preserved separately.** Archive: `SpectorClient-Launcher-v1.6.44-ROLLBACK-BACKUP.zip` (SHA-256 `d7b1d174d11fd5dc159dd5547b692f3bab460ca1a7e5893bf33f52127f2e470c`). It is byte-for-byte identical to the complete original v1.6.44 source archive.

## Revert the whole launcher

Close the launcher. Extract the complete v1.6.44 backup to a separate folder and build it using `npm install` and `npm start` to preview. If you want to *publish* a rollback, restore the old HTML/CSS but **bump package.json to a new unused version**; do not overwrite GitHub's `v1.6.44` or `v1.6.45` tags.

## Revert visuals while preserving latest backend

- Original `src/styles.css` is intact.
- v1.6.44 visual overrides remain in `src/overhaul.css`.
- v1.6.45 visual overrides are isolated in `src/redesign-v1645.css`.
- Visible Skins and 3D character were removed from the v1.6.45 HTML, but the old Cosmetics source, Microsoft skin/cape API calls and handlers are retained in the launcher code for restoration.
- Use the original v1.6.44 `src/index.html` and remove the v1.6.45 CSS link to return to the previous layout; keep any later backend patches when reverting.

The rollback ZIP is **not included inside** the v1.6.45 ZIP to avoid packaging an obsolete launcher into the released application. Keep both downloads.

## v1.6.46 refinements

The v1.6.46 patch preserves the entire v1.6.45 codebase and re-enables the existing Play-screen 3D character preview (not the Skins manager). A complete unchanged v1.6.45 source ZIP is the suggested rollback point for the latest changes. For a previous design, the original v1.6.44 rollback archive is also available separately. The styling changes are isolated in `src/refinements-v1646.css`; do not delete other project files when reverting.

## v1.6.47 compact-card rollback

The full untouched v1.6.46 source ZIP is separately available as `SpectorClient-Launcher-v1.6.46-ROLLBACK-BACKUP.zip`. To restore the previous version tiles, use its `src/index.html`, `src/renderer.js`, and remove `src/refinements-v1647.css` from the stylesheet links; if publishing as an update, assign a new unused version number instead of reusing the v1.6.46 tag. All launcher core files remain available in either source archive.

## v1.6.48 minimal Content controls and logo centering rollback

The original untouched full v1.6.47 ZIP is retained separately as `SpectorClient-Launcher-v1.6.47-ROLLBACK-BACKUP.zip`. To undo only these visual refinements while keeping later backend changes, remove the `refinements-v1648.css` link from `src/index.html` and restore the previous `mod-selected-version-row` markup from v1.6.47 (the backend IDs and selection handlers are unchanged). To restore the previous logo asset preparation, use v1.6.47's `scripts/fetch-brand.js`; the original external logo URL remains the same. Never reuse an existing GitHub release tag for a published rollback.

## v1.6.49 exact-background rollback

The complete, untouched v1.6.48 source ZIP is provided separately as `SpectorClient-Launcher-v1.6.48-ROLLBACK-BACKUP.zip`. To revert only the Play page image and typography, remove `refinements-v1649.css` from `src/index.html`, restore the previous `player-heading` HTML (the account and version ID hooks remain), and restore the old `preparePlayerBackground()` call in `scripts/fetch-brand.js`. Never edit the original supplied screenshot if exact pixel/file integrity matters.

## v1.6.50 Content provider bar rollback

A complete byte-identical backup of v1.6.49 is separately supplied as
`SpectorClient-Launcher-v1.6.49-ROLLBACK-BACKUP.zip`.
To revert only this visual change in an extracted v1.6.50 project, remove
`<link rel="stylesheet" href="refinements-v1650.css" />` from `src/index.html`.
The original Modrinth/CurseForge provider buttons and backend files were unchanged.


## v1.6.51 text-only header rollback

An exact complete v1.6.50 source backup is provided separately as `SpectorClient-Launcher-v1.6.50-ROLLBACK-BACKUP.zip`. To restore just the decorative corner images in a later version, copy the `rail-logo` and `top-brand-logo` markup from v1.6.50 `src/index.html` and remove the `refinements-v1651.css` link. Keep any later launcher code changes and assign a new unused version if publishing.


## v1.6.52 official mod download resilience

A complete untouched v1.6.51 source ZIP is retained separately. To revert, extract that version in a new directory; do not delete the actual user data in APPDATA/spectorclient. This update touches only main-process SpectorClient download handling, an isolated helper, tests, README, and package version; no UI or saved Minecraft data is migrated.

## v1.6.53 Minecraft 26.3 JVM argument rollback

The exact complete v1.6.52 source (40 files) is backed up separately as `SpectorClient-Launcher-v1.6.52-ROLLBACK-BACKUP.zip`. Reverting the source does not require changing installed Minecraft mods, Java runtimes, resource packs, accounts or settings. Extract the old complete ZIP into a separate folder and preview it with `npm install && npm start`. If publishing an older implementation, use a new unused version/tag; never overwrite an existing GitHub release. To revert just this JVM change while retaining other fixes, restore `src/main.js` and `package.json` from v1.6.52 and omit `src/launch-jvm.js` and `scripts/verify-v1653.js`, then bump to a new release version. This removes the StackShadowPages safeguard for 26.3.


## v1.6.54 JVM argument verification rollback

An unchanged v1.6.53 complete-source backup is provided separately as `SpectorClient-Launcher-v1.6.53-ROLLBACK-BACKUP.zip`. It retains the original StackShadowPages v1.6.53 implementation. Keep source rollback separate from Minecraft data and never reuse a released GitHub version tag.
