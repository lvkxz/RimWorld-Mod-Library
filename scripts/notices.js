// Developer tool: writes THIRD_PARTY_NOTICES.md with the licenses of everything shipped in the app
// (Rust crates linked into the executable + Lucide in the frontend). Build-time crates and proc macros are skipped.
// Usage: npm run notices
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');

const meta = JSON.parse(
  execFileSync(
    'cargo',
    ['metadata', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc', '--manifest-path', path.join(root, 'src-tauri', 'Cargo.toml')],
    { maxBuffer: 256 * 1024 * 1024 }
  ).toString()
);
const packages = new Map(meta.packages.map((p) => [p.id, p]));
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const isProcMacro = (p) => p.targets.some((t) => t.kind.includes('proc-macro'));

// Runtime dependency graph from the app crate (normal dependencies only).
const shipped = new Set();
const walk = (id) => {
  for (const dep of nodes.get(id).deps) {
    if (!dep.dep_kinds.some((k) => k.kind === null)) continue;
    const pkg = packages.get(dep.pkg);
    if (shipped.has(dep.pkg) || isProcMacro(pkg)) continue;
    shipped.add(dep.pkg);
    walk(dep.pkg);
  }
};
walk(meta.resolve.root);

function licenseFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice)/i.test(f) && fs.statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim());
}

const entries = [...shipped].map((id) => {
  const p = packages.get(id);
  return {
    name: p.name,
    version: p.version,
    license: p.license || (p.license_file ? 'see license file' : 'unknown'),
    homepage: p.repository || p.homepage || '',
    texts: licenseFiles(path.dirname(p.manifest_path))
  };
});

const lucideDir = path.join(root, 'node_modules', 'lucide');
const lucide = JSON.parse(fs.readFileSync(path.join(lucideDir, 'package.json'), 'utf8'));
entries.push({
  name: 'lucide',
  version: lucide.version,
  license: lucide.license,
  homepage: lucide.homepage || '',
  texts: licenseFiles(lucideDir)
});
entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

// Identical license texts are printed once, with the packages that use them.
const groups = new Map();
for (const e of entries) {
  for (const text of e.texts) {
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(`${e.name} ${e.version}`);
  }
}

let out = '# Third-party notices\n\n';
out += 'RimWorld Mod Library includes the following third-party software.\n';
out += 'The web view is the Microsoft Edge WebView2 Runtime installed with Windows; it is not shipped with the app.\n\n';
out += '| Package | Version | License | Source |\n|---|---|---|---|\n';
out += entries.map((e) => `| ${e.name} | ${e.version} | ${e.license} | ${e.homepage} |`).join('\n') + '\n';
out += '\n## License texts\n';
for (const [text, users] of groups) {
  out += `\n---\n\nUsed by: ${users.join(', ')}\n\n\`\`\`\n${text}\n\`\`\`\n`;
}
const missing = entries.filter((e) => !e.texts.length);
if (missing.length) {
  out += '\n---\n\nPackages without a bundled license file (license per the table above):\n';
  out += missing.map((e) => `- ${e.name} ${e.version} (${e.license})`).join('\n') + '\n';
}
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), out, 'utf8');
console.log(`THIRD_PARTY_NOTICES.md written (${entries.length} packages, ${groups.size} distinct license texts)`);
