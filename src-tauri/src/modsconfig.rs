// ModsConfig.xml lesen/schreiben, Ladereihenfolge sortieren und Probleme erkennen.
use crate::mods::{Mod, OFFICIAL_ORDER};
use regex::{NoExpand, Regex};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub const CORE: &str = "ludeon.rimworld";

fn config_file(config_dir: &str) -> PathBuf {
    Path::new(config_dir).join("ModsConfig.xml")
}

pub struct Config {
    pub exists: bool,
    pub active: Vec<String>,
}

pub fn read_config(config_dir: &str) -> Config {
    let file = config_file(config_dir);
    let Ok(xml) = fs::read_to_string(&file) else {
        return Config { exists: false, active: vec![CORE.into()] };
    };
    let block = |tag: &str| -> Vec<String> {
        let re = Regex::new(&format!(r"<{tag}>([\s\S]*?)</{tag}>")).unwrap();
        let Some(m) = re.captures(&xml) else { return vec![] };
        let li = Regex::new(r"<li>\s*([^<]+?)\s*</li>").unwrap();
        li.captures_iter(&m[1]).map(|x| x[1].to_lowercase()).collect()
    };
    Config { exists: true, active: block("activeMods") }
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn write_config(config_dir: &str, active: &[String], game_version_full: &str, installed_official: &[String]) -> std::io::Result<()> {
    let file = config_file(config_dir);
    fs::create_dir_all(config_dir)?;
    let items = active.iter().map(|id| format!("    <li>{}</li>", escape_xml(id))).collect::<Vec<_>>().join("\n");
    let active_block = format!("<activeMods>\n{items}\n  </activeMods>");

    let xml = if file.exists() {
        let xml = fs::read_to_string(&file)?;
        let mut bak = file.clone().into_os_string();
        bak.push(".bak");
        fs::copy(&file, bak)?;
        let re = Regex::new(r"<activeMods>[\s\S]*?</activeMods>").unwrap();
        if re.is_match(&xml) {
            re.replace(&xml, NoExpand(&active_block)).into_owned()
        } else {
            xml.replacen("</ModsConfigData>", &format!("  {active_block}\n</ModsConfigData>"), 1)
        }
    } else {
        let known = installed_official
            .iter()
            .filter(|id| *id != CORE)
            .map(|id| format!("    <li>{id}</li>"))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<ModsConfigData>\n  <version>{}</version>\n  {active_block}\n  <knownExpansions>\n{known}\n  </knownExpansions>\n</ModsConfigData>\n",
            escape_xml(game_version_full)
        )
    };
    fs::write(file, xml)
}

// Topologische Sortierung: Constraints aus About.xml haben Vorrang, sonst bleibt die bisherige Reihenfolge.
// Grobe Stufen: Mods, die vor Core laden wollen (Harmony), -> Core/DLCs -> Bibliotheken -> Rest.
pub fn auto_sort(active_ids: &[String], mods_by_package: &HashMap<String, &Mod>) -> Vec<String> {
    let ids = crate::util::unique(active_ids.iter().cloned());
    let present: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut edges: HashMap<String, HashSet<String>> = ids.iter().map(|id| (id.clone(), HashSet::new())).collect(); // a -> b: a lädt vor b
    let mut add_edge = |a: &str, b: &str| {
        if a != b && present.contains(a) && present.contains(b) {
            edges.get_mut(a).unwrap().insert(b.to_string());
        }
    };

    let mut depended_on = HashSet::new();
    for id in &ids {
        let Some(m) = mods_by_package.get(id) else { continue };
        m.load_before.iter().for_each(|other| add_edge(id, other));
        m.load_after.iter().for_each(|other| add_edge(other, id));
        for d in &m.dependencies {
            add_edge(&d.package_id, id);
            depended_on.insert(d.package_id.clone());
        }
    }
    // Offizielle Inhalte untereinander in fester Reihenfolge.
    let officials: Vec<&str> = OFFICIAL_ORDER.iter().copied().filter(|id| present.contains(id)).collect();
    for i in 1..officials.len() {
        add_edge(officials[i - 1], officials[i]);
    }

    let tier = |id: &str| -> i64 {
        let m = mods_by_package.get(id);
        if OFFICIAL_ORDER.contains(&id) {
            1
        } else if m.is_some_and(|m| m.load_before.iter().any(|x| x == CORE)) {
            0
        } else if depended_on.contains(id) {
            2
        } else {
            3
        }
    };
    // Normale Mods laden nach den offiziellen Inhalten, außer sie verlangen ausdrücklich etwas anderes.
    for id in &ids {
        if tier(id) >= 2 {
            let m = mods_by_package.get(id);
            for off in &officials {
                if m.map_or(true, |m| !m.load_before.iter().any(|x| x == off)) {
                    add_edge(off, id);
                }
            }
        }
    }

    let mut indeg: HashMap<&str, i64> = ids.iter().map(|id| (id.as_str(), 0)).collect();
    for targets in edges.values() {
        for t in targets {
            *indeg.get_mut(t.as_str()).unwrap() += 1;
        }
    }
    let order: HashMap<&str, i64> = ids.iter().enumerate().map(|(i, id)| (id.as_str(), i as i64)).collect();
    let rank = |id: &str| tier(id) * 100000 + order[id];

    let mut result: Vec<String> = Vec::new();
    let mut ready: Vec<String> = ids.iter().filter(|id| indeg[id.as_str()] == 0).cloned().collect();
    let mut done: HashSet<String> = HashSet::new();
    while result.len() < ids.len() {
        if ready.is_empty() {
            // Zyklus: den am besten passenden verbleibenden Mod nehmen und weitermachen.
            let best = ids.iter().filter(|id| !done.contains(*id)).min_by_key(|id| rank(id)).unwrap();
            ready.push(best.clone());
        }
        ready.sort_by_key(|id| rank(id));
        let next = ready.remove(0);
        if done.contains(&next) {
            continue;
        }
        done.insert(next.clone());
        for t in &edges[&next] {
            let d = indeg.get_mut(t.as_str()).unwrap();
            *d -= 1;
            if *d == 0 && !done.contains(t) {
                ready.push(t.clone());
            }
        }
        result.push(next);
    }
    result
}

