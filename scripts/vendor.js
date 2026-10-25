// Copies files the UI loads from outside src/ into src/vendor (ignored by git): Lucide icons and the app icon.
// Runs automatically before `npm start` and `npm run dist` (beforeDevCommand / beforeBuildCommand).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'src', 'vendor');
const files = [
  ['node_modules/lucide/dist/umd/lucide.min.js', 'lucide.min.js'],
  ['assets/icon.png', 'icon.png']
];

fs.mkdirSync(vendor, { recursive: true });
for (const [from, to] of files) fs.copyFileSync(path.join(root, from), path.join(vendor, to));
console.log('src/vendor updated');
