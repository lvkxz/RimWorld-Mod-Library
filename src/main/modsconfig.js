// ModsConfig.xml lesen/schreiben, Ladereihenfolge sortieren und Probleme erkennen.
const fs = require('fs');
const path = require('path');
const { OFFICIAL_ORDER } = require('./mods');

const CORE = 'ludeon.rimworld';

function configFile(configDir) {
  return path.join(configDir, 'ModsConfig.xml');
}

function readConfig(configDir) {
  const file = configFile(configDir);
  if (!fs.existsSync(file)) return { exists: false, active: [CORE], knownExpansions: [] };
  const xml = fs.readFileSync(file, 'utf8');
  const block = (tag) => {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    if (!m) return [];
    return [...m[1].matchAll(/<li>\s*([^<]+?)\s*<\/li>/g)].map((x) => x[1].toLowerCase());
  };
  return { exists: true, active: block('activeMods'), knownExpansions: block('knownExpansions') };
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function writeConfig(configDir, active, gameVersionFull, installedOfficial) {
  const file = configFile(configDir);
  fs.mkdirSync(configDir, { recursive: true });
  const items = active.map((id) => `    <li>${escapeXml(id)}</li>`).join('\n');
  const activeBlock = `<activeMods>\n${items}\n  </activeMods>`;

  let xml;
  if (fs.existsSync(file)) {
    xml = fs.readFileSync(file, 'utf8');
    fs.copyFileSync(file, file + '.bak');
    xml = /<activeMods>[\s\S]*?<\/activeMods>/.test(xml)
      ? xml.replace(/<activeMods>[\s\S]*?<\/activeMods>/, activeBlock)
      : xml.replace('</ModsConfigData>', `  ${activeBlock}\n</ModsConfigData>`);
  } else {
    const known = installedOfficial.filter((id) => id !== CORE).map((id) => `    <li>${id}</li>`).join('\n');
    xml = `<?xml version="1.0" encoding="utf-8"?>
<ModsConfigData>
  <version>${escapeXml(gameVersionFull || '')}</version>
  ${activeBlock}
  <knownExpansions>
${known}
  </knownExpansions>
</ModsConfigData>
`;
  }
  fs.writeFileSync(file, xml, 'utf8');
}

// Topologische Sortierung: Constraints aus About.xml haben Vorrang, sonst bleibt die bisherige Reihenfolge.
// Grobe Stufen: Mods, die vor Core laden wollen (Harmony), -> Core/DLCs -> Bibliotheken -> Rest.
function autoSort(activeIds, modsByPackage) {
  const ids = [...new Set(activeIds)];
  const present = new Set(ids);
  const edges = new Map(ids.map((id) => [id, new Set()])); // a -> b: a lädt vor b
  const addEdge = (a, b) => {
    if (a !== b && present.has(a) && present.has(b)) edges.get(a).add(b);
  };

  const dependedOn = new Set();
  for (const id of ids) {
    const mod = modsByPackage.get(id);
    if (!mod) continue;
    mod.loadBefore.forEach((other) => addEdge(id, other));
    mod.loadAfter.forEach((other) => addEdge(other, id));
    mod.dependencies.forEach((d) => {
      addEdge(d.packageId, id);
      dependedOn.add(d.packageId);
    });
  }
  // Offizielle Inhalte untereinander in fester Reihenfolge.
  const officials = OFFICIAL_ORDER.filter((id) => present.has(id));
  for (let i = 1; i < officials.length; i++) addEdge(officials[i - 1], officials[i]);

  const tier = (id) => {
    const mod = modsByPackage.get(id);
    if (OFFICIAL_ORDER.includes(id)) return 1;
    if (mod && mod.loadBefore.includes(CORE)) return 0;
    if (dependedOn.has(id)) return 2;
    return 3;
  };
  // Normale Mods laden nach den offiziellen Inhalten, außer sie verlangen ausdrücklich etwas anderes.
  for (const id of ids) {
    if (tier(id) >= 2) {
      const mod = modsByPackage.get(id);
      officials.forEach((off) => {
        if (!mod || !mod.loadBefore.includes(off)) addEdge(off, id);
      });
    }
  }

  const indeg = new Map(ids.map((id) => [id, 0]));
  edges.forEach((targets) => targets.forEach((t) => indeg.set(t, indeg.get(t) + 1)));
  const order = new Map(ids.map((id, i) => [id, i]));
  const rank = (id) => tier(id) * 100000 + order.get(id);

  const result = [];
  const ready = ids.filter((id) => indeg.get(id) === 0);
  const done = new Set();
  while (result.length < ids.length) {
    if (!ready.length) {
      // Zyklus: den am besten passenden verbleibenden Mod nehmen und weitermachen.
      const rest = ids.filter((id) => !done.has(id)).sort((a, b) => rank(a) - rank(b));
      ready.push(rest[0]);
    }
    ready.sort((a, b) => rank(a) - rank(b));
    const next = ready.shift();
    if (done.has(next)) continue;
    done.add(next);
    result.push(next);
    edges.get(next).forEach((t) => {
      indeg.set(t, indeg.get(t) - 1);
      if (indeg.get(t) === 0 && !done.has(t)) ready.push(t);
    });
  }
  return result;
}

function versionSupported(mod, shortVersion) {
  if (mod.official || !shortVersion || !mod.supportedVersions.length) return true;
  return mod.supportedVersions.some((v) => v.trim() === shortVersion);
}

// Liefert Hinweise pro packageId: { level: 'error'|'warning', text, fix? }.
function analyze(activeIds, mods, shortVersion) {
  const byPackage = new Map();
  const duplicates = new Set();
  for (const m of mods) {
    if (byPackage.has(m.packageId)) duplicates.add(m.packageId);
    else byPackage.set(m.packageId, m);
  }
  const pos = new Map(activeIds.map((id, i) => [id, i]));
  const issues = {};
  const add = (id, level, text, fix) => (issues[id] = issues[id] || []).push({ level, text, fix });

  for (const id of activeIds) {
    const mod = byPackage.get(id);
    if (!mod) {
      add(id, 'error', 'Aktiv, aber nicht installiert');
      continue;
    }
    if (duplicates.has(id)) add(id, 'warning', 'Mehrfach installiert (gleiche packageId)');
    if (!versionSupported(mod, shortVersion)) {
      add(id, 'warning', `Unterstützt offiziell nur ${mod.supportedVersions.join(', ')}`);
    }
    for (const dep of mod.dependencies) {
      if (!pos.has(dep.packageId)) {
        const installed = byPackage.get(dep.packageId);
        add(id, 'error', `Benötigt „${dep.displayName}“ – ${installed ? 'nicht aktiv' : 'nicht installiert'}`,
          installed ? { type: 'activate', packageId: dep.packageId } : { type: 'install', workshopId: dep.workshopId, name: dep.displayName });
      } else if (pos.get(dep.packageId) > pos.get(id)) {
        add(id, 'error', `Muss nach „${dep.displayName}“ geladen werden`, { type: 'sort' });
      }
    }
    const depIds = new Set(mod.dependencies.map((d) => d.packageId));
    for (const other of mod.loadAfter) {
      // Bereits als Abhängigkeit gemeldet ("Muss nach … geladen werden").
      if (depIds.has(other)) continue;
      if (pos.has(other) && pos.get(other) > pos.get(id)) {
        add(id, 'warning', `Sollte nach „${byPackage.get(other)?.name || other}“ geladen werden`, { type: 'sort' });
      }
    }
    for (const other of mod.loadBefore) {
      if (pos.has(other) && pos.get(other) < pos.get(id)) {
        add(id, 'warning', `Sollte vor „${byPackage.get(other)?.name || other}“ geladen werden`, { type: 'sort' });
      }
    }
    for (const other of mod.incompatibleWith) {
      if (pos.has(other)) add(id, 'error', `Inkompatibel mit „${byPackage.get(other)?.name || other}“`);
    }
  }
  return issues;
}

module.exports = { readConfig, writeConfig, autoSort, analyze, versionSupported, CORE };
