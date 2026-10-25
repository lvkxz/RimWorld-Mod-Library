<div align="center">

<img src="assets/icon.png" width="96" alt="RimWorld Mod Library icon" />

# RimWorld Mod Library

**Use the Steam Workshop with your Epic Games or GOG copy of RimWorld.**<br/>
Browse, install, update and sort mods in one modern desktop app. No Steam account needed.

[![Download](https://img.shields.io/badge/Download-latest%20release-e3a33c?style=for-the-badge&logo=github)](https://github.com/lvkxz/RimWorld-Mod-Library/releases/latest)

![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?logo=windows&logoColor=white)
![RimWorld](https://img.shields.io/badge/RimWorld-1.6-8a5a2b)
![Epic Games](https://img.shields.io/badge/Epic%20Games-supported-313131?logo=epicgames&logoColor=white)
![GOG](https://img.shields.io/badge/GOG-supported-86328A?logo=gogdotcom&logoColor=white)
![Languages](https://img.shields.io/badge/Languages-English%20%7C%20Deutsch-4c8f5a)

<br/>

<img src="docs/screenshots/library.png" alt="Library view" width="900" />

</div>

---

## Contents

- [Why?](#why)
- [Features](#features)
- [How it works](#how-it-works)
- [Installation](#installation)
- [Getting started](#getting-started)
- [Themes](#themes)
- [Languages](#languages)
- [Important notes](#important-notes)
- [FAQ](#faq)
- [License](#license)

---

## Why?

The Steam Workshop is where nearly all RimWorld mods live, but it only works with the Steam version of the game. If you own RimWorld on **Epic Games** or **GOG**, you normally have to download every mod by hand, unpack it, find its dependencies and fix the load order yourself.

**RimWorld Mod Library does all of that for you.**

---

## Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>📚 Library</h3>
      All installed mods with preview images, authors and supported versions. Turn mods on and off with a single switch, filter by status and spot problems right away.
    </td>
    <td width="50%" valign="top">
      <h3>🔎 Workshop browser</h3>
      Search the Steam Workshop with filters for trending, most popular, newest and recently updated. Show only mods that support your game version.
    </td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/mod-details.png" alt="Mod details" /></td>
    <td><img src="docs/screenshots/workshop.png" alt="Workshop browser" /></td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🧩 Automatic dependencies</h3>
      Required mods such as Harmony, HugsLib or Vanilla Expanded Framework are found and installed automatically, including dependencies that are only declared in a mod's <code>About.xml</code>.
    </td>
    <td width="50%" valign="top">
      <h3>↕️ Load order</h3>
      Drag &amp; drop, one-click auto-sort and clear warnings for missing or inactive dependencies, wrong order, incompatible mods and version mismatches.
    </td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/workshop-details.png" alt="Workshop details" /></td>
    <td><img src="docs/screenshots/load-order.png" alt="Load order" /></td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>✨ Suggestions</h3>
      Missing dependencies, a hand-picked starter set of essential mods, this week's trending mods and the all-time favorites, all filtered to what you don't have yet.
    </td>
    <td width="50%" valign="top">
      <h3>🔄 Updates</h3>
      Detects when a Workshop mod has been updated and updates one or all of them with a single click.
    </td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/suggestions.png" alt="Suggestions" /></td>
    <td><img src="docs/screenshots/updates.png" alt="Updates" /></td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🗂️ Collections</h3>
      Paste the link of a Workshop collection, for example a streamer's modpack, choose what you want and install everything at once.
    </td>
    <td width="50%" valign="top">
      <h3>⬇️ Download queue</h3>
      See the progress of every download. Dependencies are marked, and failed downloads can be retried.
    </td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/collections.png" alt="Collections" /></td>
    <td><img src="docs/screenshots/downloads.png" alt="Downloads" /></td>
  </tr>
</table>

**Also included:**

- ▶️ **Play button** that starts RimWorld through the Epic Games Launcher or directly
- 🔍 **Global search** with <kbd>Ctrl</kbd> + <kbd>K</kbd>
- 🗑️ **Safe uninstall**: removed mods go to the Recycle Bin
- 💾 **Automatic backup** of `ModsConfig.xml` before every change
- 🧭 **Auto-detection** of Epic, GOG and Steam installations and your game version
- 🌐 **English and German** interface, switchable at any time
- ℹ️ **About page** with app and RimWorld version, an update check against GitHub releases, links to report bugs, credits and licenses

<p align="center"><img src="docs/screenshots/about.png" alt="About page" width="720" /></p>

---

## How it works

```mermaid
flowchart LR
    A["🔎 You pick a mod"] --> B["📄 Steam Workshop<br/>details & dependencies"]
    B --> C["⬇️ SteamCMD<br/>official Valve tool"]
    C --> D["📁 RimWorld/Mods"]
    D --> E["🧩 Read About.xml<br/>missing dependencies?"]
    E -- yes --> C
    E -- no --> F["✅ Activate & sort<br/>ModsConfig.xml"]
    F --> G["▶️ Play"]
```

1. **Search and details** come from the public Steam Workshop pages and the public Steam Web API. No API key is needed.
2. **Downloads** go through [SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD), Valve's official command-line client, with an **anonymous** login. You don't need a Steam account and you don't have to own the game on Steam.
3. SteamCMD is **not bundled**. On the first download the app fetches it directly from Valve's servers and sets it up. This takes about one minute, once.
4. Mods are placed in your game's `Mods` folder and activated in `ModsConfig.xml`, the same file RimWorld itself uses.

---

## Installation

> [!NOTE]
> The app is for **Windows 10 and 11 (64-bit)**. It starts in **English**; you can switch to **German** under **Settings → Language**.

1. Open the [**latest release**](https://github.com/lvkxz/RimWorld-Mod-Library/releases/latest).
2. Download one of these:

   | File | Description |
   |---|---|
   | `RimWorld-Mod-Library-Setup-x.y.z.exe` | **Recommended.** Installer with Start menu and desktop shortcuts and a normal uninstaller. |
   | `RimWorld-Mod-Library-Portable-x.y.z.exe` | No installation. Runs from any folder or a USB stick. |

3. Run the file.

> [!WARNING]
> **Windows SmartScreen:** The app is not code-signed, because a signing certificate costs money. When you start it for the first time, Windows may show *"Windows protected your PC"*. Click **More info → Run anyway**. If you'd rather check the code first, it's all in this repository.

---

## Getting started

1. **Start the app.** It finds your RimWorld installation automatically. If it doesn't, choose the folder under **Settings**.
2. **Find mods:** Go to **Browse**, or open **Suggestions** for a good starter set.
3. **Click Install.** Dependencies are added automatically. On the very first download, SteamCMD is set up, which takes about a minute.
4. **Check the load order** under **Load order**. Click **Auto-sort** if a warning appears.
5. **Click Play** and have fun. 🎉

<details>
<summary><b>Where does the app store its files?</b></summary>

| What | Location |
|---|---|
| Installed mods | `<RimWorld folder>\Mods\<Workshop ID>` |
| Active mod list | `%USERPROFILE%\AppData\LocalLow\Ludeon Studios\RimWorld by Ludeon Studios\Config\ModsConfig.xml` |
| Backup of the mod list | `ModsConfig.xml.bak`, in the same folder |
| App settings and SteamCMD | `%APPDATA%\RimWorld Mod Library` |

</details>

---

## Themes

Choose your style under **Settings → Appearance**:

<table>
  <tr>
    <th>RimWorld</th>
    <th>Dark</th>
    <th>Light</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/theme-rimworld.png" alt="RimWorld theme" /></td>
    <td><img src="docs/screenshots/theme-dark.png" alt="Dark theme" /></td>
    <td><img src="docs/screenshots/theme-light.png" alt="Light theme" /></td>
  </tr>
</table>

<p align="center"><img src="docs/screenshots/settings.png" alt="Settings" width="720" /></p>

---

## Languages

The app is available in **English** (default) and **German**. Switch under **Settings → Language**. All texts change instantly, including hints and error messages, and the choice is remembered.

<table>
  <tr>
    <th>English</th>
    <th>Deutsch</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/theme-rimworld.png" alt="English interface" /></td>
    <td><img src="docs/screenshots/language-de.png" alt="German interface" /></td>
  </tr>
</table>

---

## Important notes

> [!IMPORTANT]
> **Close RimWorld before changing your mods.** RimWorld writes its mod list when it exits and would overwrite your changes. The app detects a running game and won't save until you close it.

- **Not affiliated:** This project is not affiliated with, endorsed by or sponsored by Ludeon Studios, Valve, Epic Games or any mod author. RimWorld is a trademark of Ludeon Studios. Steam and the Steam Workshop are trademarks of Valve Corporation.
- **Mods belong to their authors.** This app only downloads them. If you enjoy a mod, please support its author on its Steam page with a rating, a comment or a donation.
- **DLCs:** Some mods need Royalty, Ideology, Biotech, Anomaly or Odyssey. The app warns you about this in the mod details. Make sure you own the DLC on your platform.
- **Use at your own risk:** Mods can break save games, and that's true with every mod manager. Back up important saves before big changes.
- **Steam can change things:** The app relies on public Steam pages and SteamCMD. If Valve changes them, some features may stop working until the app is updated.
- **Privacy:** There is no telemetry and no account. The app only talks to Steam and Valve servers to search and download mods.

---

## FAQ

<details>
<summary><b>Do I need a Steam account or to own RimWorld on Steam?</b></summary>
<br/>
No. SteamCMD logs in anonymously, and RimWorld Workshop items can be downloaded that way.
</details>

<details>
<summary><b>Does it work with the GOG or DRM-free version?</b></summary>
<br/>
Yes. Choose your RimWorld folder under <b>Settings</b> if it isn't detected automatically.
</details>

<details>
<summary><b>A download fails with "Download timed out".</b></summary>
<br/>
Large mods sometimes time out on Steam's side. The app retries automatically up to three times. If it still fails, click <b>Retry</b> in the download list.
</details>

<details>
<summary><b>A mod shows a red warning sign.</b></summary>
<br/>
Open the mod, because the details explain the problem. Usually a dependency is missing or loads in the wrong order. Missing dependencies can be installed with one click, and <b>Auto-sort</b> fixes the order.
</details>

<details>
<summary><b>How do I know when there's a new version?</b></summary>
<br/>
The <b>About</b> page checks GitHub for a newer release every time the app starts. If there is one, a <b>New</b> badge appears next to <b>About</b> in the sidebar, and you can download the update from there.
</details>

<details>
<summary><b>How do I report a bug?</b></summary>
<br/>
Open <b>About</b>, click <b>Copy system info</b> and then <b>Report a bug</b>. Paste the copied info into the GitHub issue. It contains only version numbers and your Windows version, no personal data or folder paths.
</details>

<details>
<summary><b>How do I uninstall the app?</b></summary>
<br/>
Use <i>Windows Settings → Apps</i>, or just delete the portable exe. Your mods stay in the RimWorld <code>Mods</code> folder. To remove the app's settings and SteamCMD as well, delete <code>%APPDATA%\RimWorld Mod Library</code>.
</details>

---

## License

Copyright © 2026 lvkxz. **All rights reserved.**

The app is free to download and use. The source code is published for transparency only; it may not be copied, modified or redistributed without permission. See [LICENSE](LICENSE) for the full terms and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the open-source components that are included.

<div align="center">
<br/>
<sub>Built with Electron and Lucide icons. Made for the RimWorld community. 🛠️</sub>
</div>
