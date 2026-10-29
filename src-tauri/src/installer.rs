// Download-Warteschlange: SteamCMD laden lassen, in den Mods-Ordner verschieben, merken, aktivieren.
use crate::steamcmd::{self, Event};
use crate::store::installs;
use crate::util::{t, AppError, Res};
use crate::Core;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MAX_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub size: Value,
    pub time_updated: Value,
    pub is_dependency: bool,
    pub is_update: bool,
    pub activate: bool,
    pub state: String, // 'queued' | 'downloading' | 'installing' | 'done' | 'error'
    pub error: Value,
    pub progress: f64,
    pub attempts: u32,
    pub order: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deps_checked: Option<bool>,
}

impl Task {
    // items: { id, title, preview, size, timeUpdated, isDependency, isUpdate, activate }
    pub fn new(id: String, title: String, preview: String, size: Value, time_updated: Value, is_dependency: bool, is_update: bool, activate: bool) -> Self {
        Task {
            id,
            title,
            preview,
            size,
            time_updated,
            is_dependency,
            is_update,
            activate,
            state: "queued".into(),
            error: json!(""),
            progress: 0.0,
            attempts: 0,
            order: 0,
            installed_path: None,
            deps_checked: None,
        }
    }

    pub fn busy(&self) -> bool {
        matches!(self.state.as_str(), "queued" | "downloading" | "installing")
    }
}

#[derive(Default)]
pub struct Installer {
    tasks: Mutex<Vec<Task>>,
    running: AtomicBool,
    cancelled: AtomicBool,
}

// SteamCMD-Fehlergründe (z. B. "Timeout", "Access Denied") in lesbare Texte übersetzen (siehe bridge.js).
fn translate_error(reason: &str) -> Value {
    if reason.is_empty() {
        t("common.unknownError")
    } else {
        json!({ "$t": format!("dlerr.{reason}"), "fallback": reason })
    }
}

impl Installer {
    pub fn list(&self) -> Vec<Task> {
        let mut list = self.tasks.lock().unwrap().clone();
        list.sort_by_key(|t| t.order);
        list
    }

    fn with<R>(&self, id: &str, f: impl FnOnce(&mut Task) -> R) -> Option<R> {
        self.tasks.lock().unwrap().iter_mut().find(|t| t.id == id).map(f)
    }

    fn emit(&self, core: &Core) {
        core.send("queue:update", json!(self.list()));
    }

    pub fn enqueue(&self, core: &Arc<Core>, items: Vec<Task>) {
        self.add(core, items);
        spawn_process(core.clone());
    }

    pub fn add(&self, core: &Core, items: Vec<Task>) {
        {
            let mut tasks = self.tasks.lock().unwrap();
            let mut order = tasks.len();
            for mut item in items {
                if tasks.iter().any(|t| t.id == item.id && t.busy()) {
                    continue;
                }
                item.order = order;
                order += 1;
                match tasks.iter_mut().find(|t| t.id == item.id) {
                    Some(existing) => *existing = item,
                    None => tasks.push(item),
                }
            }
        }
        self.emit(core);
    }

    pub fn clear_finished(&self, core: &Core) {
        self.tasks.lock().unwrap().retain(|t| t.state != "done" && t.state != "error");
        self.emit(core);
    }

