// Liest installierte Mods (Data/ + Mods/) und deren About.xml ein.
use crate::util::{js_string, truthy};
use crate::xml::{self, js_trim};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

pub const OFFICIAL_ORDER: [&str; 6] = [
    "ludeon.rimworld",
    "ludeon.rimworld.royalty",
    "ludeon.rimworld.ideology",
    "ludeon.rimworld.biotech",
    "ludeon.rimworld.anomaly",
    "ludeon.rimworld.odyssey",
];
const OFFICIAL_NAMES: [&str; 6] = ["Core", "Royalty", "Ideology", "Biotech", "Anomaly", "Odyssey"];

fn official_name(package_id: &str) -> Option<&'static str> {
    OFFICIAL_ORDER.iter().position(|id| *id == package_id).map(|i| OFFICIAL_NAMES[i])
}

// Workshop-IDs verbreiteter Bibliotheken, falls ein Mod in der About.xml keinen steamWorkshopUrl angibt.
fn known_workshop_id(package_id: &str) -> Option<&'static str> {
    match package_id {
        "brrainz.harmony" => Some("2009463077"),
        "unlimitedhugs.hugslib" => Some("818773962"),
        "oskarpotocki.vanillafactionsexpanded.core" => Some("2023507013"),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub package_id: String,
    pub display_name: String,
    pub workshop_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mod {
    pub key: String,
    pub package_id: String,
    pub name: String,
    pub author: String,
    pub description: String,
    pub supported_versions: Vec<String>,
    pub dependencies: Vec<Dependency>,
    pub load_before: Vec<String>,
    pub load_after: Vec<String>,
    pub incompatible_with: Vec<String>,
    pub url: String,
    pub mod_version: String,
    pub preview: String,
    pub path: String,
    pub folder: String,
    pub source: String, // 'official' | 'local'
    pub official: bool,
    pub workshop_id: String,
    pub mtime: f64,
    pub parse_error: String,
}

fn list(node: Option<&Value>) -> Vec<Value> {
    match node {
        None => vec![],
        Some(v) if !truthy(v) => vec![],
        Some(Value::Array(a)) => a.clone(),
        Some(Value::Object(o)) => match o.get("li") {
            Some(Value::Array(a)) if truthy(&o["li"]) => a.clone(),
            Some(li) if truthy(li) => vec![li.clone()],
            _ => vec![],
        },
        Some(Value::String(s)) => vec![Value::String(s.clone())],
        _ => vec![],
    }
}

fn strings(node: Option<&Value>) -> Vec<String> {
    list(node)
        .iter()
        .map(|v| match v {
            Value::String(s) => s.clone(),
            other => other.get("#text").map(js_string).unwrap_or_default(),
        })
        .filter(|s| !s.is_empty())
        .collect()
}

fn lower(arr: Vec<String>) -> Vec<String> {
    arr.into_iter().map(|s| s.to_lowercase()).collect()
}

fn workshop_id_from_url(url: &str) -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d{6,})").unwrap());
    RE.captures(url).map(|c| c[1].to_string()).unwrap_or_default()
}

fn by_version<'a>(meta: &'a Value, key: &str, version: &str) -> Option<&'a Value> {
    meta.get(format!("{key}ByVersion")).and_then(|v| v.get(format!("v{version}"))).filter(|v| truthy(v))
}

fn parse_dependencies(meta: &Value, version: &str) -> Vec<Dependency> {
    let mut deps = list(meta.get("modDependencies"));
    if let Some(v) = by_version(meta, "modDependencies", version) {
        deps.extend(list(Some(v)));
    }
    let mut seen = std::collections::HashSet::new();
    deps.iter()
        .filter(|d| d.is_object() && d.get("packageId").is_some_and(truthy))
        .map(|d| {
            let package_id = js_string(&d["packageId"]).to_lowercase();
            let display = d.get("displayName").filter(|v| truthy(v)).unwrap_or(&d["packageId"]);
            let workshop_id = Some(workshop_id_from_url(&js_string(d.get("steamWorkshopUrl").unwrap_or(&Value::Null))))
                .filter(|s| !s.is_empty())
                .or_else(|| known_workshop_id(&package_id).map(str::to_string))
                .unwrap_or_default();
            Dependency { display_name: js_string(display), workshop_id, package_id }
        })
        .filter(|d| seen.insert(d.package_id.clone()))
        .collect()
}

fn with_version(meta: &Value, key: &str, version: &str) -> Vec<String> {
    let mut out = strings(meta.get(key));
    if let Some(v) = by_version(meta, key, version) {
        out.extend(strings(Some(v)));
    }
    lower(out)
}

fn read_text(file: &Path) -> String {
    fs::read_to_string(file)
        .map(|s| js_trim(s.trim_start_matches('\u{feff}')).to_string())
        .unwrap_or_default()
}

