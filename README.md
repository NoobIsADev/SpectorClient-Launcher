# SpectorClient Launcher v1.6.54

SpectorClient is an Electron launcher for Minecraft **1.21.11, 26.2 and 26.3**. It retains the Microsoft account system, per-version Fabric content manager, auto-downloaded Java runtimes, Spector Satellite friends/messaging, logs, themes and the existing GitHub publication workflow.

## v1.6.54 — Final JVM argument placement hardening

- The Play button still launches the **original** Fabric/Minecraft child process, with `-XX:StackShadowPages` guaranteed to be a single JVM flag **before `-cp` and the Java main class** on Minecraft 26.3. The actual game version (`opts.version.number`) determines whether to apply the fix, not the saved profile display name.
- Validate the classpath/main-class structure before launch, normalize duplicate/low values from both JVM and accidentally misfiled game arguments, and retain higher values and every other launch argument. On failure, abort rather than launch with an unverified command. The Logs window records the resulting JVM flag and its position without exposing credentials or full classpath.
- Added `scripts/verify-v1654.js` regression tests for real Play-handler logic, duplicate/conflicting flags before/after the main class, saved profiles, Java RAM, player process/exit tracking, and unchanged 26.2/1.21.11 behavior.
- As before, a full in-game Minecraft 26.3 launch must be confirmed on Windows. Source tests alone cannot guarantee OS/driver stability.

## v1.6.53 — Minecraft 26.3 StackShadowPages (actual Play-button launch path)