pub fn version_supported(m: &Mod, short_version: &str) -> bool {
    if m.official || short_version.is_empty() || m.supported_versions.is_empty() {
        return true;
    }
    m.supported_versions.iter().any(|v| v.trim() == short_version)
}

// Liefert Hinweise pro packageId: { level: 'error'|'warning', code, params, fix? }.
// Die Oberfläche übersetzt code/params (Schlüssel 'issue.<code>' in shared/i18n.js).
pub fn analyze(active_ids: &[String], mods: &[Mod], short_version: &str) -> Value {
    let mut by_package: HashMap<&str, &Mod> = HashMap::new();
    let mut duplicates = HashSet::new();
    for m in mods {
        if by_package.contains_key(m.package_id.as_str()) {
            duplicates.insert(m.package_id.as_str());
        } else {
            by_package.insert(&m.package_id, m);
        }
    }
    let mut pos: HashMap<&str, usize> = HashMap::new();
    for (i, id) in active_ids.iter().enumerate() {
        pos.insert(id, i); // wie new Map(): spätere Einträge gewinnen
    }
    let mut issues = Map::new();
    let mut add = |id: &str, level: &str, code: &str, params: Value, fix: Option<Value>| {
        let mut issue = json!({ "level": level, "code": code, "params": params });
        if let Some(fix) = fix {
            issue["fix"] = fix;
        }
        issues.entry(id.to_string()).or_insert_with(|| json!([])).as_array_mut().unwrap().push(issue);
    };
    let name_of = |other: &str| by_package.get(other).map_or(other.to_string(), |m| m.name.clone());

    for id in active_ids {
        let Some(m) = by_package.get(id.as_str()) else {
            add(id, "error", "notInstalledActive", json!({}), None);
            continue;
        };
        if duplicates.contains(id.as_str()) {
            add(id, "warning", "duplicate", json!({}), None);
        }
        if !version_supported(m, short_version) {
            add(id, "warning", "version", json!({ "versions": m.supported_versions.join(", ") }), None);
        }
        for dep in &m.dependencies {
            match pos.get(dep.package_id.as_str()) {
                None => {
                    let installed = by_package.contains_key(dep.package_id.as_str());
                    let (code, fix) = if installed {
                        ("depInactive", json!({ "type": "activate", "packageId": dep.package_id }))
                    } else {
                        ("depMissing", json!({ "type": "install", "workshopId": dep.workshop_id, "name": dep.display_name }))
                    };
                    add(id, "error", code, json!({ "name": dep.display_name }), Some(fix));
                }
                Some(p) if *p > pos[id.as_str()] => {
                    add(id, "error", "depOrder", json!({ "name": dep.display_name }), Some(json!({ "type": "sort" })));
                }
                _ => {}
            }
        }
        let dep_ids: HashSet<&str> = m.dependencies.iter().map(|d| d.package_id.as_str()).collect();
        for other in &m.load_after {
            // Bereits als Abhängigkeit gemeldet ("Muss nach … geladen werden").
            if dep_ids.contains(other.as_str()) {
                continue;
            }
            if pos.get(other.as_str()).is_some_and(|p| *p > pos[id.as_str()]) {
                add(id, "warning", "loadAfter", json!({ "name": name_of(other) }), Some(json!({ "type": "sort" })));
            }
        }
        for other in &m.load_before {
            if pos.get(other.as_str()).is_some_and(|p| *p < pos[id.as_str()]) {
                add(id, "warning", "loadBefore", json!({ "name": name_of(other) }), Some(json!({ "type": "sort" })));
            }
        }
        for other in &m.incompatible_with {
            if pos.contains_key(other.as_str()) {
                add(id, "error", "incompatible", json!({ "name": name_of(other) }), None);
            }
        }
    }
    Value::Object(issues)
}