fn find_preview(about_dir: &Path) -> String {
    for name in ["Preview.png", "preview.png", "Preview.jpg", "preview.jpg", "Preview.PNG"] {
        let p = about_dir.join(name);
        if p.exists() {
            return p.to_string_lossy().into_owned();
        }
    }
    String::new()
}

fn mtime_ms(p: &Path) -> Option<f64> {
    let t = fs::metadata(p).ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    // Gleiche Rechnung wie Node (mtimeMs = s * 1e3 + ns / 1e6).
    Some(t.as_secs() as f64 * 1e3 + t.subsec_nanos() as f64 / 1e6)
}

fn meta_str(meta: &Value, key: &str) -> Option<String> {
    meta.get(key).filter(|v| truthy(v)).map(js_string)
}

pub fn parse_mod(dir: &Path, source: &str, version: &str) -> Option<Mod> {
    let about_dir = if dir.join("About").exists() { dir.join("About") } else { dir.join("about") };
    let about_file = ["About.xml", "about.xml"].iter().map(|f| about_dir.join(f)).find(|f| f.exists())?;

    let mut meta = Value::Object(Default::default());
    let mut parse_error = String::new();
    match xml::parse(&read_text(&about_file)) {
        Ok(doc) => {
            if let Some(m) = doc.get("ModMetaData").filter(|v| truthy(v)) {
                meta = m.clone();
            }
        }
        Err(e) => parse_error = e,
    }

    let folder = dir.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
    let package_id = meta_str(&meta, "packageId").unwrap_or_else(|| format!("unknown.{folder}")).to_lowercase();
    let is_id = |s: &str, min: usize| s.len() >= min && s.bytes().all(|b| b.is_ascii_digit());
    let mut workshop_id = read_text(&about_dir.join("PublishedFileId.txt"));
    if workshop_id.is_empty() && is_id(&folder, 6) {
        workshop_id = folder.clone();
    }
    let authors = strings(meta.get("authors"));
    let mtime = match (mtime_ms(dir), mtime_ms(&about_file)) {
        (Some(a), Some(b)) => a.max(b),
        _ => 0.0,
    };

    Some(Mod {
        key: format!("{source}:{folder}"),
        name: meta_str(&meta, "name")
            .or_else(|| official_name(&package_id).map(str::to_string))
            .unwrap_or_else(|| folder.clone()),
        author: if authors.is_empty() { meta_str(&meta, "author").unwrap_or_default() } else { authors.join(", ") },
        description: meta_str(&meta, "description").unwrap_or_default(),
        supported_versions: strings(meta.get("supportedVersions")),
        dependencies: parse_dependencies(&meta, version),
        load_before: [with_version(&meta, "loadBefore", version), lower(strings(meta.get("forceLoadBefore")))].concat(),
        load_after: [with_version(&meta, "loadAfter", version), lower(strings(meta.get("forceLoadAfter")))].concat(),
        incompatible_with: with_version(&meta, "incompatibleWith", version),
        url: meta_str(&meta, "url").unwrap_or_default(),
        mod_version: meta_str(&meta, "modVersion").unwrap_or_default(),
        preview: find_preview(&about_dir),
        path: dir.to_string_lossy().into_owned(),
        source: source.to_string(),
        official: source == "official",
        workshop_id: if is_id(&workshop_id, 1) { workshop_id } else { String::new() },
        package_id,
        folder,
        mtime,
        parse_error,
    })
}

fn scan_dir(dir: &Path, source: &str, version: &str) -> Vec<Mod> {
    let Ok(entries) = fs::read_dir(dir) else { return vec![] };
    entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| parse_mod(&e.path(), source, version))
        .collect()
}

/// Näherung an `localeCompare` (die exakte Reihenfolge für die Anzeige stellt bridge.js her).
fn collate_key(s: &str) -> String {
    s.to_lowercase()
}

pub fn scan_all(game_dir: &str, mods_dir: &str, version: &str) -> Vec<Mod> {
    let mut official = if game_dir.is_empty() { vec![] } else { scan_dir(&Path::new(game_dir).join("Data"), "official", version) };
    let rank = |id: &str| OFFICIAL_ORDER.iter().position(|x| *x == id).map_or(-1, |i| i as i64);
    official.sort_by_key(|m| rank(&m.package_id));
    let mut local = if mods_dir.is_empty() { vec![] } else { scan_dir(Path::new(mods_dir), "local", version) };
    local.sort_by(|a, b| collate_key(&a.name).cmp(&collate_key(&b.name)));
    official.extend(local);
    official
}

// Rich-Text-Tags von Unity (<color>, <b> …) für die Anzeige entfernen.
pub fn plain_description(text: &str) -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)</?(color|b|i|size|u)[^>]*>").unwrap());
    RE.replace_all(text, "").replace("\\n", "\n")
}
