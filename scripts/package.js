const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
fs.mkdirSync(output, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const archive = path.join(output, `${manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${manifest.version}.zip`);
if (fs.existsSync(archive)) fs.rmSync(archive);

const releaseFiles = [
  'manifest.json',
  'popup.html',
  'popup.css',
  'popup.js',
  'src',
  'README.md',
  'LICENSE',
  'CHANGELOG.md'
];

if (process.platform === 'win32') {
  const quotedItems = releaseFiles.map((item) => `'${path.join(root, item)}'`).join(',');
  const command = `$ErrorActionPreference = 'Stop'; $items = @(${quotedItems}); Compress-Archive -LiteralPath $items -DestinationPath '${archive}' -Force`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-qr', archive, ...releaseFiles], { cwd: root, stdio: 'inherit' });
}

console.log(archive);
