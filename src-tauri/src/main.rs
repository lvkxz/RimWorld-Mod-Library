// Fenster, Befehle für window.api (siehe src/bridge.js) und Ereignisse an die Oberfläche.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod installer;
mod mods;
mod modlists;
mod modsconfig;
mod paths;
mod steamcmd;
mod store;
mod util;
mod watch;
mod workshop;
mod xml;

use installer::{Installer, Task};
use mods::Mod;
use paths::{game_version, is_game_dir, resolve, resolve_paths, EXE};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use store::{installs, settings};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use util::{as_f64, js_string, num, t, tp, truthy, AppError, Res};

const REPO: &str = "lvkxz/RimWorld-Mod-Library";

// Beliebte, bewährte Mods als Startpunkt für die Vorschläge.
const ESSENTIALS: [&str; 17] = [
    "2009463077", // Harmony
    "818773962",  // HugsLib
    "2023507013", // Vanilla Expanded Framework
    "1508850027", // RimHUD
    "1279012058", // Pick Up And Haul
    "761421485",  // Allow Tool
    "730936602",  // Achtung!
    "1446523594", // Dubs Mint Menus
    "836308268",  // Dubs Bad Hygiene
    "1414302321", // Numbers
    "1561769193", // Common Sense
    "1541460369", // Better Pawn Control
    "867467808",  // Camera+
    "1874644848", // Character Editor
    "2038874626", // Dubs Performance Analyzer
    "1718190143", // Vanilla Furniture Expanded
    "2599504692", // No Version Warning
];

/// Hintergrundfarbe der Titelleiste je Theme (wie TITLEBAR in bridge.js).
fn titlebar_color(theme: &str) -> tauri::window::Color {
    match theme {
        "light" => tauri::window::Color(0xf4, 0xf5, 0xf7, 0xff),
        "dark" => tauri::window::Color(0x14, 0x16, 0x1a, 0xff),
        _ => tauri::window::Color(0x16, 0x13, 0x0f, 0xff),
    }
}

#[derive(Default)]
struct Scan {
    mods: Vec<Mod>,
    by_workshop: HashMap<String, usize>,
}

pub struct Core {
    app: AppHandle,
    scan: Mutex<Scan>,
    asset_dirs: Mutex<HashSet<String>>,
    config_watcher: watch::DirWatcher,
    lists_watcher: watch::DirWatcher,
    pending_list: Mutex<Option<PendingList>>,
    pub installer: Installer,
}

impl Core {
    pub fn send(&self, channel: &str, payload: Value) {
        let _ = self.app.emit(channel, payload);
    }

    /// Änderungen an ModsConfig.xml von außen (Spiel) live an die Oberfläche melden.
    fn watch_config(&self) {
        let s = resolve_paths(&settings::get());
        let config_dir = s["configDir"].as_str().unwrap_or_default();
        self.config_watcher.watch(&self.app, config_dir);
        if !config_dir.is_empty() {
            self.lists_watcher.watch(&self.app, &modlists::dir(config_dir).to_string_lossy());
        }
    }

    /// Einstellungen mit aufgelösten Pfaden und Spielversion.
    pub fn ctx(&self) -> (Value, Value) {
        let s = resolve_paths(&settings::get());
        let version = game_version(s["gameDir"].as_str().unwrap_or_default());
        (s, version)
    }

    fn scan(&self) -> (Value, Value) {
        let (s, version) = self.ctx();
        let game_dir = s["gameDir"].as_str().unwrap_or_default();
        let mods_dir = s["modsDir"].as_str().unwrap_or_default();
        let mods = mods::scan_all(game_dir, mods_dir, version["short"].as_str().unwrap_or_default());
        let mut by_workshop = HashMap::new();
        for (i, m) in mods.iter().enumerate() {
            if !m.workshop_id.is_empty() {
                by_workshop.entry(m.workshop_id.clone()).or_insert(i);
            }
        }
        // Vorschaubilder der Mods über das asset-Protokoll freigeben (nur diese Ordner).
        let mut dirs = self.asset_dirs.lock().unwrap();
        for dir in [Path::new(game_dir).join("Data"), Path::new(mods_dir).to_path_buf()] {
            let key = dir.to_string_lossy().into_owned();
            if !game_dir.is_empty() && !key.is_empty() && dirs.insert(key) {
                let _ = self.app.asset_protocol_scope().allow_directory(&dir, true);
            }
        }
        *self.scan.lock().unwrap() = Scan { mods, by_workshop };
        (s, version)
    }

    fn ensure_scanned(&self) {
        if self.scan.lock().unwrap().mods.is_empty() {
            self.scan();
        }
    }

    fn mods(&self) -> Vec<Mod> {
        self.scan.lock().unwrap().mods.clone()
    }

    fn has_workshop(&self, id: &str) -> bool {
        self.scan.lock().unwrap().by_workshop.contains_key(id)
    }

    fn library_state(&self) -> Res<Value> {
        let (s, version) = self.scan();
        let short = version["short"].as_str().unwrap_or_default();
        let mods = self.mods();
        let config = modsconfig::read_config(s["configDir"].as_str().unwrap_or_default());
        let issues = modsconfig::analyze(&config.active, &mods, short);
        let mut active_pos = HashMap::new();
        for (i, id) in config.active.iter().enumerate() {
            active_pos.insert(id.as_str(), i);
        }
        let record = installs::all();
        let list: Vec<Value> = mods
            .iter()
            .map(|m| {
                let mut v = serde_json::to_value(m).unwrap_or_default();
                let pos = active_pos.get(m.package_id.as_str());
                v["description"] = json!(mods::plain_description(&m.description));
                v["previewUrl"] = json!(if m.preview.is_empty() {
                    String::new()
                } else {
                    format!("http://asset.localhost/{}", util::encode_uri_component(&m.preview))
                });
                v["active"] = json!(pos.is_some());
                v["loadIndex"] = json!(pos.map_or(-1, |p| *p as i64));
                v["versionOk"] = json!(modsconfig::version_supported(m, short));
                v["installedVia"] = json!(if !m.workshop_id.is_empty() && record.get(&m.workshop_id).is_some_and(truthy) { "app" } else { "manual" });
                v
            })
            .collect();
        Ok(json!({ "configExists": config.exists, "active": config.active, "issues": issues, "mods": list }))
    }

