# RimWorld Mod Library

Mod-Bibliothek für RimWorld aus dem **Epic Games Store** (funktioniert auch mit GOG oder DRM-freien Versionen), mit direkter Anbindung an den **Steam Workshop**.

## Funktionen

- **Bibliothek**: installierte Mods mit Vorschaubild, Autor, Versionen und Status. Aktivieren und deaktivieren per Schalter.
- **Ladereihenfolge**: Drag & Drop, automatische Sortierung (Harmony → Core/DLCs → Bibliotheken → Rest) und Problemerkennung (fehlende oder inaktive Abhängigkeiten, falsche Reihenfolge, Inkompatibilitäten, Versionswarnungen).
- **Workshop durchsuchen**: Suche, Sortierung (Trend, Beliebteste, Neueste, Aktualisiert), Filter nach Typ und Spielversion, Detailansicht mit Beschreibung, Screenshots und Abhängigkeiten.
- **Vorschläge**: fehlende Abhängigkeiten, bewährte Grundausstattung, Trends der Woche und die beliebtesten Mods.
- **Updates**: erkennt neuere Workshop-Versionen und aktualisiert sie per Klick.
- **Collections**: Workshop-Collection-Link einfügen und alle Mods darin installieren.
- **Downloads**: Warteschlange mit Fortschritt; Abhängigkeiten werden automatisch mitinstalliert.
- **Designs**: RimWorld (dunkel, warm), Dunkel und Hell.

## Wie funktioniert der Download?

Mods werden über **SteamCMD** geladen, das offizielle Kommandozeilen-Tool von Valve. Die Anmeldung erfolgt anonym, ein Steam-Konto ist nicht nötig. SteamCMD wird beim ersten Download automatisch nach `%APPDATA%\RimWorld Mod Library\steamcmd` geladen. Die Mods landen im `Mods`-Ordner von RimWorld. Die aktive Mod-Liste steht in `ModsConfig.xml` (von dieser Datei wird vor jedem Speichern eine `.bak`-Sicherung angelegt).

Workshop-Suche und Details kommen von den öffentlichen Steam-Seiten und der öffentlichen API. Ein API-Key ist nicht nötig.

## Starten

- Fertige App: `dist\win-unpacked\RimWorld Mod Library.exe` (Verknüpfung auf dem Desktop)
- Aus dem Quellcode: `npm install` und danach `npm start`
- Neu bauen: `npm run dist`

## Projektstruktur

```
src/main/        Hauptprozess (Electron)
  main.js        Fenster, IPC, Vorschläge, Update-Prüfung
  paths.js       Erkennung von Epic, GOG, Steam und Spielversion
  mods.js        About.xml einlesen
  modsconfig.js  ModsConfig.xml lesen/schreiben, Sortierung, Problemanalyse
  workshop.js    Steam-Workshop-Suche, Details, Abhängigkeiten, Collections
  steamcmd.js    SteamCMD einrichten und Items herunterladen
  installer.js   Download-Warteschlange
src/renderer/    Oberfläche (HTML/CSS/JS, Lucide-Icons)
scripts/         Entwicklerwerkzeuge (Icon, Screenshots)
```

Hinweis: Alle Mods gehören ihren Autoren. Wenn dir ein Mod gefällt, unterstütze ihn auf seiner Steam-Seite.
