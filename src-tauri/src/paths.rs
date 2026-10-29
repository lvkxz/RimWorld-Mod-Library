// Erkennt die RimWorld-Installation (Epic, GOG, Steam, Standardpfade) und den Config-Ordner.
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const EPIC_MANIFESTS: &str = r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests";
pub const EXE: &str = "RimWorldWin64.exe";

pub fn is_game_dir(dir: &str) -> bool {
    !dir.is_empty() && Path::new(dir).join(EXE).exists() && Path::new(dir).join("Data").join("Core").exists()
}

/// `path.resolve()` für Vergleiche.
pub fn resolve(p: &str) -> String {
    std::path::absolute(p).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| p.to_string())
}

fn find_epic() -> Option<(String, String)> {
    for entry in fs::read_dir(EPIC_MANIFESTS).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".item") {
            continue;
        }
        let Ok(text) = fs::read_to_string(entry.path()) else { continue };
        let Ok(m) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else { continue };
        let display = m["DisplayName"].as_str().unwrap_or_default().to_lowercase();
        let location = m["InstallLocation"].as_str().unwrap_or_default();
        if display.contains("rimworld") && is_game_dir(location) {
            return Some((location.to_string(), m["AppName"].as_str().unwrap_or_default().to_string()));
        }
    }
    None
}

fn find_common() -> Option<(String, String)> {
    let mut candidates = Vec::new();
    for drive in ["C", "D", "E", "F"] {
        for rest in [
            r"Program Files\Epic Games\RimWorld",
            r"Epic Games\RimWorld",
            r"GOG Games\RimWorld",
            r"Program Files (x86)\GOG Galaxy\Games\RimWorld",
            r"Program Files (x86)\Steam\steamapps\common\RimWorld",
            r"SteamLibrary\steamapps\common\RimWorld",
            r"Games\RimWorld",
        ] {
            candidates.push(format!(r"{drive}:\{rest}"));
        }
    }
    candidates.into_iter().find(|c| is_game_dir(c)).map(|c| (c, String::new()))
}

/// Zeitpunkt des letzten Cloud-Abgleichs durch Epic (neuestes Manifest im lokalen Cloud-Cache); None ohne Cloud-Saves.
pub fn epic_cloud_synced_at(app_name: &str) -> Option<SystemTime> {
    if app_name.is_empty() {
        return None;
    }
    let saves = PathBuf::from(std::env::var("LOCALAPPDATA").ok()?).join("EpicGamesLauncher").join("Saved").join("Saves");
    fs::read_dir(saves)
        .ok()?
        .flatten()
        .filter_map(|account| fs::read_dir(account.path().join(app_name).join("CloudCache")).ok())
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "manifest"))
        .filter_map(|e| e.metadata().and_then(|m| m.modified()).ok())
        .max()
}

fn default_config_dir() -> String {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(home)
        .join("AppData")
        .join("LocalLow")
        .join("Ludeon Studios")
        .join("RimWorld by Ludeon Studios")
        .join("Config")
        .to_string_lossy()
        .into_owned()
}

fn get<'a>(s: &'a Value, key: &str) -> &'a str {
    s.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// Füllt fehlende Pfade in den Einstellungen automatisch auf.
pub fn resolve_paths(settings: &Value) -> Value {
    let mut out = settings.clone();
    let set = |out: &mut Value, key: &str, val: String| {
        out[key] = Value::String(val);
    };
    if !is_game_dir(get(&out, "gameDir")) {
        if let Some((dir, app)) = find_epic().or_else(find_common) {
            set(&mut out, "gameDir", dir);
            if get(&out, "epicAppName").is_empty() {
                set(&mut out, "epicAppName", app);
            }
        }
    } else if get(&out, "epicAppName").is_empty() {
        if let Some((dir, app)) = find_epic() {
            if resolve(&dir) == resolve(get(&out, "gameDir")) {
                set(&mut out, "epicAppName", app);
            }
        }
    }
    if get(&out, "modsDir").is_empty() && !get(&out, "gameDir").is_empty() {
        let mods = Path::new(get(&out, "gameDir")).join("Mods").to_string_lossy().into_owned();
        set(&mut out, "modsDir", mods);
    }
    if get(&out, "configDir").is_empty() {
        set(&mut out, "configDir", default_config_dir());
    }
    out
}

/// Liefert z. B. { full: '1.6.4871 rev573', short: '1.6' }.
pub fn game_version(game_dir: &str) -> Value {
    match fs::read_to_string(Path::new(game_dir).join("Version.txt")) {
        Ok(text) if !game_dir.is_empty() => {
            let full = text.trim().to_string();
            let short = regex::Regex::new(r"^(\d+\.\d+)")
                .unwrap()
                .captures(&full)
                .map(|c| c[1].to_string())
                .unwrap_or_default();
            json!({ "full": full, "short": short })
        }
        _ => json!({ "full": "", "short": "" }),
    }
}