    fn officials(&self) -> Vec<String> {
        self.scan.lock().unwrap().mods.iter().filter(|m| m.official).map(|m| m.package_id.clone()).collect()
    }

    async fn save_active(&self, active: Vec<String>, sort: bool) -> Res<Value> {
        let (s, version) = self.ctx();
        self.ensure_scanned();
        let mut list = util::unique(active.iter().map(|id| id.to_lowercase()));
        if !list.iter().any(|x| x == modsconfig::CORE) {
            list.insert(0, modsconfig::CORE.into());
        }
        if sort {
            let mods = self.mods();
            list = modsconfig::auto_sort(&list, &by_package(&mods));
        }
        if is_game_running().await {
            return Err(AppError::tr("err.gameRunning"));
        }
        let config_dir = s["configDir"].as_str().unwrap_or_default();
        modsconfig::write_config(config_dir, &list, version["full"].as_str().unwrap_or_default(), &self.officials())?;
        self.watch_config(); // Config-Ordner kann eben erst angelegt worden sein
        self.library_state()
    }

    pub fn find_installed_path(&self, id: &str) -> String {
        let (s, _) = self.ctx();
        let scan = self.scan.lock().unwrap();
        // Nur Ordner im Mods-Verzeichnis ersetzen, nie Spieldateien.
        match scan.by_workshop.get(id).map(|i| &scan.mods[*i]) {
            Some(m) if !m.official && m.path.starts_with(s["modsDir"].as_str().unwrap_or_default()) => m.path.clone(),
            _ => String::new(),
        }
    }

    pub async fn discover_dependencies(&self, done_tasks: &[Task]) -> Res<Vec<Task>> {
        if !settings::flag("autoDependencies") {
            return Ok(vec![]);
        }
        let (s, version) = self.scan();
        let short = version["short"].as_str().unwrap_or_default();
        let mods = self.mods();
        let installed_pkg: HashSet<&str> = mods.iter().map(|m| m.package_id.as_str()).collect();
        let busy: HashSet<String> = self.installer.list().into_iter().filter(|t| t.state != "error").map(|t| t.id).collect();
        let mut wanted: Vec<(String, bool)> = Vec::new(); // workshopId -> soll aktiviert werden?
        for task in done_tasks {
            let Some(m) = task.installed_path.as_deref().and_then(|p| mods::parse_mod(Path::new(p), "local", short)) else { continue };
            let parent_active = task.activate
                || modsconfig::read_config(s["configDir"].as_str().unwrap_or_default()).active.contains(&m.package_id);
            for dep in &m.dependencies {
                if installed_pkg.contains(dep.package_id.as_str()) || dep.workshop_id.is_empty() {
                    continue;
                }
                if self.has_workshop(&dep.workshop_id) || busy.contains(&dep.workshop_id) {
                    continue;
                }
                match wanted.iter_mut().find(|(id, _)| *id == dep.workshop_id) {
                    Some(entry) => entry.1 = entry.1 || parent_active,
                    None => wanted.push((dep.workshop_id.clone(), parent_active)),
                }
            }
        }
        if wanted.is_empty() {
            return Ok(vec![]);
        }
        let info = workshop::details(&wanted.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>()).await?;
        Ok(wanted
            .into_iter()
            .map(|(id, activate)| {
                let i = info.iter().find(|x| x["id"] == json!(id)).cloned().unwrap_or(json!({}));
                task_from_info(&id, &i, None, true, false, activate)
            })
            .collect())
    }

    pub async fn on_batch_done(self: &Arc<Self>, done: Vec<Task>) {
        self.scan();
        let to_activate: Vec<&Task> = done.iter().filter(|t| t.activate).collect();
        if done.is_empty() {
            // Nur eine wartende Mod-Liste abschließen (Downloads dafür fehlgeschlagen).
        } else if !to_activate.is_empty() && settings::flag("autoActivate") {
            let result: Res<usize> = async {
                let (s, version) = self.ctx();
                let short = version["short"].as_str().unwrap_or_default();
                let current = modsconfig::read_config(s["configDir"].as_str().unwrap_or_default()).active;
                let added: Vec<String> = to_activate
                    .iter()
                    .filter_map(|t| t.installed_path.as_deref().and_then(|p| mods::parse_mod(Path::new(p), "local", short)))
                    .map(|m| m.package_id)
                    .collect();
                let n = added.len();
                self.save_active([current, added].concat(), settings::flag("autoSortOnInstall")).await?;
                Ok(n)
            }
            .await;
            match result {
                Ok(n) => self.send("toast", json!({ "type": "success", "text": tp("toast.installedActivated", json!({ "n": n })) })),
                Err(e) => self.send("toast", json!({ "type": "warning", "text": tp("toast.installedNotActivated", json!({ "error": e.0 })) })),
            }
        } else {
            self.send("toast", json!({ "type": "success", "text": tp("toast.installed", json!({ "n": done.len() })) }));
        }
        self.apply_pending_list().await;
        self.send("library:changed", Value::Null);
    }

    pub fn has_pending_list(&self) -> bool {
        self.pending_list.lock().unwrap().is_some()
    }

    /// Setzt eine geladene Mod-Liste, sobald keine Downloads mehr laufen. Gewartet wird auf die ganze Warteschlange,
    /// weil nach einem Download noch Abhängigkeiten aus der About.xml nachkommen können.
    async fn apply_pending_list(&self) {
        if self.installer.list().iter().any(|t| t.busy()) {
            return;
        }
        let pending = self.pending_list.lock().unwrap().take();
        let Some(p) = pending else { return };
        match self.activate_list(&p.name, p.entries).await {
            Ok(0) => self.send("toast", json!({ "type": "success", "text": tp("toast.listLoaded", json!({ "name": p.name })) })),
            Ok(missing) => self.send("toast", json!({ "type": "warning", "text": tp("toast.listLoadedMissing", json!({ "name": p.name, "n": missing })) })),
            Err(e) => self.send("toast", json!({ "type": "error", "text": e.0 })),
        }
    }

