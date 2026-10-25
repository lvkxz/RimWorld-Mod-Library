// Persistente JSON-Ablage für Einstellungen und Installations-Metadaten.
// Ablage in %APPDATA%\RimWorld Mod Library; Format unverändert seit Version 1.0, bestehende Daten bleiben gültig.
use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

static USER_DATA: OnceLock<PathBuf> = OnceLock::new();

pub fn init(dir: PathBuf) {
    let _ = USER_DATA.set(dir);
}

pub fn user_data() -> PathBuf {
    USER_DATA.get().cloned().unwrap_or_default()
}

fn default_settings() -> Value {
    json!({
        "language": "en",            // 'en' | 'de'
        "theme": "rimworld",         // 'light' | 'dark' | 'rimworld'
        "gameDir": "",               // RimWorld-Installationsordner
        "modsDir": "",               // Mods-Ordner (Standard: <gameDir>/Mods)
        "configDir": "",             // Ordner mit ModsConfig.xml
        "epicAppName": "",           // für den Start über den Epic Launcher
        "launchVia": "epic",         // 'epic' | 'exe'
        "autoActivate": true,        // neue Mods direkt aktivieren
        "autoDependencies": true,    // Abhängigkeiten automatisch mitinstallieren
        "autoSortOnInstall": true,   // Ladereihenfolge nach Installation sortieren
        "versionFilter": true,       // Workshop nur für die eigene Spielversion zeigen
        "libraryView": "grid"        // 'grid' | 'list'
    })
}

fn read_json(name: &str) -> Option<Value> {
    let text = fs::read_to_string(user_data().join(name)).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

fn write_json(name: &str, data: &Value) -> std::io::Result<()> {
    fs::create_dir_all(user_data())?;
    let target = user_data().join(name);
    let tmp = user_data().join(format!("{name}.tmp"));
    fs::write(&tmp, serde_json::to_string_pretty(data).unwrap_or_default())?;
    fs::rename(tmp, target)
}

pub mod settings {
    use super::*;

    pub fn get() -> Value {
        let mut out = default_settings();
        if let (Some(map), Some(Value::Object(file))) = (out.as_object_mut(), read_json("settings.json")) {
            for (k, v) in file {
                map.insert(k, v);
            }
        }
        out
    }

    pub fn str(key: &str) -> String {
        get().get(key).and_then(Value::as_str).unwrap_or_default().to_string()
    }

    pub fn flag(key: &str) -> bool {
        crate::util::truthy(get().get(key).unwrap_or(&Value::Null))
    }

    pub fn set(partial: &Value) -> std::io::Result<Value> {
        let next = crate::util::merge(&get(), partial);
        write_json("settings.json", &next)?;
        Ok(next)
    }
}

// Merkt sich pro Workshop-ID, welcher Stand installiert wurde (für die Update-Prüfung).
pub mod installs {
    use super::*;

    pub fn all() -> Map<String, Value> {
        match read_json("installs.json") {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        }
    }

    pub fn record(workshop_id: &str, info: Value) -> std::io::Result<()> {
        let mut data = all();
        let merged = crate::util::merge(data.get(workshop_id).unwrap_or(&Value::Null), &info);
        data.insert(workshop_id.to_string(), merged);
        write_json("installs.json", &Value::Object(data))
    }

    pub fn remove(workshop_id: &str) -> std::io::Result<()> {
        let mut data = all();
        data.shift_remove(workshop_id);
        write_json("installs.json", &Value::Object(data))
    }
}
