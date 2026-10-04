# SpectorClient Launcher v1.6.16


## Automatic launcher updates (v1.6.16)

Packaged NSIS installs check GitHub Releases about one second after startup and then every 60 seconds while no update is already pending. New releases download automatically. If Minecraft is not running, SpectorClient immediately restarts into the updater as soon as the download finishes. If Minecraft is running (or still launching), SpectorClient waits in the background and installs the downloaded update automatically the moment the game exits.

`autoInstallOnAppQuit` is disabled intentionally so closing the launcher cannot install an update on top of a running Minecraft session. If an update is ready while the game is active, closing the main launcher window hides it instead so the updater can safely finish after Minecraft closes.

Electron launcher for **Minecraft Java 26.2 + Fabric** and **Minecraft Java 1.21.11 + Fabric**, with version-aware instances and mods:

```text
%APPDATA%\spectorclient
```


## Automatic launcher updates

This build uses `electron-updater` with GitHub Releases at `NoobIsADev/SpectorClient-Launcher`. Packaged NSIS installs check for launcher updates automatically, download newer releases in the background, and install the downloaded update when the launcher closes.

The repository includes `.github/workflows/release.yml`. Pushing a tag that exactly matches `package.json` (for example `v1.6.16`) builds and publishes the Windows NSIS release, its blockmap, and `latest.yml`.

### One-click first publish

On Windows, double-click `PUSH-AND-RELEASE.bat`. It keeps GitHub authentication on your own PC, copies this prepared source into the repository, pushes `main`, and pushes the matching version tag so GitHub Actions creates the release. No GitHub token needs to be pasted into ChatGPT or stored in the launcher.




## What changed in v1.6.16

- SpectorClient **26.2** uses a dedicated managed **Java 25** runtime.
- SpectorClient **1.21.11** uses a separate managed **Java 21** runtime under `%APPDATA%\spectorclient\runtime\java-21`.
- Java downloads now resolve the current Eclipse Temurin package through the Adoptium API and verify the exact expected file size and **SHA-256 checksum** before extraction.
- Managed Java is accepted only after `java.exe` reports the required major version and successfully creates a small test JVM. Broken/incomplete existing runtimes are automatically reinstalled.
- Windows extraction prefers built-in `tar.exe` and falls back to an encoded PowerShell `Expand-Archive` command, avoiding the quoting/extraction failure from older builds.
- Minecraft now launches with `java.exe` rather than `javaw.exe`, so JVM startup failures are captured in launcher logs instead of only appearing as a Windows Java VM popup.
- Settings now has separate Java 25 and Java 21 override fields and validates a selected executable before saving it for use.

## What changed in v1.6.15

- Clicking the version button on Home now opens a dedicated SpectorClient version selector.
- Added **SpectorClient 26.2** and **SpectorClient 1.21.11** launch targets.
- The selected launch version is saved in launcher settings and shown on the Play screen.
- 26.2 now uses `%APPDATA%\spectorclient\instances\26.2\mods`; existing legacy 26.2 instance data is migrated there automatically and the old root instance files are removed after a successful move.
- 1.21.11 uses `%APPDATA%\spectorclient\instances\1.21.11\mods`.
- The Mods page always asks which client version to manage before showing Install Mods / Installed.
- Modrinth search, installed-state tracking, dependencies, updates, removal, Fabric API and the mods-folder button are isolated per selected version.
- SpectorClient 26.2 downloads its core mod from `https://spectorclient.com/mod/download`.
- SpectorClient 1.21.11 downloads its core mod from `https://spectorclient.com/mod/download/1.21.11`.

## What changed in v1.6.13

- Removed the Home-screen **Check files** status row and button entirely. Client preparation still happens automatically when you press **Play**.
- Removed the **26.2 • FABRIC** label from the top title bar. The launcher now supports selectable 26.2 and 1.21.11 Fabric clients.
- Added **Settings → Launcher theme** with three live-preview themes:
  - **Classic** — the existing light-blue cave style
  - **Crimson** — red cave/crystal accents
  - **Prince** — gold cave/crystal accents
- Theme choice recolors the launcher chrome, cave lighting, crystals, navigation selection, Play button, settings controls, Modrinth actions, dialogs, scrollbars, and the detached Logs window.
- Theme choice is saved in `%APPDATA%\spectorclient\launcher-data\settings.json` and restored on startup.
- Transparency, animations, auto-fit scaling, and all three themes work together.

## What changed in v1.3.6

- Fixed the Windows build version to valid SemVer `1.3.6` (electron-builder rejects four-part versions such as `1.3.5.1`).

