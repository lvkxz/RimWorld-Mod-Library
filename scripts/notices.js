// Developer tool: writes THIRD_PARTY_NOTICES.md with the licenses of all bundled runtime dependencies.
// Usage: npm run notices
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

function collect(name, seen, withDeps = true) {
  if (seen.has(name)) return;
  const dir = path.join(root, 'node_modules', name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const licenseFile = fs.readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  seen.set(name, {
    name,
    version: meta.version,
    license: meta.license,
    homepage: meta.homepage || meta.repository?.url || '',
    text: licenseFile ? fs.readFileSync(path.join(dir, licenseFile), 'utf8').trim() : ''
  });
  if (withDeps) Object.keys(meta.dependencies || {}).forEach((dep) => collect(dep, seen));
}

const seen = new Map();
// The Electron runtime is bundled into the executable; its npm package dependencies are only the downloader.
collect('electron', seen, false);
Object.keys(pkg.dependencies).forEach((name) => collect(name, seen));

const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
let out = '# Third-party notices\n\n';
out += 'RimWorld Mod Library includes the following third-party software.\n';
out += 'Chromium licenses are shipped separately in `LICENSES.chromium.html`.\n\n';
out += '| Package | Version | License |\n|---|---|---|\n';
out += entries.map((e) => `| ${e.name} | ${e.version} | ${e.license} |`).join('\n') + '\n';
for (const e of entries) {
  out += `\n---\n\n## ${e.name} ${e.version}\n\n`;
  if (e.homepage) out += `${e.homepage.replace(/^git\+/, '')}\n\n`;
  out += '```\n' + (e.text || `License: ${e.license}`) + '\n```\n';
}
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), out, 'utf8');
console.log(`THIRD_PARTY_NOTICES.md written (${entries.length} packages)`);
