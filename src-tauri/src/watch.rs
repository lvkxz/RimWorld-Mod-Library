// Beobachtet den Config-Ordner und meldet Änderungen an ModsConfig.xml von außen (z. B. aus dem Spiel) an die Oberfläche.
use crate::modsconfig;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use std::path::Path;
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct ConfigWatcher(Mutex<Option<(String, RecommendedWatcher)>>);

impl ConfigWatcher {
    /// Startet die Überwachung für `config_dir` (neu), falls sich der Ordner geändert hat.
    pub fn watch(&self, app: &AppHandle, config_dir: &str) {
        let mut current = self.0.lock().unwrap();
        if current.as_ref().is_some_and(|(dir, _)| dir == config_dir) {
            return;
        }
        *current = None; // alten Watcher beenden
        if config_dir.is_empty() || !Path::new(config_dir).is_dir() {
            return;
        }
        let (tx, rx) = mpsc::channel();
        let Ok(mut watcher) = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            // Ordner statt Datei beobachten: RimWorld kann die Datei ersetzen statt sie zu überschreiben.
            if res.is_ok_and(|e| e.paths.iter().any(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("ModsConfig.xml")))) {
                let _ = tx.send(());
            }
        }) else {
            return;
        };
        if watcher.watch(Path::new(config_dir), RecursiveMode::NonRecursive).is_err() {
            return;
        }
        let app = app.clone();
        let dir = config_dir.to_string();
        // Endet, sobald der Watcher (und damit der Sender) verworfen wird.
        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                // Ein Speichervorgang löst mehrere Ereignisse aus: kurz sammeln, dann einmal melden.
                while rx.recv_timeout(Duration::from_millis(300)).is_ok() {}
                if !modsconfig::is_own_write(&dir) {
                    let _ = app.emit("library:changed", Value::Null);
                }
            }
        });
        *current = Some((config_dir.to_string(), watcher));
    }
}
