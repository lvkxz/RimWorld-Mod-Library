// Mod-Listen im Format von RimWorld (ModLists/*.rml, auch im Mod-Menü des Spiels): lesen, schreiben, als Code
// teilen und mit den installierten Mods abgleichen.
use crate::mods::{self, Mod};
use crate::xml;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const EXT: &str = "rml";
const CODE_PREFIX: &str = "RWML1";
// packageId ist erst nach dem Download bekannt (About.xml): bis dahin steht "workshop.<ID>" in der Liste.
const PLACEHOLDER: &str = "workshop.";

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub package_id: String,
    pub workshop_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModList {
    pub name: String,
    pub path: String,
    pub modified: f64,
    pub mods: Vec<Entry>,
}

/// Ordner neben Config, in dem auch RimWorld seine Mod-Listen speichert.
pub fn dir(config_dir: &str) -> PathBuf {
    Path::new(config_dir).parent().unwrap_or(Path::new(config_dir)).join("ModLists")
}

fn file(config_dir: &str, name: &str) -> PathBuf {
    dir(config_dir).join(format!("{name}.{EXT}"))
}

/// Name als Dateiname: nicht leer, ohne in Windows verbotene Zeichen.
pub fn valid_name(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty() && name.len() <= 80 && !name.chars().any(|c| "<>:\"/\\|?*".contains(c) || c.is_control()) && !name.ends_with('.')
}

pub fn exists(config_dir: &str, name: &str) -> bool {
    file(config_dir, name).exists()
}

/// Freier Name: "Name", sonst "Name (2)", "Name (3)" …
pub fn unique_name(config_dir: &str, name: &str) -> String {
    let base = if valid_name(name) { name.trim().to_string() } else { "Mod list".to_string() };
    (1..)
        .map(|i| if i == 1 { base.clone() } else { format!("{base} ({i})") })
        .find(|n| !exists(config_dir, n))
        .unwrap()
}

fn modified_ms(p: &Path) -> f64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_millis() as f64)
}

pub fn all(config_dir: &str) -> Vec<ModList> {
    let Ok(entries) = fs::read_dir(dir(config_dir)) else { return vec![] };
    let mut lists: Vec<ModList> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case(EXT)))
        .filter_map(|p| {
            let mods = parse(&fs::read_to_string(&p).ok()?)?;
            Some(ModList {
                name: p.file_stem()?.to_string_lossy().into_owned(),
                path: p.to_string_lossy().into_owned(),
                modified: modified_ms(&p),
                mods,
            })
        })
        .collect();
    lists.sort_by_key(|l| l.name.to_lowercase());
    lists
}

pub fn get(config_dir: &str, name: &str) -> Option<ModList> {
    all(config_dir).into_iter().find(|l| l.name == name)
}

/// Liest eine .rml-Datei. Workshop-IDs stehen nur im meta-Kopf (der beim Speichern im Spiel die gerade geladenen
/// Mods enthält) und werden über die packageId zugeordnet.
pub fn parse(text: &str) -> Option<Vec<Entry>> {
    let doc = xml::parse(text).ok()?;
    let root = doc.get("savedModList")?;
    let list = root.get("modList")?;
    let ids = mods::strings(list.get("ids"));
    let names = mods::strings(list.get("names"));
    let meta = root.get("meta").cloned().unwrap_or(Value::Null);
    let meta_ids = mods::strings(meta.get("modIds"));
    let meta_steam = mods::strings(meta.get("modSteamIds"));
    Some(
        ids.iter()
            .enumerate()
            .map(|(i, id)| {
                let name = names.get(i).cloned().unwrap_or_default();
                if let Some(ws) = id.strip_prefix(PLACEHOLDER).filter(|ws| is_workshop_id(ws)) {
                    return Entry { package_id: String::new(), workshop_id: ws.to_string(), name };
                }
                let package_id = id.to_lowercase();
                let workshop_id = meta_ids
                    .iter()
                    .position(|m| m.to_lowercase() == package_id)
                    .and_then(|p| meta_steam.get(p))
                    .filter(|s| is_workshop_id(s))
                    .cloned()
                    .unwrap_or_default();
                Entry { package_id, workshop_id, name }
            })
            .collect(),
    )
}