    /// Aktiviert die installierten Mods einer Liste in ihrer Reihenfolge, ergänzt um fehlende Pflicht-Abhängigkeiten;
    /// liefert die Zahl der fehlenden Mods. Platzhalter frisch installierter Workshop-Mods werden in der Listen-Datei
    /// durch die echte packageId ersetzt.
    async fn activate_list(&self, name: &str, mut entries: Vec<modlists::Entry>) -> Res<usize> {
        let mods = self.mods();
        let order: Vec<String> = entries.iter().filter_map(|e| modlists::find(e, &mods)).map(|m| m.package_id.clone()).collect();
        let missing = entries.len() - order.len();
        self.save_active(modlists::with_dependencies(&order, &mods).0, false).await?;
        if modlists::resolve_placeholders(&mut entries, &mods) {
            let (s, version) = self.ctx();
            let _ = modlists::write(s["configDir"].as_str().unwrap_or_default(), name, &entries, version["full"].as_str().unwrap_or_default());
        }
        Ok(missing)
    }
}

struct PendingList {
    name: String,
    entries: Vec<modlists::Entry>,
}

fn by_package(mods: &[Mod]) -> HashMap<String, &Mod> {
    let mut map = HashMap::new();
    for m in mods {
        map.entry(m.package_id.clone()).or_insert(m);
    }
    map
}

fn task_from_info(id: &str, i: &Value, dep_name: Option<&Value>, is_dependency: bool, is_update: bool, activate: bool) -> Task {
    let pick = |key: &str| i.get(key).filter(|v| truthy(v)).cloned();
    let title = pick("title")
        .or_else(|| dep_name.filter(|v| truthy(v)).cloned())
        .map(|v| js_string(&v))
        .unwrap_or_else(|| format!("Workshop-Item {id}"));
    Task::new(
        id.to_string(),
        title,
        pick("preview").map(|v| js_string(&v)).unwrap_or_default(),
        pick("size").unwrap_or(json!(0)),
        pick("timeUpdated").unwrap_or(json!(0)),
        is_dependency,
        is_update,
        activate,
    )
}

async fn is_game_running() -> bool {
    let out = tokio::process::Command::new("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {EXE}"), "/NH"])
        .creation_flags(0x0800_0000)
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_lowercase().contains(&EXE.to_lowercase()),
        _ => false,
    }
}

fn open_external(app: &AppHandle, url: &str) {
    let lower = url.to_lowercase();
    if lower.starts_with("http:") || lower.starts_with("https:") || lower.starts_with("steam:") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

type CoreState<'a> = State<'a, Arc<Core>>;

// ---------- Befehle für window.api ----------

#[tauri::command]
async fn app_context(app: AppHandle, core: CoreState<'_>) -> Res<Value> {
    let (s, version) = core.ctx();
    if s != settings::get() {
        settings::set(&s)?;
    }
    Ok(json!({
        "settings": s,
        "gameFound": is_game_dir(s["gameDir"].as_str().unwrap_or_default()),
        "version": version,
        "steamcmdReady": steamcmd::is_ready(),
        "appVersion": app.package_info().version.to_string()
    }))
}

#[tauri::command]
async fn settings_set(app: AppHandle, core: CoreState<'_>, partial: Value) -> Res<Value> {
    let next = settings::set(&partial)?;
    if partial.get("configDir").is_some() {
        core.watch_config();
    }
    if let Some(theme) = partial.get("theme").and_then(Value::as_str) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.set_background_color(Some(titlebar_color(theme)));
        }
    }
    Ok(next)
}

#[tauri::command]
async fn dialog_folder(app: AppHandle, title: Option<String>) -> Res<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file();
    if let Some(title) = title {
        dialog = dialog.set_title(title);
    }
    if let Some(win) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&win);
    }
    dialog.pick_folder(move |p| {
        let _ = tx.send(p);
    });
    Ok(rx.await.ok().flatten().map(|p| p.to_string()).unwrap_or_default())
}

#[tauri::command]
async fn library_state(core: CoreState<'_>) -> Res<Value> {
    core.library_state()
}

#[tauri::command]
async fn library_save(core: CoreState<'_>, active: Vec<String>, opts: Option<Value>) -> Res<Value> {
    let sort = opts.map_or(false, |o| truthy(&o["sort"]));
    core.save_active(active, sort).await
}

#[tauri::command]
async fn library_sort_preview(core: CoreState<'_>, active: Vec<String>) -> Res<Value> {
    core.ensure_scanned();
    let (_, version) = core.ctx();
    let mods = core.mods();
    let sorted = modsconfig::auto_sort(&active, &by_package(&mods));
    let issues = modsconfig::analyze(&sorted, &mods, version["short"].as_str().unwrap_or_default());
    Ok(json!({ "active": sorted, "issues": issues }))
}

#[tauri::command]
async fn library_analyze(core: CoreState<'_>, active: Vec<String>) -> Res<Value> {
    core.ensure_scanned();
    let (_, version) = core.ctx();
    Ok(modsconfig::analyze(&active, &core.mods(), version["short"].as_str().unwrap_or_default()))
}

#[tauri::command]
async fn library_uninstall(core: CoreState<'_>, mod_path: String) -> Res<Value> {
    let (s, _) = core.ctx();
    let mods_dir = s["modsDir"].as_str().unwrap_or_default();
    let found = core.mods().into_iter().find(|m| m.path == mod_path);
    let Some(m) = found.filter(|m| !m.official && resolve(&mod_path).starts_with(&resolve(mods_dir))) else {
        return Err(AppError::tr("err.onlyModsFolder"));
    };
    trash::delete(&mod_path).map_err(|e| AppError::msg(e.to_string()))?; // in den Papierkorb – wiederherstellbar
    if !m.workshop_id.is_empty() {
        installs::remove(&m.workshop_id)?;
    }
    let config_dir = s["configDir"].as_str().unwrap_or_default();
    let config = modsconfig::read_config(config_dir);
    if config.exists && config.active.contains(&m.package_id) && !is_game_running().await {
        core.scan();
        let (_, version) = core.ctx();
        let rest: Vec<String> = config.active.into_iter().filter(|id| *id != m.package_id).collect();
        modsconfig::write_config(config_dir, &rest, version["full"].as_str().unwrap_or_default(), &core.officials())?;
    }
    core.library_state()
}