- Modrinth cards now compare the installed Modrinth version ID with the newest compatible Fabric 26.2 version.
- If a mod is already current, its action button is gray, disabled, and says **Installed**.
- If a newer compatible version exists, the same button becomes an enabled **Update** button.
- The Installed-mods list also disables the update control and shows **Installed** when no update exists.
- Fabric API is checked quietly on every launcher startup, before every normal client preparation, and before every Modrinth install/update.
- Fabric API now tracks the exact Modrinth version ID and file size, so a stale JAR cannot be treated as current just because a file with the expected name exists.
- Fabric API always targets the newest Fabric + Minecraft 26.2-compatible build returned by Modrinth.

## What changed in v1.3.4

- Automatic fit-aware scaling keeps the 1240x760 launcher layout inside the available window/fullscreen area while preserving your preferred Ctrl +/- scale whenever space allows.

## What changed in v1.3.3

- Modrinth browse results now have **multiple pages** with Previous/Next and numbered page controls, so you can browse beyond the first result page.
- Installed Modrinth mods now have an **Update** button.
- Every Modrinth install and update recursively resolves and downloads all declared **required dependencies first**, including dependencies of dependencies.
- Updating a mod now checks the exact Modrinth version ID rather than trusting file size alone, so a same-name/same-size newer JAR is still replaced correctly.

## What changed in v1.3.2

- The home-page file status is now intentionally simple: **Client ready.** It no longer prints Fabric/Fabric API version details beside the Play button.
- Added an actual **separate Logs window**. By default, clicking the Logs icon opens this popout window.
- Added **Settings → Behavior → Open Logs in a separate window**. Turn it off and the Logs icon uses the built-in launcher page instead.
- The popout keeps a live launcher/game log stream, loads recent log history when opened, supports auto-scroll, and can clear the shared log buffer.
- Modrinth **Page** and **Install** buttons are larger and easier to read/click.
- Replaced the flat skin preview with an interactive **3D Minecraft skin viewer** powered by `skinview3d`.
- Drag the character with the mouse to rotate it a full **360°** and inspect the front, sides, back and head. Zoom/pan are intentionally disabled so the preview stays centered in the launcher design.

## What changed in v1.3.1

- The **PLAY** button now automatically changes to a red **STOP** button as soon as Minecraft is running.
- Clicking **STOP** closes the active Minecraft process. On Windows it terminates the Java process tree so child processes are not left behind.
- While Minecraft is closing, the button shows **STOPPING…** and becomes temporarily disabled.
- If the launcher UI reloads while Minecraft is still running, it asks the main process for the current game status and restores the **STOP** state.

## What changed in v1.3

- **Ctrl + +** increases the launcher UI scale by 10%.
- **Ctrl + -** decreases the launcher UI scale by 10%.
- **Ctrl + 0** resets the launcher UI scale to 100%.
- **F11** toggles launcher fullscreen; the current scale is reapplied instead of resetting.
- Scale is saved and explicitly reapplied when the launcher is maximized or enters/leaves fullscreen.
- UI scale range is 60%–180%.
- Added **Background transparency** from 0% to 100%. At 100%, the main cave/window background is fully transparent while controls stay usable.
- Added subtle cave crystal, glow, logo and status animations.
- Added **Enable subtle animations** in Settings so all launcher animations/transitions can be disabled.
- Launcher window is now created with Electron transparency enabled.
- The launcher uses the supplied SpectorClient logo from:
  `https://i.imgur.com/nP9aVFe.png`
- The same logo is used in the launcher UI and as the Windows/taskbar/build icon.
- The branding asset is downloaded automatically before development start or Windows builds.
- SpectorClient mod download now uses:
  `https://spectorclient.com/mod/download`
- Every **Play** refresh deletes only SpectorClient's fixed client JAR (`spectorclient.jar`, plus the one known legacy filename during migration) and redownloads it. It does **not** wildcard-delete other mods. The manual Check files control was removed in v1.6.13.

## Requirements

- Windows 10/11 recommended
- Node.js 22+
- Java 25 for Minecraft 26.2
- Java 21 for Minecraft 1.21.11
- A Microsoft account that owns Minecraft Java Edition
- Internet connection for Microsoft authentication, Minecraft/Fabric assets, Modrinth, SpectorClient updates and initial logo download

## Run from source

Extract the project, open PowerShell/CMD inside it, then run:

```bash
npm install
npm start
```

`npm start` automatically runs `npm run fetch-brand` first. That downloads the provided Imgur PNG and creates `build/icon.png` for Windows builds. electron-builder converts that PNG into a valid Windows icon during packaging.

## Build a Windows installer

```bash
npm run dist:win
```

Portable EXE:

```bash
npm run dist:portable
```

The logo fetch is also automatically run before both Windows build commands.

## Account sign-in

Open **Accounts** and choose **Add Microsoft account**. Authentication uses the Microsoft browser/device-code flow through `prismarine-auth`; the launcher does not collect the Microsoft password itself.

## Client files

Before every launch, SpectorClient prepares:

1. Minecraft Java **26.2**
2. Compatible **Fabric Loader** profile
3. Compatible **Fabric API** from Modrinth
4. A fresh copy of **SpectorClient** from `https://spectorclient.com/mod/download`

The SpectorClient JAR is stored as:

```text
%APPDATA%\spectorclient\instances\26.2\mods\spectorclient.jar
```

The updater only removes these SpectorClient-owned filenames:

```text
spectorclient.jar
spectorclient-1.0.0.jar   (legacy migration only)
```

No generic `spectorclient-*` wildcard deletion is used.

## Mods tab

The Mods tab manages JARs in the selected version's dedicated folder, for example:

```text
%APPDATA%\spectorclient\instances\26.2\mods
%APPDATA%\spectorclient\instances\1.21.11\mods
```

It can search Modrinth for **Fabric + Minecraft 26.2** mods across multiple pages, install or update compatible versions, recursively install required Modrinth dependencies, remove user-installed mods, and open the mods folder. Fabric API and the SpectorClient JAR are marked as required core files.

## Launcher appearance

Under **Settings → Appearance**:

- **Background transparency:** 0–100%
- **Enable subtle animations:** on/off

Under **Settings → Launcher theme**:

- **Classic:** light blue
- **Crimson:** red
- **Prince:** gold

Under **Settings → Launcher scale**:

- slider: 60–180%
- keyboard: **Ctrl + +**, **Ctrl + -**, **Ctrl + 0**

Scaling is handled by Electron's webContents zoom factor and saved in `%APPDATA%\spectorclient\launcher-data\settings.json`.

## Logo handling

The source project intentionally fetches the exact supplied branding image rather than shipping a recreated logo. The fetch script saves it to:

```text
src\assets\spector-logo.png
```

and creates:

```text
build\icon.png
```

The main process also has a runtime fallback that tries to cache the logo if the file is missing.

## Notes

The project has been syntax checked for `main.js`, `preload.js`, `renderer.js`, `logs.js`, and the branding fetch script. A real Windows run is still required to test Microsoft sign-in, live downloads, transparent-window behavior on the target GPU/Windows configuration, and the complete Minecraft launch path.



## v1.3.6 Windows installer icon fix

The old branding script hand-built `build/icon.ico` by embedding the downloaded PNG directly. NSIS can reject that as `invalid icon file size` when the PNG dimensions do not match the dimensions encoded in the ICO directory entry.

This build now keeps the Imgur logo as `build/icon.png` and lets electron-builder generate the correct multi-size Windows ICO automatically. If you previously built v1.3.5, delete any old `build/icon.ico` and `dist` folder before rebuilding. The included `fetch-brand` script also removes the stale ICO automatically.


## v1.6.13 theme correction

The Classic, Crimson, and Prince themes now recolor the complete launcher chrome rather than only the main accent. Navigation icons, cave lighting, cards, borders, account controls, settings panels, Modrinth controls, pagination, inputs, mod cards, scrollbars, dialogs, toasts, and the detached Logs window all inherit the selected palette. Normal `0%` transparency uses solid dark themed surfaces; the existing transparency slider still allows intentional transparency up to 100%. The in-launcher Spector logo is also color-shifted for Crimson and Prince.


## v1.6.13 — NO TRANSPARENCY

The launcher window is now fully opaque at the Electron/Windows level. `transparent` is disabled, the transparent-window background was removed, and the old transparency slider/setting was removed. Classic, Crimson, and Prince remain fully themed without showing the desktop through the launcher.

## v1.6.13 UI update

- Keeps the Electron window fully opaque (`transparent: false`).
- Restores the original subtle internal bars/panel layering instead of the heavy solid 1.4.2 structural bands.
- Adds the supplied cave screenshot as the scene background directly behind the interactive player skin.
- The player background keeps a dark overlay plus a subtle selected-theme glow so the skin remains readable.

### Player background asset

`npm start` and the Windows build commands now download the supplied Essential cave screenshot into `src/assets/player-background.png` before Electron opens/builds. The packaged launcher therefore uses the local copy behind the 3D player instead of depending on the remote image on every render.


Home screen center background now downloads from https://i.imgur.com/QS6Qx8V.png and is applied with CSS cover so it zooms/crops instead of stretching.


### v1.6.13
The detached Logs window now receives theme changes live from the main launcher. Theme selections are saved immediately, so Classic, Crimson, and Prince stay synchronized across both windows.


## UI sounds
SpectorClient 1.6.13 adds synthesized launcher UI sounds with an Enable launcher sounds toggle and 0–100% volume control under Settings > Appearance & sounds. Sounds cover hover, click, Play/Stop, successful launches/sign-ins, errors, theme changes, and mod actions. No external audio files are required.


## Classic Pink theme
A new Classic Pink light-pink launcher theme is included alongside the unchanged Classic, Crimson, and Prince themes. It also applies to the detached Logs window.


