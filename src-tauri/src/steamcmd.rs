// SteamCMD (offizielles Kommandozeilen-Tool von Valve) einrichten und Workshop-Items anonym herunterladen.
use crate::store::user_data;
use crate::util::{t, tp, AppError, Res};
use crate::workshop::APPID;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

const ZIP_URL: &str = "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn base_dir() -> PathBuf {
    user_data().join("steamcmd")
}
fn exe_path() -> PathBuf {
    base_dir().join("steamcmd.exe")
}
fn content_dir() -> PathBuf {
    base_dir().join("content")
}
fn workshop_dir(kind: &str, id: &str) -> PathBuf {
    content_dir().join("steamapps").join("workshop").join(kind).join(APPID.to_string()).join(id)
}
pub fn item_dir(id: &str) -> PathBuf {
    workshop_dir("content", id)
}
fn download_dir(id: &str) -> PathBuf {
    workshop_dir("downloads", id)
}

pub fn is_ready() -> bool {
    exe_path().exists() && base_dir().join("steamerrorreporter.exe").exists()
}

type Shared = Arc<Mutex<Option<Child>>>;
static CURRENT: LazyLock<Mutex<Option<Shared>>> = LazyLock::new(Default::default);

/// Startet SteamCMD und liefert jede Ausgabezeile (stdout und stderr, getrennt an \r, \n oder \r\n).
async fn run(args: &[String], mut on_line: impl FnMut(&str)) -> i32 {
    let spawned = Command::new(exe_path())
        .args(args)
        .current_dir(base_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    let Ok(mut child) = spawned else { return -1 };

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    macro_rules! pipe {
        ($stream:expr) => {
            if let Some(mut s) = $stream {
                let tx = tx.clone();
                tokio::spawn(async move {
                    let mut chunk = [0u8; 8192];
                    while let Ok(n) = s.read(&mut chunk).await {
                        if n == 0 || tx.send(chunk[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                });
            }
        };
    }
    pipe!(child.stdout.take());
    pipe!(child.stderr.take());
    drop(tx);

    let shared: Shared = Arc::new(Mutex::new(Some(child)));
    *CURRENT.lock().unwrap() = Some(shared.clone());

    let mut buffer: Vec<u8> = Vec::new();
    let emit = |bytes: &[u8], on_line: &mut dyn FnMut(&str)| {
        let line = String::from_utf8_lossy(bytes);
        let line = line.trim();
        if !line.is_empty() {
            on_line(line);
        }
    };
    while let Some(chunk) = rx.recv().await {
        buffer.extend_from_slice(&chunk);
        let mut start = 0;
        let mut i = 0;
        while i < buffer.len() {
            match buffer[i] {
                b'\n' => {
                    emit(&buffer[start..i], &mut on_line);
                    start = i + 1;
                }
                b'\r' => {
                    emit(&buffer[start..i], &mut on_line);
                    if buffer.get(i + 1) == Some(&b'\n') {
                        i += 1;
                    }
                    start = i + 1;
                }
                _ => {}
            }
            i += 1;
        }
        buffer.drain(..start);
    }
    emit(&buffer, &mut on_line);

    let child = shared.lock().unwrap().take();
    match child {
        Some(mut c) => c.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1),
        None => -1,
    }
}

async fn exec(file: &str, args: &[&str]) -> Res<()> {
    let out = Command::new(file).args(args).creation_flags(CREATE_NO_WINDOW).output().await?;
    if out.status.success() {
        Ok(())
    } else {
        Err(AppError::msg(format!("Command failed: {file}")))
    }
}

// Windows-eigenes tar (bsdtar) verwenden – ein tar aus Git/MSYS im PATH versteht "C:\…" nicht. Fallback: PowerShell.
async fn extract_zip(zip: &str, dest: &str) -> Res<()> {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let system_tar = PathBuf::from(root).join("System32").join("tar.exe");
    if exec(&system_tar.to_string_lossy(), &["-xf", zip, "-C", dest]).await.is_err() {
        let ps = format!(
            "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
            zip.replace('\'', "''"),
            dest.replace('\'', "''")
        );
        exec("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", &ps]).await?;
    }
    Ok(())
}

// Lädt SteamCMD herunter und lässt es sich beim ersten Start selbst aktualisieren.
pub async fn ensure(on_status: &(dyn Fn(Value) + Send + Sync)) -> Res<bool> {
    if is_ready() {
        return Ok(true);
    }
    fs::create_dir_all(base_dir())?;
    if !exe_path().exists() {
        on_status(t("status.steamcmdDownloading"));
        let client = reqwest::Client::builder().timeout(Duration::from_secs(60)).build()?;
        let res = client.get(ZIP_URL).send().await?;
        if !res.status().is_success() {
            return Err(AppError::trp("err.steamcmdDownload", json!({ "status": res.status().as_u16() })));
        }
        let zip = base_dir().join("steamcmd.zip");
        fs::write(&zip, res.bytes().await?)?;
        extract_zip(&zip.to_string_lossy(), &base_dir().to_string_lossy()).await?;
        let _ = fs::remove_file(&zip);
    }
    on_status(t("status.steamcmdSetup"));
    static PCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[\s*(\d+)%\]\s*(.*)").unwrap());
    run(&["+quit".to_string()], |line| {
        if let Some(m) = PCT.captures(line) {
            on_status(tp("status.steamcmdSetupPct", json!({ "pct": &m[1] })));
        }
    })
    .await;
    if !is_ready() {
        return Err(AppError::tr("err.steamcmdSetup"));
    }
    on_status(json!(""));
    Ok(true)
}

#[derive(Debug, Clone)]
pub enum Event {
    Start(String),
    Success(String, String),
    Error(String, String),
}

impl Event {
    pub fn id(&self) -> &str {
        match self {
            Event::Start(id) | Event::Success(id, _) | Event::Error(id, _) => id,
        }
    }
}

// Alle Ereignisse einer Ausgabezeile in der Reihenfolge ihres Auftretens.
pub fn parse_line(line: &str) -> Vec<Event> {
    static START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Downloading item (\d+)").unwrap());
    static SUCCESS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"Success\. Downloaded item (\d+) to "([^"]+)""#).unwrap());
    static ERROR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"ERROR! Download item (\d+) failed \(([^)]*)\)").unwrap());
    let mut events: Vec<(usize, Event)> = Vec::new();
    for m in START.captures_iter(line) {
        events.push((m.get(0).unwrap().start(), Event::Start(m[1].into())));
    }
    for m in SUCCESS.captures_iter(line) {
        events.push((m.get(0).unwrap().start(), Event::Success(m[1].into(), m[2].into())));
    }
    for m in ERROR.captures_iter(line) {
        events.push((m.get(0).unwrap().start(), Event::Error(m[1].into(), m[2].into())));
    }
    events.sort_by_key(|(i, _)| *i);
    events.into_iter().map(|(_, e)| e).collect()
}

// Lädt mehrere Items in einer SteamCMD-Sitzung.
pub async fn download_items(ids: &[String], mut on_event: impl FnMut(Event)) {
    // Den Workshop-Status von SteamCMD verwerfen, damit Updates immer frisch geladen werden.
    let _ = fs::remove_file(content_dir().join("steamapps").join("workshop").join(format!("appworkshop_{APPID}.acf")));
    let mut args: Vec<String> = vec!["+force_install_dir".into(), content_dir().to_string_lossy().into_owned(), "+login".into(), "anonymous".into()];
    for id in ids {
        args.extend(["+workshop_download_item".into(), APPID.to_string(), id.clone()]);
    }
    args.push("+quit".into());

    let mut pending: Vec<String> = crate::util::unique(ids.iter().cloned());
    let mut seen_done = HashSet::new();
    run(&args, |line| {
        // SteamCMD schreibt oft mehrere Meldungen in eine Zeile, z. B.
        // 'Success. Downloaded item A to "…" (123 bytes) Downloading item B ...' – daher alle der Reihe nach auswerten.
        for ev in parse_line(line) {
            if !matches!(ev, Event::Start(_)) {
                seen_done.insert(ev.id().to_string());
            }
            on_event(ev);
        }
    })
    .await;
    // Items ohne Rückmeldung (z. B. Abbruch) als Fehler melden.
    pending.retain(|id| !seen_done.contains(id));
    for id in pending {
        on_event(Event::Error(id, "NoResponse".into()));
    }
}

pub fn cancel() {
    if let Some(shared) = CURRENT.lock().unwrap().as_ref() {
        if let Some(child) = shared.lock().unwrap().as_mut() {
            let _ = child.start_kill();
        }
    }
}

fn dir_size(dir: &std::path::Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|e| {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                dir_size(&e.path())
            } else {
                fs::metadata(e.path()).map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

// Ungefährer Download-Fortschritt in Bytes (Steam lädt erst nach downloads/, dann nach content/).
pub fn downloaded_bytes(id: &str) -> u64 {
    dir_size(&download_dir(id)).max(dir_size(&item_dir(id)))
}

pub fn clear_cache() -> Res<()> {
    match fs::remove_dir_all(content_dir().join("steamapps")) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

// SteamCMD lässt nach Selbst-Updates die Vorversionen als *.old und *.delete liegen.
pub fn remove_update_leftovers() {
    let Ok(entries) = fs::read_dir(base_dir()) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if (name.ends_with(".old") || name.ends_with(".delete")) && entry.path().is_file() {
            let _ = fs::remove_file(entry.path());
        }
    }
}