#[tauri::command]
async fn library_check_updates(core: CoreState<'_>) -> Res<Value> {
    core.ensure_scanned();
    let record = installs::all();
    let local: Vec<Mod> = core.mods().into_iter().filter(|m| !m.workshop_id.is_empty() && !m.official).collect();
    let remote = workshop::details(&local.iter().map(|m| m.workshop_id.clone()).collect::<Vec<_>>()).await?;
    let by_id: HashMap<String, &Value> = remote.iter().map(|r| (js_string(&r["id"]), r)).collect();
    let mut updates = Vec::new();
    for m in &local {
        let Some(r) = by_id.get(&m.workshop_id) else { continue };
        if !truthy(&r["ok"]) || !truthy(&r["timeUpdated"]) {
            continue;
        }
        let recorded = record.get(&m.workshop_id).map(|x| &x["timeUpdated"]).filter(|v| truthy(v));
        let local_time = recorded.map_or((m.mtime / 1000.0).floor(), as_f64);
        if as_f64(&r["timeUpdated"]) > local_time + 60.0 {
            let mut u = (*r).clone();
            u["localName"] = json!(m.name);
            u["packageId"] = json!(m.package_id);
            u["localTime"] = recorded.cloned().unwrap_or_else(|| num(local_time));
            u["path"] = json!(m.path);
            updates.push(u);
        }
    }
    Ok(Value::Array(updates))
}

// ---------- Über die App ----------

fn os_label() -> String {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    unsafe { RtlGetVersion(&mut info) };
    let build = info.dwBuildNumber;
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    };
    format!("Windows {} (Build {build}, {arch})", if build >= 22000 { 11 } else { 10 })
}

// true, wenn Version a neuer ist als b (z. B. "1.2.0" > "1.1.9").
fn is_newer(a: &str, b: &str) -> bool {
    let parts = |s: &str| -> Vec<i64> {
        s.split(['.', '-'])
            .map(|x| {
                let digits: String = x.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
                digits.parse().unwrap_or(0)
            })
            .collect()
    };
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (pa.get(i).copied().unwrap_or(0), pb.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

#[tauri::command]
async fn app_about(app: AppHandle) -> Res<Value> {
    Ok(json!({
        "appVersion": app.package_info().version.to_string(),
        "tauri": tauri::VERSION,
        "webview": tauri::webview_version().unwrap_or_default(),
        "rust": env!("RUSTC_VERSION"),
        "os": os_label(),
        "userData": store::user_data().to_string_lossy(),
        "repo": REPO
    }))
}

// Neuestes Release auf GitHub. 404 = noch kein (öffentliches) Release.
#[tauri::command]
async fn app_check_release(app: AppHandle) -> Res<Value> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build()?;
    let res = client
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("User-Agent", "RimWorld-Mod-Library")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
    if res.status().as_u16() == 404 {
        return Ok(json!({ "state": "none" }));
    }
    if !res.status().is_success() {
        return Err(AppError::msg(format!("GitHub HTTP {}", res.status().as_u16())));
    }
    let data: Value = serde_json::from_str(&res.text().await?)?;
    let tag = js_string(&data["tag_name"]);
    let latest = tag.strip_prefix(['v', 'V']).unwrap_or(&tag).to_string();
    let current = app.package_info().version.to_string();
    Ok(json!({ "state": if is_newer(&latest, &current) { "update" } else { "current" }, "latest": latest, "url": data["html_url"] }))
}

// Lizenztexte: im Build neben der .exe (Ressourcen), im Quellcode im Repo.
#[tauri::command]
async fn app_open_doc(app: AppHandle, name: String) -> Res<Value> {
    let (packaged, source) = match name.as_str() {
        "license" => ("LICENSE.txt", "LICENSE"),
        "notices" => ("THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"),
        _ => return Ok(Value::Null),
    };
    let file = if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join(source)
    } else {
        std::env::current_exe()?.parent().map(|d| d.join(packaged)).unwrap_or_default()
    };
    if file.exists() {
        let _ = app.opener().open_path(file.to_string_lossy(), None::<&str>);
    } else {
        open_external(&app, &format!("https://github.com/{REPO}/blob/main/{source}"));
    }
    Ok(Value::Null)
}

#[tauri::command]
async fn app_copy(app: AppHandle, text: Value) -> Res<Value> {
    app.clipboard().write_text(js_string(&text)).map_err(|e| AppError::msg(e.to_string()))?;
    Ok(Value::Null)
}

#[tauri::command]
async fn shell_open(app: AppHandle, target: String) -> Res<Value> {
    let lower = target.to_lowercase();
    if lower.starts_with("http:") || lower.starts_with("https:") || lower.starts_with("steam:") {
        open_external(&app, &target);
    } else if Path::new(&target).exists() {
        let _ = app.opener().open_path(&target, None::<&str>);
    }
    Ok(Value::Null)
}

#[tauri::command]
async fn workshop_browse(params: Option<Value>) -> Res<Value> {
    workshop::browse(&params.unwrap_or(json!({}))).await
}

#[tauri::command]
async fn workshop_details(id: Value) -> Res<Value> {
    let id = js_string(&id);
    let item = workshop::details(&[id.clone()]).await?.into_iter().next();
    // Detailseite optional.
    let page = workshop::page_info(&id)
        .await
        .unwrap_or_else(|_| json!({ "required": [], "requiredDlc": [], "screenshots": [], "author": "" }));
    let mut out = util::merge(item.as_ref().unwrap_or(&Value::Null), &page);
    let author = item.as_ref().map(|i| &i["author"]).filter(|a| truthy(a)).unwrap_or(&page["author"]);
    out["author"] = author.clone();
    Ok(out)
}

#[tauri::command]
async fn workshop_details_many(ids: Vec<Value>) -> Res<Value> {
    workshop::details_value(&ids.iter().map(js_string).collect::<Vec<_>>()).await
}

#[tauri::command]
async fn workshop_collection(input: Value) -> Res<Value> {
    workshop::collection(&js_string(&input)).await
}