### v1.6.13 branding
The SpectorClient logo is center-zoomed by 10% during asset preparation. The same processed PNG is used by the launcher UI, Electron window/taskbar icon, and Windows build icon.


## Automatic Java runtimes

SpectorClient 26.2 uses managed Eclipse Temurin Java 25 under `%APPDATA%\spectorclient\runtime\java-25`, while SpectorClient 1.21.11 uses managed Java 21 under `%APPDATA%\spectorclient\runtime\java-21`. Downloads are resolved through the Adoptium API, verified against Adoptium's package size and SHA-256 checksum, extracted, and then smoke-tested before use. If a JRE package is unavailable, the launcher falls back to the matching JDK package.


## Microsoft sign-in convenience

The launcher now opens the direct Microsoft verification link with the device code prefilled when supported. The code is still displayed in the launcher as a fallback.


## v1.6.13 fix

Fixed the first-launch Java 25 downloader crash (`Failed to serialize arguments`). The Java runtime downloader now has its own function and IPC payloads are sanitized before being sent to the renderer.


### v1.6.13 Logs behavior
- The detached Logs window opens automatically when Play is pressed.
- The Logs sidebar button was removed.
- The old Logs popout toggle was removed because launch logs now always open in a separate window.


## Automatic launcher updates (GitHub Releases)

SpectorClient 1.6.13+ uses `electron-updater` with GitHub Releases from `NoobIsADev/SpectorClient-Launcher`.
Packaged NSIS installs check for updates shortly after startup and every four hours while open. Updates download in the background and install when the launcher closes, so an active Minecraft session is not interrupted.

### Publish a new version

1. Change `version` in `package.json` (for example `1.6.13` -> `1.6.13`).
2. Commit and push the change to `main`.
3. Create and push a matching tag:

```powershell
git tag v1.6.13
git push origin v1.6.13
```

The GitHub Actions workflow builds the Windows NSIS installer and publishes the release, including the updater metadata (`latest.yml` and blockmap). The tag must exactly match the `package.json` version.

Existing users on versions older than 1.6.13 must install the first updater-enabled NSIS release manually once. Later releases can update automatically.

> Push helper fix: this package preserves the cloned repository `.git` directory while copying release source.


### Push helper fix
This package includes the corrected one-click Git push/release helper with safe Git argument handling.


## v1.6.13 updater publishing fix

The GitHub Actions release flow now builds the NSIS installer, blockmap, and `latest.yml` **before** creating a public release. It uploads all three to a draft, verifies that every required asset is present, and only then publishes the release. This prevents installed launchers from seeing a partially-published release.

Updater network/metadata failures are also reduced to short user-facing messages while the launcher retries automatically; full HTTP response bodies are no longer dumped into UI toasts.

## v1.6.13 updater fix

- Updates install silently in-place with no NSIS Next/Install clicks.
- The packaged launcher explicitly uses `NoobIsADev/SpectorClient-Launcher` as its GitHub update feed.
- Update checks request fresh metadata instead of relying on cached release information.
- Updater logs now show the installed launcher version and update source.
- `npm start` is still development mode and cannot replace itself; test auto-updates using the installed NSIS build from a GitHub Release.


## v1.6.13 updater hardening
- Uses electron-builder's generated `app-update.yml` instead of overriding the feed at runtime.
- Full-installer updates are used for reliability (differential patching disabled).
- Checks every 15 seconds while the launcher is open.
- Keeps the launcher alive if an update is downloading when the user closes the window.
- GitHub Actions validates release assets, hashes, and the public `releases/latest/download` updater endpoint before accepting a release.


### v1.6.13 update notifications
- Native Windows notification when a launcher update is detected and begins downloading.
- Native Windows notification immediately before the update installer starts.
- Removed duplicate in-launcher update lifecycle toast popups.


## v1.6.13 updater verification fix

The release workflow verifies the exact tagged updater metadata and installer URLs and polls GitHub's latest-release API directly. It no longer treats the cached `releases/latest/download` shortcut as authoritative or automatically re-drafts an otherwise valid release because that shortcut is slow to refresh.


## v1.6.15

- Moves the legacy Minecraft 26.2 instance from `%APPDATA%\spectorclient` into `%APPDATA%\spectorclient\instances\26.2` on first launch.
- Migrates user instance files before deleting the old root copies. Launcher-global `launcher-data`, `runtime`, and `instances` folders stay in place.
- Preserves any destination conflicts as timestamped `.pre-migration-backup-*` files instead of discarding data.
- If the SpectorClient mod website/download cannot be reached, shows a native WARNING dialog: `We could not update the SpectorClient mod. Do you wanna continue without it?` with YES / NO.
- YES removes any stale SpectorClient jar and launches without it. NO cancels launch and preserves the currently installed jar.