fn is_workshop_id(s: &str) -> bool {
    s.len() >= 6 && s.bytes().all(|b| b.is_ascii_digit())
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Schreibt im Aufbau, den RimWorld selbst erzeugt (Einrückung mit Tabs, leere Listen als <x />).
pub fn render(entries: &[Entry], game_version: &str) -> String {
    let block = |tag: &str, indent: &str, values: Vec<String>| {
        if values.is_empty() {
            return format!("{indent}<{tag} />\n");
        }
        let items: String = values.iter().map(|v| format!("{indent}\t<li>{}</li>\n", escape(v))).collect();
        format!("{indent}<{tag}>\n{items}{indent}</{tag}>\n")
    };
    let id = |e: &Entry| if e.package_id.is_empty() { format!("{PLACEHOLDER}{}", e.workshop_id) } else { e.package_id.clone() };
    let ids = || entries.iter().map(id).collect::<Vec<_>>();
    let names = || entries.iter().map(|e| if e.name.is_empty() { id(e) } else { e.name.clone() }).collect::<Vec<_>>();
    let steam = entries.iter().map(|e| if e.workshop_id.is_empty() { "0".to_string() } else { e.workshop_id.clone() }).collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<savedModList>\n\t<meta>\n\t\t<gameVersion>{}</gameVersion>\n{}{}{}\t</meta>\n\t<modList>\n{}{}\t</modList>\n</savedModList>",
        escape(game_version),
        block("modIds", "\t\t", ids()),
        block("modSteamIds", "\t\t", steam),
        block("modNames", "\t\t", names()),
        block("ids", "\t\t", ids()),
        block("names", "\t\t", names()),
    )
}

pub fn write(config_dir: &str, name: &str, entries: &[Entry], game_version: &str) -> std::io::Result<()> {
    fs::create_dir_all(dir(config_dir))?;
    fs::write(file(config_dir, name), render(entries, game_version))
}

pub fn rename(config_dir: &str, name: &str, new_name: &str) -> std::io::Result<()> {
    fs::rename(file(config_dir, name), file(config_dir, new_name))
}

pub fn delete(config_dir: &str, name: &str) -> Result<(), String> {
    trash::delete(file(config_dir, name)).map_err(|e| e.to_string()) // in den Papierkorb – wiederherstellbar
}

/// Neueste Änderung im Listen-Ordner (Dateien und Ordner selbst, damit auch Löschen zählt).
pub fn last_change(config_dir: &str) -> Option<SystemTime> {
    let folder = dir(config_dir);
    let own = fs::metadata(&folder).and_then(|m| m.modified()).ok();
    let files = fs::read_dir(&folder).ok()?.flatten().filter_map(|e| e.metadata().and_then(|m| m.modified()).ok());
    files.chain(own).max()
}

/// Kurzer Text zum Teilen, z. B. im Chat: "RWML1;Name;2009463077,ludeon.rimworld,…".
/// Workshop-Mods stehen als Workshop-ID, alles andere (Core, DLCs, lokale Mods) als packageId.
pub fn encode(name: &str, entries: &[Entry]) -> String {
    let items: Vec<&str> = entries
        .iter()
        .map(|e| if e.workshop_id.is_empty() { e.package_id.as_str() } else { e.workshop_id.as_str() })
        .collect();
    format!("{CODE_PREFIX};{};{}", encode_name(name), items.join(","))
}

pub fn decode(code: &str) -> Option<(String, Vec<Entry>)> {
    let code: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    let mut parts = code.splitn(3, ';');
    if parts.next()? != CODE_PREFIX {
        return None;
    }
    let name = decode_name(parts.next()?);
    let entries: Vec<Entry> = parts
        .next()?
        .split(',')
        .filter(|s| !s.is_empty())
        .map(|item| {
            if is_workshop_id(item) {
                Entry { workshop_id: item.to_string(), ..Default::default() }
            } else {
                Entry { package_id: item.to_lowercase(), ..Default::default() }
            }
        })
        .collect();
    (!entries.is_empty()).then_some((name, entries))
}