- The Play button continues to use Electron `game:launch` and `minecraft-launcher-core` 3.18.2 with the original Java process. **No new Java wrapper or respawn:** Stop, exit codes, playtime and status notifications still track the returned Minecraft child.
- For actual Minecraft **26.3**, set JVM `-XX:StackShadowPages=32` before the Java main class on the **first launch**. Values below 32, malformed values and duplicates are normalized to one effective setting; a user's higher value (such as 48 or 64) is preserved.
- The fix is applied twice defensively: `opts.customArgs` (MCLC's JVM option list, *not* `customLaunchArgs`) and the mutable final `arguments` event emitted by MCLC immediately before Java `spawn`. This ensures exactly one effective StackShadowPages option precedes `-cp` and Fabric's `KnotClient` main class, including when saved custom flags conflict.
- Select the **real Minecraft version** (`opts.version.number`) rather than a Fabric profile identifier or display name. Older saved selected labels such as `SpectorClient 26.3` are recognized as 26.3, so they cannot accidentally fall back to the 26.2 instance.
- Saved 26.3 JVM arguments and explicitly selected launch profiles, including optional `javaArgs`, `jvmArgs`, `jvmArguments`, `customArgs`, are retained; accidental StackShadowPages options in saved *game* arguments are relocated to the JVM list without removing other game flags. RAM memory settings, other JVM options, Fabric files, mod installation and Quick Play server arguments stay intact.
- Minecraft **1.21.11 and 26.2** keep their prior launch command behavior, with no StackShadowPages normalization or new defaults applied.
- `npm run verify:ui` runs every earlier regression suite plus a test that executes the **actual** Play IPC handler using a simulated Fabric/MCLC Java launch and original exit event. The real Minecraft install, Java 25, network and GPU are not required for these source checks.
- For an immediate rollback, extract the separate untouched `SpectorClient-Launcher-v1.6.52-ROLLBACK-BACKUP.zip`. **Never overwrite the user's APPDATA/spectorclient data or a released GitHub tag.**

## v1.6.52 — resilient official mod downloads

- Each launch checks the existing version-specific SpectorClient endpoint and retries transient connection, DNS, and HTTP 5xx/429 errors up to three times with short backoff.
- Downloads are staged, verified as genuine ZIP-format **Fabric JARs** (`fabric.mod.json` required), and installed without deleting the last working mod before the new one is ready.
- If the site remains unavailable, the launcher explicitly offers **Use installed mod** when a verified per-version copy exists; otherwise it offers Continue without mod / Cancel. The former copy is never silently used without consent.
- If the user explicitly chooses Continue without mod, old SpectorClient copies are preserved outside the mods directory in `launcher-data/mod-backups/<game version>` rather than destroyed.
- Download redirects must stay HTTPS. This does not repair server outages: if all attempts fail, the launcher reports the error and preserves the available choices.
- Run `npm run verify:ui` for the local simulated retry, failure, downloaded-JAR-validation and atomic-update regression tests. The Windows/Linux/macOS launcher builds still bundle the helper under `src/`.
- The **v1.6.51 full ZIP** is the untouched rollback backup; the source of every previous launcher feature remains present.

## v1.6.50 — clean Content provider selector

- Removed the redundant full-width black background, border and padding around the Modrinth/CurseForge provider buttons.
- Provider buttons, active selection, search results and integration behavior remain intact.
- The override is isolated in `src/refinements-v1650.css`, so it can be reverted independently.
- Complete v1.6.49 ZIP is retained separately as a byte-identical rollback backup.

## v1.6.49 exact user-provided background and cleaner Play/Version buttons

- **Exact bytes:** `src/assets/home-player-background.png` is an unmodified copy of the PNG supplied for the Play screen. SHA-256: `ab22566e1d525e4101e741571f208ab632aab96aed2f32a7c28c2f033c7a8793` (4454146 bytes). It is included directly in the source and Electron application; neither the CSS nor `scripts/fetch-brand.js` modifies it. CSS uses background `cover` for responsive layout without modifying the file itself.
- **Play screen:** the duplicate large SpectorClient logo/heading and "CURRENT ACCOUNT" label/name have been removed above the model. The full-color landscape appears behind the interactive rotating player. Top-bar branding and account selector remain.
- **Cleaner buttons:** removed decorative arrow glyphs from Manage mods, Choose, Back to Play, Open mods folder, Refresh, Browse files and Cape equip labels; button actions still work.
- **Build:** `scripts/fetch-brand.js` still fetches the ordinary launcher logo, but now verifies the SHA-256 of the bundled landscape instead of downloading the old Play background. The old background helper is retained in source for rollback.
- **Preservation:** all v1.6.48 files and backend features are retained. The prior complete v1.6.48 source archive is separately available for rollback.

## v1.6.48 streamlined Content header and centered logos

- **Only one version control:** removed the redundant “FABRIC CONTENT” badge and the dark Mods version bar; the existing **Change version** button retains its original click handler.
- **Simplified active version overview:** removed the dark background/backplate behind the featured SpectorClient logo, leaving its version label and status intact.
- **Actual image centering:** all launcher logo placements have consistent flex/grid alignment and no incidental padding. The existing `scripts/fetch-brand.js` now also centers the visible PNG artwork (after the original 10% zoom) when fetching the **same** logo URL, so transparent padding within the image won't make it look shifted in menus.
- **Preservation:** no account, mod, Minecraft, launch, theme, Satellite, or release functionality is removed. The full v1.6.47 ZIP is the rollback baseline.

`src/refinements-v1648.css` contains only the latest UI overrides. `scripts/center-logo-artwork.js` is an isolated image alignment helper; the original logo URL is unchanged.

## v1.6.47 compact version cards

- **Versions:** removed redundant descriptions and the three repeated feature checklists from the **26.3**, **26.2**, and **1.21.11** tiles. Removed the full mods-directory path boxes so they cannot spill out of the cards.
- **Layout:** shrunk the version cards to match the simpler design; **Use version** and **Manage mods** remain functional.
- **Mods version chooser:** shortened the subtitles so they show the Minecraft version or compatibility without exposing long filesystem paths.
- **No functionality removed:** actual per-version mods directories, Open mods folder, version switching, and all installation paths remain in the backend and Settings. Existing themes, launcher features, responsive chat and 3D player remain as before.
- **Rollback:** the untouched v1.6.46 source ZIP is provided separately.

`src/refinements-v1647.css` contains the small card layout override; all previous stylesheets are retained.

## v1.6.46 visual refinement

- **Play character is back:** restores the original rotating 3D Minecraft player model (with a 2D avatar fallback), without bringing back the removed Skins navigation page. The original skinview3d runtime is included from the project's existing npm dependency.
- **Mods screen uses its full width:** removes the entire promotional “Your Library / Customize your game” card and gives the search/installed lists the recovered space. “Switch version” remains accessible beside the currently managed version.
- **Play version control is simpler:** removes the extra “CHANGE” caption while keeping version switching functional.
- **Download totals:** removes the low-quality downward arrow next to download counts, retaining the numbers.
- **Settings icon:** swaps the incorrect emblem for a standard 8-tooth gear SVG.
- **Safe change:** all previous launcher features, Windows/Linux/macOS build config, Microsoft login, launch logic, responsive Satellite messaging, and Logs-close/Built-In fixes remain in source. A v1.6.45 rollback ZIP is provided separately.

`src/refinements-v1646.css` contains the additional layout adjustments so earlier visual layers are preserved.

## v1.6.45 visual redesign

- **Versions:** clear active-version overview and three version-specific cards, each with **Use** and **Manage mods** buttons. All existing version identifiers and instances are unchanged.
- **Mods & Content:** new category tabs for Mods, Resource Packs and Shaders; improved version chooser; content browsing and installed tabs; Modrinth and CurseForge sources; search, pagination and Built-In statuses all use the original backend.
- **Sidebar:** refreshed outlined icons for Play, Versions, Mods, Accounts and Settings.
- **Title bar:** original Spector-style minimize/maximize/close buttons on the **right**, refined for dark UI. No redundant version or “Minecraft Launcher” title text.
- **Skins management:** the dedicated Skins page remains hidden (the interactive Minecraft character on Play has been restored in v1.6.46). Old cosmetics source and IPC APIs remain archived.
- **Satellite:** larger, higher-contrast message text, readable timestamps, a larger composer, an expand-conversation control and a Friends drawer on narrow windows.
- **Responsive UI:** resizes from 820×560 upward; on narrower sizes the right-hand Friends panel moves to an accessible overlay so the active page has room. Version cards and Content layouts adapt with scroll where required.

The underlying Minecraft launching and auto-update code is not replaced. `src/styles.css` and `src/overhaul.css` are retained; `src/redesign-v1645.css` adds the visual changes on top; `src/refinements-v1646.css` includes the latest refinements.

## Build and preview

With Node.js installed, extract the **complete** source ZIP and run:

```sh
npm install
npm run verify:ui
npm start
```

To package on each corresponding OS:

```sh
npm run dist:win
npm run dist:linux
npm run dist:mac
```

The original logo is downloaded by `scripts/fetch-brand.js` on first setup; the user-provided Play background is now bundled byte-for-byte in the source ZIP. `node_modules` is not bundled; install with npm. Source verification does **not** substitute for a real Electron test or Microsoft/Minecraft launch test.

## Publish

After previewing the app, run `PUSH-AND-RELEASE.bat` on Windows. It uses the version in `package.json` (`v1.6.54`) and will refuse to reuse an existing GitHub tag.

## Rollback

The untouched v1.6.44 complete source is separately available as `SpectorClient-Launcher-v1.6.44-ROLLBACK-BACKUP.zip` (SHA-256: `d7b1d174d11fd5dc159dd5547b692f3bab460ca1a7e5893bf33f52127f2e470c`). See `ROLLBACK.md` for safe restore guidance.


## v1.6.51 compact text-only header

Removed the repeated small logo from the top bar and the decorative lower-left rail corner. The existing **SpectorClient** text wordmark occupies the former top-bar logo position, with extra left inset eliminated. The active-version logo within the Versions manager and all original branding assets are retained; no game logic, accounts, or build scripts were changed. The visual change is isolated in `src/refinements-v1651.css`.
