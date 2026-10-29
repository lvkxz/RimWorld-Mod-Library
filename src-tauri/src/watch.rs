// Beobachtet Ordner des Spiels und meldet Änderungen von außen (z. B. aus dem Spiel) an die Oberfläche:
// Config/ModsConfig.xml und den Ordner mit den Mod-Listen.
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value;
use std::path::Path;
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct DirWatcher {
    event: &'static str,
    file: Option<&'static str>,  // nur diese Datei beachten, sonst alle
    ignore: fn(&str) -> bool,    // z. B. eigene Schreibvorgänge
    current: Mutex<Option<(String, RecommendedWatcher)>>,
}

impl DirWatcher {
    pub fn new(event: &'static str, file: Option<&'static str>, ignore: fn(&str) -> bool) -> Self {
        DirWatcher { event, file, ignore, current: Mutex::new(None) }
    }

    /// Startet die Überwachung für `dir` (neu), falls sich der Ordner geändert hat.
    pub fn watch(&self, app: &AppHandle, dir: &str) {
        let mut current = self.current.lock().unwrap();
        if current.as_ref().is_some_and(|(d, _)| d == dir) {
            return;
        }
        *current = None; // alten Watcher beenden
        if dir.is_empty() || !Path::new(dir).is_dir() {
            return;
        }
        let (tx, rx) = mpsc::channel();
        let file = self.file;
        let Ok(mut watcher) = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            // Ordner statt Datei beobachten: RimWorld kann die Datei ersetzen statt sie zu überschreiben.
            let relevant = |e: &notify::Event| file.is_none_or(|f| e.paths.iter().any(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case(f))));
            if res.is_ok_and(|e| relevant(&e)) {
                let _ = tx.send(());
            }
        }) else {
            return;
        };
        if watcher.watch(Path::new(dir), RecursiveMode::NonRecursive).is_err() {
            return;
        }
        let (app, event, ignore, path) = (app.clone(), self.event, self.ignore, dir.to_string());
        // Endet, sobald der Watcher (und damit der Sender) verworfen wird.
        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                // Ein Speichervorgang löst mehrere Ereignisse aus: kurz sammeln, dann einmal melden.
                while rx.recv_timeout(Duration::from_millis(300)).is_ok() {}
                if !ignore(&path) {
                    let _ = app.emit(event, Value::Null);
                }
            }
        });
        *current = Some((dir.to_string(), watcher));
    }
}