// Name im Code: ';', ',' und '%' prozentkodiert, damit der Code eindeutig trennbar bleibt.
fn encode_name(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '%' | ';' | ',' => format!("%{:02X}", c as u32),
            c if c.is_whitespace() => "%20".to_string(),
            c => c.to_string(),
        })
        .collect()
}

fn decode_name(s: &str) -> String {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
        if let (b'%', Some(b)) = (bytes[i], hex) {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Eintrag für einen installierten Mod.
pub fn entry_for(m: &Mod) -> Entry {
    Entry { package_id: m.package_id.clone(), workshop_id: m.workshop_id.clone(), name: m.name.clone() }
}

/// Ersetzt Platzhalter durch die inzwischen installierten Mods; true, wenn sich etwas geändert hat.
pub fn resolve_placeholders(entries: &mut [Entry], mods: &[Mod]) -> bool {
    let mut changed = false;
    for e in entries.iter_mut().filter(|e| e.package_id.is_empty()) {
        if let Some(m) = find(e, mods) {
            *e = entry_for(m);
            changed = true;
        }
    }
    changed
}

/// Ergänzt fehlende Pflicht-Abhängigkeiten (nur installierte, rekursiv) jeweils direkt vor dem ersten Mod, der sie
/// braucht; die übrige Reihenfolge bleibt. Liefert die neue Reihenfolge und die ergänzten packageIds.
pub fn with_dependencies(order: &[String], mods: &[Mod]) -> (Vec<String>, Vec<String>) {
    let by_pkg: HashMap<&str, &Mod> = mods.iter().map(|m| (m.package_id.as_str(), m)).collect();
    let listed: HashSet<&str> = order.iter().map(String::as_str).collect();
    let (mut out, mut added) = (Vec::new(), Vec::new());
    for id in order {
        insert_deps(id, &by_pkg, &listed, &mut out, &mut added, 0);
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    (out, added)
}

fn insert_deps(id: &str, by_pkg: &HashMap<&str, &Mod>, listed: &HashSet<&str>, out: &mut Vec<String>, added: &mut Vec<String>, depth: usize) {
    let Some(m) = by_pkg.get(id).filter(|_| depth < 20) else { return };
    for dep in &m.dependencies {
        let d = dep.package_id.as_str();
        if listed.contains(d) || out.iter().any(|x| x == d) || !by_pkg.contains_key(d) {
            continue;
        }
        insert_deps(d, by_pkg, listed, out, added, depth + 1);
        if !out.iter().any(|x| x == d) {
            out.push(d.to_string());
            added.push(d.to_string());
        }
    }
}

/// Passender installierter Mod: über die packageId (RimWorld hängt bei Doppelten "_steam" an), sonst die Workshop-ID.
pub fn find<'a>(entry: &Entry, mods: &'a [Mod]) -> Option<&'a Mod> {
    let pkg = entry.package_id.trim_end_matches("_steam");
    (!pkg.is_empty())
        .then(|| mods.iter().find(|m| m.package_id == pkg))
        .flatten()
        .or_else(|| (!entry.workshop_id.is_empty()).then(|| mods.iter().find(|m| m.workshop_id == entry.workshop_id)).flatten())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pkg: &str, ws: &str, name: &str) -> Entry {
        Entry { package_id: pkg.into(), workshop_id: ws.into(), name: name.into() }
    }

    #[test]
    fn reads_list_saved_by_rimworld() {
        let xml = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<savedModList>\n\t<meta>\n\t\t<gameVersion>1.6.4871 rev573</gameVersion>\n\t\t<modIds>\n\t\t\t<li>ludeon.rimworld</li>\n\t\t\t<li>brrainz.harmony</li>\n\t\t</modIds>\n\t\t<modSteamIds>\n\t\t\t<li>0</li>\n\t\t\t<li>2009463077</li>\n\t\t</modSteamIds>\n\t\t<modNames>\n\t\t\t<li>Core</li>\n\t\t\t<li>Harmony</li>\n\t\t</modNames>\n\t</meta>\n\t<modList>\n\t\t<ids>\n\t\t\t<li>brrainz.harmony</li>\n\t\t\t<li>ludeon.rimworld</li>\n\t\t\t<li>Jaxe.RimHUD</li>\n\t\t</ids>\n\t\t<names>\n\t\t\t<li>Harmony</li>\n\t\t\t<li>Core</li>\n\t\t\t<li>RimHUD</li>\n\t\t</names>\n\t</modList>\n</savedModList>";
        assert_eq!(
            parse(xml).unwrap(),
            vec![entry("brrainz.harmony", "2009463077", "Harmony"), entry("ludeon.rimworld", "", "Core"), entry("jaxe.rimhud", "", "RimHUD")]
        );
    }

    #[test]
    fn writes_and_reads_back() {
        let list = vec![entry("brrainz.harmony", "2009463077", "Harmony"), entry("ludeon.rimworld", "", "Core"), entry("a.b", "", "A & <B>")];
        let xml = render(&list, "1.6.4871 rev573");
        assert!(xml.contains("\t\t\t<li>0</li>\n"));
        assert_eq!(parse(&xml).unwrap(), list);
        assert_eq!(parse(&render(&[], "1.6")).unwrap(), vec![]);
    }

    #[test]
    fn not_installed_workshop_mods_keep_their_id() {
        let list = vec![entry("", "761421485", "Allow Tool"), entry("ludeon.rimworld", "", "Core")];
        let xml = render(&list, "1.6");
        assert!(xml.contains("<li>workshop.761421485</li>"));
        assert_eq!(parse(&xml).unwrap(), list);
    }

    #[test]
    fn code_round_trip() {
        let list = vec![entry("brrainz.harmony", "2009463077", "Harmony"), entry("ludeon.rimworld", "", "Core")];
        let code = encode("Vanilla+; 100% fun, really", &list);
        assert_eq!(code, "RWML1;Vanilla+%3B%20100%25%20fun%2C%20really;2009463077,ludeon.rimworld");
        let (name, entries) = decode(&format!("  {code}\n")).unwrap();
        assert_eq!(name, "Vanilla+; 100% fun, really");
        assert_eq!(entries, vec![entry("", "2009463077", ""), entry("ludeon.rimworld", "", "")]);
        assert!(decode("hello").is_none());
        assert!(decode("RWML1;x;").is_none());
    }

    #[test]
    fn adds_missing_dependencies_before_their_dependent() {
        let m = |pkg: &str, deps: &[&str]| Mod {
            package_id: pkg.into(),
            dependencies: deps.iter().map(|d| mods::Dependency { package_id: d.to_string(), ..Default::default() }).collect(),
            ..Default::default()
        };
        let installed = [
            m("ludeon.rimworld", &[]),
            m("brrainz.harmony", &[]),
            m("unlimitedhugs.hugslib", &["brrainz.harmony"]),
            m("allow.tool", &["unlimitedhugs.hugslib", "not.installed"]),
            m("x.a", &["x.b"]),
            m("x.b", &["x.a"]),
        ];
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // Harmony steht schon in der Liste, HugsLib fehlt, "not.installed" wird ignoriert.
        let (order, added) = with_dependencies(&ids(&["brrainz.harmony", "ludeon.rimworld", "allow.tool"]), &installed);
        assert_eq!(order, ids(&["brrainz.harmony", "ludeon.rimworld", "unlimitedhugs.hugslib", "allow.tool"]));
        assert_eq!(added, ids(&["unlimitedhugs.hugslib"]));
        // Kreis zwischen zwei Mods bricht ab, ohne Doppelte.
        let (order, _) = with_dependencies(&ids(&["x.a"]), &installed);
        assert_eq!(order, ids(&["x.b", "x.a"]));
    }

    #[test]
    fn names() {
        assert!(valid_name("Vanilla+ (Multiplayer)"));
        assert!(!valid_name("  "));
        assert!(!valid_name("a/b"));
        assert!(!valid_name("list."));
    }
}