    pub fn cancel(&self, core: &Core) {
        self.cancelled.store(true, Ordering::SeqCst);
        for task in self.tasks.lock().unwrap().iter_mut() {
            if task.state == "queued" {
                task.state = "error".into();
                task.error = t("dlerr.Cancelled");
            }
        }
        steamcmd::cancel();
        self.emit(core);
    }

    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    async fn run_batches(&self, core: &Arc<Core>, installed: &mut Vec<Task>) -> Res<()> {
        let status = |msg: Value| core.send("status", msg);
        steamcmd::ensure(&status).await?;
        while !self.cancelled() {
            let batch: Vec<String> = self.list().into_iter().filter(|t| t.state == "queued").map(|t| t.id).collect();
            if batch.is_empty() {
                break;
            }
            for t in self.tasks.lock().unwrap().iter_mut().filter(|t| batch.contains(&t.id)) {
                t.state = "downloading".into();
                t.attempts += 1;
            }
            self.emit(core);

            let ticking = Arc::new(AtomicBool::new(true));
            let timer = {
                let (core, ticking, batch) = (core.clone(), ticking.clone(), batch.clone());
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(Duration::from_millis(800)).await;
                        if !ticking.load(Ordering::SeqCst) {
                            break;
                        }
                        let me = &core.installer;
                        let mut changed = false;
                        for id in &batch {
                            let Some((size, progress)) = me.with(id, |t| (t.state == "downloading").then(|| (t.size.as_f64().unwrap_or(0.0), t.progress))).flatten() else { continue };
                            if size <= 0.0 {
                                continue;
                            }
                            let p = (steamcmd::downloaded_bytes(id) as f64 / size).min(0.99);
                            if (p - progress).abs() > 0.005 {
                                me.with(id, |t| t.progress = p);
                                changed = true;
                            }
                        }
                        if changed {
                            me.emit(&core);
                        }
                    }
                })
            };

            steamcmd::download_items(&batch, |ev| {
                let id = ev.id().to_string();
                let Some(task) = self.with(&id, |t| t.clone()) else { return };
                match ev {
                    Event::Success(_, path) => {
                        self.with(&id, |t| t.state = "installing".into());
                        self.emit(core);
                        // Bleibt "installing", bis die Abhängigkeiten geprüft sind (siehe unten).
                        match self.install(core, &task, &path) {
                            Ok(target) => {
                                if let Some(done) = self.with(&id, |t| {
                                    t.installed_path = Some(target);
                                    t.progress = 1.0;
                                    t.clone()
                                }) {
                                    installed.push(done);
                                }
                            }
                            Err(e) => {
                                self.with(&id, |t| {
                                    t.state = "error".into();
                                    t.error = e.0;
                                });
                            }
                        }
                    }
                    Event::Error(_, reason) => {
                        // Timeouts sind bei großen Mods normal – SteamCMD setzt beim nächsten Versuch fort.
                        let cancelled = self.cancelled();
                        self.with(&id, |t| {
                            if t.attempts < MAX_ATTEMPTS && !cancelled {
                                t.state = "queued".into();
                            } else {
                                t.state = "error".into();
                                t.error = translate_error(&reason);
                            }
                        });
                    }
                    Event::Start(_) => {}
                }
                self.emit(core);
            })
            .await;
            ticking.store(false, Ordering::SeqCst);
            timer.abort();

            // Abhängigkeiten aus der About.xml der frisch installierten Mods nachladen –
            // viele Autoren tragen z. B. Harmony nur dort ein, nicht auf der Workshop-Seite.
            let fresh: Vec<Task> = {
                let mut tasks = self.tasks.lock().unwrap();
                tasks
                    .iter_mut()
                    .filter(|t| batch.contains(&t.id) && t.state == "installing" && t.installed_path.is_some() && t.deps_checked.is_none())
                    .map(|t| {
                        t.deps_checked = Some(true);
                        t.clone()
                    })
                    .collect()
            };
            if !fresh.is_empty() && !self.cancelled() {
                // Nachladen ist optional – fehlende Abhängigkeiten zeigt die Bibliothek an.
                if let Ok(extra) = core.discover_dependencies(&fresh).await {
                    if !extra.is_empty() {
                        self.add(core, extra);
                    }
                }
            }
            for t in self.tasks.lock().unwrap().iter_mut().filter(|t| fresh.iter().any(|f| f.id == t.id)) {
                t.state = "done".into();
            }
            self.emit(core);
        }
        Ok(())
    }

    pub async fn process(&self, core: &Arc<Core>) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        self.cancelled.store(false, Ordering::SeqCst);
        let mut installed = Vec::new();
        if let Err(e) = self.run_batches(core, &mut installed).await {
            for t in self.tasks.lock().unwrap().iter_mut() {
                if t.state == "installing" && t.installed_path.is_some() {
                    t.state = "done".into();
                } else if t.busy() {
                    t.state = "error".into();
                    t.error = e.0.clone();
                }
            }
            self.emit(core);
        }
        self.running.store(false, Ordering::SeqCst);
        core.send("status", json!(""));
        if !installed.is_empty() || core.has_pending_list() {
            let core2 = core.clone();
            tauri::async_runtime::spawn(async move { core2.on_batch_done(installed).await });
        }
        // Während des Abschlusses hinzugefügte Items nicht liegen lassen.
        if !self.cancelled() && self.list().iter().any(|t| t.state == "queued") {
            spawn_process(core.clone());
        }
    }

    fn install(&self, core: &Core, task: &Task, downloaded_path: &str) -> Res<String> {
        let src = if Path::new(downloaded_path).exists() { downloaded_path.into() } else { steamcmd::item_dir(&task.id) };
        if !src.exists() {
            return Err(AppError::tr("err.filesMissing"));
        }
        let mods_dir = core.ctx().0["modsDir"].as_str().unwrap_or_default().to_string();
        if mods_dir.is_empty() {
            return Err(AppError::tr("err.noModsDir"));
        }
        fs::create_dir_all(&mods_dir)?;

        let existing = core.find_installed_path(&task.id);
        let target = if existing.is_empty() { Path::new(&mods_dir).join(&task.id) } else { existing.clone().into() };
        if !existing.is_empty() && Path::new(&existing).join(".git").exists() {
            return Err(AppError::tr("err.gitRepo"));
        }
        remove_all(&target)?;
        if fs::rename(&src, &target).is_err() {
            copy_dir(&src, &target)?;
            remove_all(&src)?;
        }
        let id_file = target.join("About").join("PublishedFileId.txt");
        if id_file.parent().is_some_and(Path::exists) && !id_file.exists() {
            fs::write(&id_file, &task.id)?;
        }

        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        let time_updated = if crate::util::truthy(&task.time_updated) { task.time_updated.clone() } else { json!(now.as_secs()) };
        installs::record(&task.id, json!({ "title": task.title, "timeUpdated": time_updated, "installedAt": now.as_millis() as u64 }))?;
        Ok(target.to_string_lossy().into_owned())
    }
}

fn spawn_process(core: Arc<Core>) {
    tauri::async_runtime::spawn(async move { core.installer.process(&core).await });
}

fn remove_all(p: &Path) -> std::io::Result<()> {
    match fs::remove_dir_all(p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) if p.is_file() => fs::remove_file(p),
        other => other,
    }
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