#[tauri::command]
async fn workshop_suggestions(core: CoreState<'_>) -> Res<Value> {
    let (_, version) = core.scan();
    let short = version["short"].as_str().unwrap_or_default().to_string();
    let mods = core.mods();
    let installed_ws: HashSet<&str> = mods.iter().map(|m| m.workshop_id.as_str()).filter(|x| !x.is_empty()).collect();
    let installed_pkg: HashSet<&str> = mods.iter().map(|m| m.package_id.as_str()).collect();
    let fits_version = |it: &Value| {
        let versions = it["versions"].as_array().cloned().unwrap_or_default();
        short.is_empty() || versions.is_empty() || versions.contains(&json!(short))
    };

    // Fehlende Abhängigkeiten installierter Mods
    let mut missing: Vec<(String, Value)> = Vec::new();
    for m in &mods {
        for d in &m.dependencies {
            if installed_pkg.contains(d.package_id.as_str()) || (!d.workshop_id.is_empty() && installed_ws.contains(d.workshop_id.as_str())) {
                continue;
            }
            let key = if d.workshop_id.is_empty() { d.package_id.clone() } else { d.workshop_id.clone() };
            let idx = match missing.iter().position(|(k, _)| *k == key) {
                Some(i) => i,
                None => {
                    let mut entry = serde_json::to_value(d).unwrap_or_default();
                    entry["requiredBy"] = json!([]);
                    missing.push((key, entry));
                    missing.len() - 1
                }
            };
            missing[idx].1["requiredBy"].as_array_mut().unwrap().push(json!(m.name));
        }
    }
    let missing_ids: Vec<String> = missing.iter().map(|(_, d)| js_string(&d["workshopId"])).filter(|x| !x.is_empty()).collect();
    let missing_details = workshop::details(&missing_ids).await.unwrap_or_default();
    let missing_out: Vec<Value> = missing
        .into_iter()
        .map(|(_, mut d)| {
            let item = missing_details.iter().find(|x| x["id"] == d["workshopId"]).cloned().unwrap_or(Value::Null);
            d["item"] = item;
            d
        })
        .collect();

    let essentials_ids: Vec<String> = ESSENTIALS.iter().map(|s| s.to_string()).collect();
    let trend_params = json!({ "sort": "trend", "days": 7, "version": &short });
    let popular_params = json!({ "sort": "popular", "version": &short });
    let (essentials, trending, popular) = tokio::join!(
        workshop::details(&essentials_ids),
        workshop::browse(&trend_params),
        workshop::browse(&popular_params)
    );
    let items = |r: Res<Value>| r.ok().and_then(|v| v["items"].as_array().cloned()).unwrap_or_default();
    let not_installed = |it: &Value| truthy(&it["ok"]) && !installed_ws.contains(js_string(&it["id"]).as_str()) && fits_version(it);
    let pick = |list: Vec<Value>, max: usize| -> Vec<Value> { list.into_iter().filter(|x| not_installed(x)).take(max).collect() };
    Ok(json!({
        "missing": missing_out,
        "essentials": pick(essentials.unwrap_or_default(), usize::MAX),
        "trending": pick(items(trending), 12),
        "popular": pick(items(popular), 12)
    }))
}

// ids: Workshop-IDs. opts: { withDeps, activate, isUpdate }
#[tauri::command]
async fn install_enqueue(core: CoreState<'_>, ids: Vec<Value>, opts: Option<Value>) -> Res<Value> {
    core.ensure_scanned();
    let opts = opts.filter(Value::is_object).unwrap_or(json!({}));
    let s = settings::get();
    let with_deps = truthy(opts.get("withDeps").filter(|v| !v.is_null()).unwrap_or(&s["autoDependencies"]));
    let is_update = truthy(&opts["isUpdate"]);
    let roots: Vec<String> = ids.iter().map(js_string).collect();
    let mut all = roots.clone();
    let mut dep_names = Map::new();
    if with_deps && !is_update {
        core.send("status", t("status.checkingDeps"));
        let installed: HashSet<String> = core.scan.lock().unwrap().by_workshop.keys().cloned().collect();
        let check = move |id: &str| installed.contains(id);
        let (order, names) = workshop::resolve_dependencies(&roots, &check).await;
        all = order;
        dep_names = names;
        core.send("status", json!(""));
    }
    let info = workshop::details(&all).await?;
    let items: Vec<Task> = all
        .iter()
        .map(|id| {
            let i = info.iter().find(|x| x["id"] == json!(id)).cloned().unwrap_or(json!({}));
            let known = core.has_workshop(id);
            task_from_info(
                id,
                &i,
                dep_names.get(id),
                !roots.contains(id),
                is_update || known,
                opts["activate"] != json!(false) && !is_update && !known,
            )
        })
        .collect();
    let deps: Vec<String> = items.iter().filter(|i| i.is_dependency).map(|i| i.title.clone()).collect();
    let count = items.len();
    core.installer.enqueue(core.inner(), items);
    Ok(json!({ "count": count, "dependencies": deps }))
}

#[tauri::command]
async fn install_queue(core: CoreState<'_>) -> Res<Value> {
    Ok(json!(core.installer.list()))
}

#[tauri::command]
async fn install_cancel(core: CoreState<'_>) -> Res<Value> {
    core.installer.cancel(&core);
    Ok(Value::Null)
}

#[tauri::command]
async fn install_clear(core: CoreState<'_>) -> Res<Value> {
    core.installer.clear_finished(&core);
    Ok(Value::Null)
}

#[tauri::command]
async fn steamcmd_ensure(core: CoreState<'_>) -> Res<bool> {
    let status = |msg: Value| core.send("status", msg);
    steamcmd::ensure(&status).await
}

#[tauri::command]
async fn steamcmd_clear_cache() -> Res<Value> {
    steamcmd::clear_cache()?;
    Ok(Value::Null)
}

