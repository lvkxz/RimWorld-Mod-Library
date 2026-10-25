// Copies the build output to release/ as RimWorld-Mod-Library-Setup-<version>.exe and -Portable-<version>.exe.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const target = path.join(root, 'src-tauri', 'target', 'release');
const out = path.join(root, 'release');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const nsisDir = path.join(target, 'bundle', 'nsis');
const setup = fs.readdirSync(nsisDir).find((f) => f.endsWith('-setup.exe') && f.includes(version));
if (!setup) throw new Error(`No NSIS installer for ${version} in ${nsisDir}`);
const files = [
  [path.join(nsisDir, setup), `RimWorld-Mod-Library-Setup-${version}.exe`],
  // Die nackte .exe braucht keine Installation (WebView2 ist ab Windows 10/11 vorhanden).
  [path.join(target, 'RimWorld Mod Library.exe'), `RimWorld-Mod-Library-Portable-${version}.exe`]
];
for (const [from, name] of files) {
  fs.copyFileSync(from, path.join(out, name));
  console.log(`${name}  ${(fs.statSync(from).size / 1024 / 1024).toFixed(2)} MB`);
}
