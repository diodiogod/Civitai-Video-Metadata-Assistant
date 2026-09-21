const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
fs.mkdirSync(output, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const archive = path.join(output, `${manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${manifest.version}.zip`);
const staging = path.join(output, `.package-staging-${process.pid}`);
if (fs.existsSync(archive)) fs.rmSync(archive);
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

const releaseFiles = [
  'manifest.json',
  'popup.html',
  'popup.css',
  'popup.js',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-96.png',
  'icons/icon-128.png',
  'src',
  'README.md',
  'LICENSE',
  'CHANGELOG.md'
];

for (const item of releaseFiles) {
  const source = path.join(root, item);
  const destination = path.join(staging, item);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

try {
  if (process.platform === 'win32') {
    const escapedStaging = staging.replace(/'/g, "''");
    const escapedArchive = archive.replace(/'/g, "''");
    const command = `$ErrorActionPreference = 'Stop'; Push-Location '${escapedStaging}'; try { Compress-Archive -Path * -DestinationPath '${escapedArchive}' -Force } finally { Pop-Location }`;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-qr', archive, '.'], { cwd: staging, stdio: 'inherit' });
  }
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}

function manifestPaths() {
  const icons = new Set([
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {})
  ]);
  return new Set([
    'manifest.json',
    manifest.action?.default_popup,
    ...icons,
    ...(manifest.content_scripts || []).flatMap((entry) => [...(entry.js || []), ...(entry.css || [])])
  ].filter(Boolean).map((entry) => String(entry).replace(/\\/g, '/')));
}

const archivedPaths = new Set(
  execFileSync('tar', ['-tf', archive], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((entry) => entry.replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/$/, ''))
    .filter(Boolean)
);
const missingPaths = [...manifestPaths()].filter((entry) => !archivedPaths.has(entry));
if (missingPaths.length) {
  throw new Error(`Package is missing manifest-referenced paths: ${missingPaths.join(', ')}`);
}

console.log(archive);