#[tauri::command]
async fn game_launch(app: AppHandle, core: CoreState<'_>) -> Res<Value> {
    let (s, _) = core.ctx();
    if is_game_running().await {
        return Err(AppError::tr("err.alreadyRunning"));
    }
    let epic = s["epicAppName"].as_str().unwrap_or_default();
    let mut cloud_prompt = false;
    if s["launchVia"] == "epic" && !epic.is_empty() {
        // Epic fragt nach dem Cloud-Stand, wenn ModsConfig.xml oder Mod-Listen seit dem letzten Abgleich außerhalb des Spiels geändert wurden.
        let config_dir = s["configDir"].as_str().unwrap_or_default();
        let changed = modsconfig::modified(config_dir).max(modlists::last_change(config_dir));
        cloud_prompt = paths::epic_cloud_synced_at(epic).zip(changed).is_some_and(|(synced, changed)| changed > synced);
        app.opener()
            .open_url(format!("com.epicgames.launcher://apps/{epic}?action=launch&silent=true"), None::<&str>)
            .map_err(|e| AppError::msg(e.to_string()))?;
    } else {
        let game_dir = s["gameDir"].as_str().unwrap_or_default();
        let exe = Path::new(game_dir).join(EXE);
        if !exe.exists() {
            return Err(AppError::tr("err.exeNotFound"));
        }
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        std::process::Command::new(exe)
            .current_dir(game_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .spawn()?;
    }
    Ok(json!({ "cloudPrompt": cloud_prompt }))
}

// ---------- Mod-Listen (siehe modlists.rs) ----------

fn config_dir_of(core: &Core) -> String {
    core.ctx().0["configDir"].as_str().unwrap_or_default().to_string()
}

fn modlist_or_err(config_dir: &str, name: &str) -> Res<modlists::ModList> {
    modlists::get(config_dir, name).ok_or_else(|| AppError::tr("err.listNotFound"))
}

fn check_list_name(config_dir: &str, name: &str) -> Res<String> {
    let name = name.trim();
    if !modlists::valid_name(name) {
        return Err(AppError::tr("err.listName"));
    }
    if modlists::exists(config_dir, name) {
        return Err(AppError::trp("err.listExists", json!({ "name": name })));
    }
    Ok(name.to_string())
}

/// Workshop-Titel für Einträge ohne Namen (z. B. aus einem geteilten Code); ohne Netz bleibt die ID stehen.
async fn fill_names(entries: &mut [modlists::Entry], mods: &[Mod]) {
    let ids: Vec<String> = entries.iter().filter(|e| e.name.is_empty() && !e.workshop_id.is_empty()).map(|e| e.workshop_id.clone()).collect();
    let info = if ids.is_empty() { vec![] } else { workshop::details(&ids).await.unwrap_or_default() };
    for e in entries.iter_mut().filter(|e| e.name.is_empty()) {
        let title = info.iter().find(|x| x["id"] == json!(e.workshop_id)).map(|x| js_string(&x["title"]));
        e.name = modlists::find(e, mods)
            .map(|m| m.name.clone())
            .or(title.filter(|t| !t.is_empty()))
            .unwrap_or_else(|| if e.package_id.is_empty() { e.workshop_id.clone() } else { e.package_id.clone() });
    }
}

#[tauri::command]
async fn modlists_get(core: CoreState<'_>) -> Res<Value> {
    core.ensure_scanned();
    let config_dir = config_dir_of(&core);
    let mods = core.mods();
    let active = modsconfig::read_config(&config_dir).active;
    let lists: Vec<Value> = modlists::all(&config_dir)
        .iter()
        .map(|list| {
            let found: Vec<Option<&Mod>> = list.mods.iter().map(|e| modlists::find(e, &mods)).collect();
            let missing: Vec<&modlists::Entry> = list.mods.iter().zip(&found).filter(|(_, m)| m.is_none()).map(|(e, _)| e).collect();
            let ids: Vec<&String> = found.iter().flatten().map(|m| &m.package_id).collect();
            json!({
                "name": list.name,
                "path": list.path,
                "modified": list.modified,
                "count": list.mods.len(),
                "missing": missing.len(),
                "installable": missing.iter().filter(|e| !e.workshop_id.is_empty()).count(),
                "active": missing.is_empty() && ids.len() == active.len() && ids.iter().zip(&active).all(|(a, b)| *a == b),
                "names": list.mods.iter().map(|e| if e.name.is_empty() { &e.package_id } else { &e.name }).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(json!({ "dir": modlists::dir(&config_dir), "lists": lists }))
}

/// Speichert die aktiven Mods (Reihenfolge aus ModsConfig.xml) als Liste.
#[tauri::command]
async fn modlist_save(core: CoreState<'_>, name: String, overwrite: bool) -> Res<Value> {
    core.ensure_scanned();
    let (s, version) = core.ctx();
    let config_dir = s["configDir"].as_str().unwrap_or_default();
    let name = if overwrite && modlists::exists(config_dir, name.trim()) { name.trim().to_string() } else { check_list_name(config_dir, &name)? };
    let mods = core.mods();
    let pkgs = by_package(&mods);
    let entries: Vec<modlists::Entry> = modsconfig::read_config(config_dir)
        .active
        .iter()
        .map(|id| pkgs.get(id).map(|m| modlists::entry_for(m)).unwrap_or(modlists::Entry { package_id: id.clone(), name: id.clone(), ..Default::default() }))
        .collect();
    modlists::write(config_dir, &name, &entries, version["full"].as_str().unwrap_or_default())?;
    core.watch_config(); // Listen-Ordner kann eben erst angelegt worden sein
    Ok(json!({ "name": name }))
}

#[tauri::command]
async fn modlist_rename(core: CoreState<'_>, name: String, new_name: String) -> Res<Value> {
    let config_dir = config_dir_of(&core);
    modlist_or_err(&config_dir, &name)?;
    if new_name.trim() == name {
        return Ok(json!({ "name": name }));
    }
    let new_name = check_list_name(&config_dir, &new_name)?;
    modlists::rename(&config_dir, &name, &new_name)?;
    Ok(json!({ "name": new_name }))
}

#[tauri::command]
async fn modlist_delete(core: CoreState<'_>, name: String) -> Res<Value> {
    let config_dir = config_dir_of(&core);
    modlist_or_err(&config_dir, &name)?;
    modlists::delete(&config_dir, &name)?;
    Ok(Value::Null)
}

#[tauri::command]
async fn modlist_code(core: CoreState<'_>, name: String) -> Res<String> {
    let config_dir = config_dir_of(&core);
    let list = modlist_or_err(&config_dir, &name)?;
    Ok(modlists::encode(&list.name, &list.mods))
}

/// Legt eine Liste aus einem geteilten Code oder einer .rml-Datei an (bei gleichem Namen mit Zusatz "(2)").
#[tauri::command]
async fn modlist_import(app: AppHandle, core: CoreState<'_>, code: Option<String>) -> Res<Value> {
    core.ensure_scanned();
    let (s, version) = core.ctx();
    let config_dir = s["configDir"].as_str().unwrap_or_default();
    let (name, mut entries) = match code {
        Some(code) => modlists::decode(&code).ok_or_else(|| AppError::tr("err.listCode"))?,
        None => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            let mut dialog = app.dialog().file().add_filter("RimWorld mod list", &["rml"]);
            if let Some(win) = app.get_webview_window("main") {
                dialog = dialog.set_parent(&win);
            }
            dialog.pick_file(move |p| {
                let _ = tx.send(p);
            });
            let Some(path) = rx.await.ok().flatten().and_then(|p| p.into_path().ok()) else { return Ok(Value::Null) };
            let entries = fs_read(&path).and_then(|text| modlists::parse(&text)).ok_or_else(|| AppError::tr("err.listFile"))?;
            (path.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), entries)
        }
    };
    // Bereits installierte Mods mit allen Angaben übernehmen (ein Code enthält nur Workshop-ID oder packageId).
    let mods = core.mods();
    for e in entries.iter_mut() {
        if let Some(m) = modlists::find(e, &mods) {
            *e = modlists::entry_for(m);
        }
    }
    fill_names(&mut entries, &mods).await;
    let name = modlists::unique_name(config_dir, &name);
    modlists::write(config_dir, &name, &entries, version["full"].as_str().unwrap_or_default())?;
    core.watch_config();
    Ok(json!({ "name": name }))
}

/// Legt eine Liste aus einer Workshop-Collection an: Core zuerst, dann die Mods in der Reihenfolge der Collection.
#[tauri::command]
async fn modlist_from_collection(core: CoreState<'_>, name: String, items: Vec<Value>, overwrite: bool) -> Res<Value> {
    core.ensure_scanned();
    let (s, version) = core.ctx();
    let config_dir = s["configDir"].as_str().unwrap_or_default();
    let name = if overwrite && modlists::exists(config_dir, name.trim()) { name.trim().to_string() } else { check_list_name(config_dir, &name)? };
    let mods = core.mods();
    let core_entry = modlists::Entry { package_id: modsconfig::CORE.into(), name: "Core".into(), ..Default::default() };
    let mut entries = vec![modlists::find(&core_entry, &mods).map(modlists::entry_for).unwrap_or(core_entry)];
    for item in &items {
        let entry = modlists::Entry { workshop_id: js_string(&item["id"]), name: js_string(&item["title"]), ..Default::default() };
        if !entry.workshop_id.is_empty() {
            entries.push(modlists::find(&entry, &mods).map(modlists::entry_for).unwrap_or(entry));
        }
    }
    modlists::write(config_dir, &name, &entries, version["full"].as_str().unwrap_or_default())?;
    core.watch_config();
    Ok(json!({ "name": name }))
}

fn fs_read(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// Was beim Laden einer Liste passiert: welche Mods aktiviert, deaktiviert, installiert werden oder fehlen.
#[tauri::command]
async fn modlist_preview(core: CoreState<'_>, name: String) -> Res<Value> {
    core.ensure_scanned();
    let config_dir = config_dir_of(&core);
    let mut list = modlist_or_err(&config_dir, &name)?;
    let mods = core.mods();
    fill_names(&mut list.mods, &mods).await;
    let active = modsconfig::read_config(&config_dir).active;
    let entries: Vec<Value> = list
        .mods
        .iter()
        .map(|e| {
            let m = modlists::find(e, &mods);
            let state = match m {
                Some(m) if active.contains(&m.package_id) => "active",
                Some(_) => "activate",
                None if !e.workshop_id.is_empty() => "install",
                None => "missing",
            };
            json!({ "name": m.map_or(&e.name, |m| &m.name), "packageId": m.map_or(&e.package_id, |m| &m.package_id), "workshopId": e.workshop_id, "state": state })
        })
        .collect();
    let plan = plan_list(&core, &list.mods, &mods).await;
    let in_list: HashSet<&str> = list.mods.iter().filter_map(|e| modlists::find(e, &mods)).map(|m| m.package_id.as_str()).collect();
    let pkgs = by_package(&mods);
    let deactivate: Vec<&str> = active
        .iter()
        .filter(|id| !in_list.contains(id.as_str()) && !plan.added.contains(*id))
        .map(|id| pkgs.get(id).map_or(id.as_str(), |m| m.name.as_str()))
        .collect();
    Ok(json!({ "name": list.name, "mods": entries, "deactivate": deactivate, "deps": plan.deps }))
}

struct ListPlan {
    install: Vec<String>, // Workshop-IDs: fehlende Mods der Liste und fehlende Abhängigkeiten
    added: Vec<String>,   // installierte Abhängigkeiten, die nicht in der Liste stehen
    deps: Vec<Value>,     // für die Vorschau: { name, state: "activate" | "install" }
}

/// Was beim Laden einer Liste installiert und an Abhängigkeiten ergänzt wird. Abhängigkeiten noch nicht installierter
/// Mods kommen von ihren Workshop-Seiten (wie beim normalen Installieren).
async fn plan_list(core: &Core, entries: &[modlists::Entry], mods: &[Mod]) -> ListPlan {
    let pkgs = by_package(mods);
    let order: Vec<String> = entries.iter().filter_map(|e| modlists::find(e, mods)).map(|m| m.package_id.clone()).collect();
    let (_, added) = modlists::with_dependencies(&order, mods);
    let mut deps: Vec<Value> = added.iter().map(|id| json!({ "name": pkgs.get(id).map_or(id.as_str(), |m| m.name.as_str()), "state": "activate" })).collect();

    let list_installs: Vec<String> = entries.iter().filter(|e| modlists::find(e, mods).is_none() && !e.workshop_id.is_empty()).map(|e| e.workshop_id.clone()).collect();
    let mut dep_names = HashMap::new();
    for d in order.iter().chain(&added).filter_map(|id| pkgs.get(id)).flat_map(|m| &m.dependencies) {
        if !pkgs.contains_key(&d.package_id) && !d.workshop_id.is_empty() {
            dep_names.insert(d.workshop_id.clone(), d.display_name.clone());
        }
    }
    let roots = util::unique(list_installs.iter().chain(dep_names.keys()).cloned());
    if roots.is_empty() {
        return ListPlan { install: vec![], added, deps };
    }
    core.send("status", t("status.checkingDeps"));
    let installed: HashSet<String> = mods.iter().filter(|m| !m.workshop_id.is_empty()).map(|m| m.workshop_id.clone()).collect();
    let check = move |id: &str| installed.contains(id);
    let (install, names) = workshop::resolve_dependencies(&roots, &check).await;
    core.send("status", json!(""));
    for id in install.iter().filter(|id| !list_installs.contains(id)) {
        let name = dep_names.get(id).cloned().or_else(|| names.get(id).map(js_string)).filter(|n| !n.is_empty()).unwrap_or_else(|| id.clone());
        deps.push(json!({ "name": name, "state": "install" }));
    }
    ListPlan { install, added, deps }
}

/// Lädt eine Liste: fehlende Mods aus dem Workshop installieren, danach genau diese Mods in dieser Reihenfolge aktivieren.
#[tauri::command]
async fn modlist_apply(core: CoreState<'_>, name: String) -> Res<Value> {
    core.ensure_scanned();
    let config_dir = config_dir_of(&core);
    let list = modlist_or_err(&config_dir, &name)?;
    if is_game_running().await {
        return Err(AppError::tr("err.gameRunning"));
    }
    let mods = core.mods();
    let install = plan_list(&core, &list.mods, &mods).await.install;
    if install.is_empty() {
        let missing = core.activate_list(&list.name, list.mods).await?;
        return Ok(json!({ "installing": 0, "missing": missing }));
    }
    let info = workshop::details(&install).await?;
    let items: Vec<Task> = install
        .iter()
        .map(|id| {
            let i = info.iter().find(|x| x["id"] == json!(id)).cloned().unwrap_or(json!({}));
            task_from_info(id, &i, None, false, false, false)
        })
        .collect();
    core.installer.enqueue(core.inner(), items); // erst danach vormerken: die Downloads müssen schon in der Warteschlange stehen
    *core.pending_list.lock().unwrap() = Some(PendingList { name: list.name, entries: list.mods });
    Ok(json!({ "installing": install.len(), "missing": 0 }))
}

// ---------- Fensterrahmen (eigene Titelleiste, siehe bridge.js) ----------

/// Snap-Layouts von Windows 11 beim Verweilen auf "Maximieren" (wie die nativen Fensterknöpfe): Win+Z.
#[tauri::command]
async fn win_snap_overlay() {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    let key = |vk: u16, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { 0 }, time: 0, dwExtraInfo: 0 } },
    };
    let inputs = [key(VK_LWIN, false), key(b'Z' as u16, false), key(b'Z' as u16, true), key(VK_LWIN, true)];
    unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
}

/// Systemmenü (Rechtsklick auf die Titelleiste).
#[tauri::command]
async fn win_system_menu(app: AppHandle) -> Res<()> {
    let win = app.get_webview_window("main").ok_or("no window")?;
    let hwnd = win.hwnd()?.0 as isize;
    let maximized = win.is_maximized()?;
    app.run_on_main_thread(move || unsafe {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        let hwnd = hwnd as windows_sys::Win32::Foundation::HWND;
        let menu = GetSystemMenu(hwnd, 0);
        if menu.is_null() {
            return;
        }
        let state = |on: bool| if on { MF_BYCOMMAND | MF_ENABLED } else { MF_BYCOMMAND | MF_GRAYED };
        EnableMenuItem(menu, SC_RESTORE, state(maximized));
        EnableMenuItem(menu, SC_MOVE, state(!maximized));
        EnableMenuItem(menu, SC_SIZE, state(!maximized));
        EnableMenuItem(menu, SC_MINIMIZE, state(true));
        EnableMenuItem(menu, SC_MAXIMIZE, state(!maximized));
        EnableMenuItem(menu, SC_CLOSE, state(true));
        SetMenuDefaultItem(menu, SC_CLOSE, 0);
        let mut pt = POINT { x: 0, y: 0 };
        GetCursorPos(&mut pt);
        let cmd = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.x, pt.y, 0, hwnd, std::ptr::null());
        if cmd != 0 {
            PostMessageW(hwnd, WM_SYSCOMMAND, cmd as usize, 0);
        }
    })?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // Datenordner %APPDATA%\RimWorld Mod Library (unverändert seit Version 1.0).
            store::init(app.path().config_dir()?.join("RimWorld Mod Library"));
            std::thread::spawn(|| {
                store::remove_electron_leftovers();
                steamcmd::remove_update_leftovers();
            });
            app.manage(Arc::new(Core {
                app: app.handle().clone(),
                scan: Mutex::new(Scan::default()),
                asset_dirs: Mutex::new(HashSet::new()),
                config_watcher: watch::DirWatcher::new("library:changed", Some("ModsConfig.xml"), modsconfig::is_own_write),
                lists_watcher: watch::DirWatcher::new("modlists:changed", None, |_| false),
                pending_list: Mutex::new(None),
                installer: Installer::default(),
            }));
            app.state::<Arc<Core>>().watch_config();

            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("RimWorld Mod Library")
                .inner_size(1400.0, 880.0)
                .min_inner_size(980.0, 640.0)
                .center()
                .decorations(false)
                .visible(false)
                .background_color(titlebar_color(&settings::str("theme")))
                .theme(Some(tauri::Theme::Dark))
                .disable_drag_drop_handler()
                .on_navigation(move |url| {
                    // Im Entwicklungsmodus liefert der Dev-Server der Tauri-CLI die Seite über localhost aus.
                    let dev = cfg!(debug_assertions) && matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
                    let internal = dev || matches!(url.host_str(), Some("tauri.localhost")) || url.scheme() == "tauri" || url.scheme() == "about";
                    if !internal {
                        open_external(&handle, url.as_str());
                    }
                    internal
                })
                .on_page_load(|win, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        let _ = win.show();
                    }
                })
                .build()?;
            Ok(())
        })
        .on_window_event(|_, event| {
            if let tauri::WindowEvent::Destroyed = event {
                steamcmd::cancel();
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_context,
            app_about,
            app_check_release,
            app_open_doc,
            app_copy,
            settings_set,
            dialog_folder,
            library_state,
            library_save,
            library_sort_preview,
            library_analyze,
            library_uninstall,
            library_check_updates,
            shell_open,
            workshop_browse,
            workshop_details,
            workshop_details_many,
            workshop_collection,
            workshop_suggestions,
            install_enqueue,
            install_queue,
            install_cancel,
            install_clear,
            steamcmd_ensure,
            steamcmd_clear_cache,
            game_launch,
            modlists_get,
            modlist_save,
            modlist_rename,
            modlist_delete,
            modlist_code,
            modlist_import,
            modlist_preview,
            modlist_apply,
            modlist_from_collection,
            win_snap_overlay,
            win_system_menu
        ])
        .run(tauri::generate_context!())
        .expect("error while running RimWorld Mod Library");
}
