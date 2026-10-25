// Liest installierte Mods (Data/ + Mods/) und deren About.xml ein.
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,   // "1.10" muss ein String bleiben
  trimValues: true,
  processEntities: true,
  isArray: (name) => name === 'li'
});

const OFFICIAL_NAMES = {
  'ludeon.rimworld': 'Core',
  'ludeon.rimworld.royalty': 'Royalty',
  'ludeon.rimworld.ideology': 'Ideology',
  'ludeon.rimworld.biotech': 'Biotech',
  'ludeon.rimworld.anomaly': 'Anomaly',
  'ludeon.rimworld.odyssey': 'Odyssey'
};
const OFFICIAL_ORDER = Object.keys(OFFICIAL_NAMES);

function list(node) {
  if (!node) return [];
  if (Array.isArray(node)) return node;
  if (typeof node === 'object' && node.li) return node.li;
  if (typeof node === 'string' && node) return [node];
  return [];
}

function strings(node) {
  return list(node).map((v) => (typeof v === 'string' ? v : String(v?.['#text'] ?? ''))).filter(Boolean);
}

function lower(arr) {
  return arr.map((s) => s.toLowerCase());
}

function workshopIdFromUrl(url) {
  const m = String(url || '').match(/(\d{6,})/);
  return m ? m[1] : '';
}

// Workshop-IDs verbreiteter Bibliotheken, falls ein Mod in der About.xml keinen steamWorkshopUrl angibt.
const KNOWN_WORKSHOP_IDS = {
  'brrainz.harmony': '2009463077',
  'unlimitedhugs.hugslib': '818773962',
  'oskarpotocki.vanillafactionsexpanded.core': '2023507013'
};

function parseDependencies(meta, version) {
  const deps = list(meta.modDependencies);
  const byVersion = meta.modDependenciesByVersion?.['v' + version];
  if (byVersion) deps.push(...list(byVersion));
  const seen = new Set();
  return deps
    .filter((d) => d && typeof d === 'object' && d.packageId)
    .map((d) => {
      const packageId = String(d.packageId).toLowerCase();
      return {
        packageId,
        displayName: String(d.displayName || d.packageId),
        workshopId: workshopIdFromUrl(d.steamWorkshopUrl) || KNOWN_WORKSHOP_IDS[packageId] || ''
      };
    })
    .filter((d) => !seen.has(d.packageId) && seen.add(d.packageId));
}

function withVersion(meta, key, version) {
  const out = strings(meta[key]);
  const byVersion = meta[key + 'ByVersion']?.['v' + version];
  if (byVersion) out.push(...strings(byVersion));
  return lower(out);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
  } catch {
    return '';
  }
}

function findPreview(aboutDir) {
  for (const name of ['Preview.png', 'preview.png', 'Preview.jpg', 'preview.jpg', 'Preview.PNG']) {
    const p = path.join(aboutDir, name);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function parseMod(dir, source, version) {
  const aboutDir = fs.existsSync(path.join(dir, 'About')) ? path.join(dir, 'About') : path.join(dir, 'about');
  const aboutFile = ['About.xml', 'about.xml'].map((f) => path.join(aboutDir, f)).find((f) => fs.existsSync(f));
  if (!aboutFile) return null;

  let meta = {};
  let parseError = '';
  try {
    meta = parser.parse(readText(aboutFile)).ModMetaData || {};
  } catch (e) {
    parseError = e.message;
  }

  const folder = path.basename(dir);
  const packageId = String(meta.packageId || `unknown.${folder}`).toLowerCase();
  const workshopId = readText(path.join(aboutDir, 'PublishedFileId.txt')) || (/^\d{6,}$/.test(folder) ? folder : '');
  const authors = strings(meta.authors);
  let mtime = 0;
  try {
    mtime = Math.max(fs.statSync(dir).mtimeMs, fs.statSync(aboutFile).mtimeMs);
  } catch { /* ignorieren */ }

  return {
    key: `${source}:${folder}`,
    packageId,
    name: String(meta.name || OFFICIAL_NAMES[packageId] || folder),
    author: authors.length ? authors.join(', ') : String(meta.author || ''),
    description: String(meta.description || ''),
    supportedVersions: strings(meta.supportedVersions),
    dependencies: parseDependencies(meta, version),
    loadBefore: [...withVersion(meta, 'loadBefore', version), ...lower(strings(meta.forceLoadBefore))],
    loadAfter: [...withVersion(meta, 'loadAfter', version), ...lower(strings(meta.forceLoadAfter))],
    incompatibleWith: withVersion(meta, 'incompatibleWith', version),
    url: String(meta.url || ''),
    modVersion: String(meta.modVersion || ''),
    preview: findPreview(aboutDir),
    path: dir,
    folder,
    source, // 'official' | 'local'
    official: source === 'official',
    workshopId: /^\d+$/.test(workshopId) ? workshopId : '',
    mtime,
    parseError
  };
}

function scanDir(dir, source, version) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mod = parseMod(path.join(dir, entry.name), source, version);
    if (mod) out.push(mod);
  }
  return out;
}

function scanAll(gameDir, modsDir, version) {
  const official = scanDir(path.join(gameDir || '', 'Data'), 'official', version)
    .sort((a, b) => OFFICIAL_ORDER.indexOf(a.packageId) - OFFICIAL_ORDER.indexOf(b.packageId));
  const local = scanDir(modsDir, 'local', version).sort((a, b) => a.name.localeCompare(b.name));
  return [...official, ...local];
}

// Rich-Text-Tags von Unity (<color>, <b> …) für die Anzeige entfernen.
function plainDescription(text) {
  return String(text || '').replace(/<\/?(color|b|i|size|u)[^>]*>/gi, '').replace(/\\n/g, '\n');
}

module.exports = { scanAll, parseMod, plainDescription, OFFICIAL_ORDER, OFFICIAL_NAMES };
