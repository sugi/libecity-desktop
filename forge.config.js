const fs = require('node:fs');
const path = require('node:path');

// Everything main.js needs is bundled by esbuild, so only these ship.
const KEEP_FILES = new Set([
  '/package.json',
  '/index.html',
  '/LICENSE-MIT.md',
  '/LICENSE-CC0.md',
]);
const KEEP_DIRS = ['/dist', '/images'];

// Allowlist rather than denylist: the working tree holds gitignored dumps with
// auth tokens (report.txt, *.jsonl, session.tsv) that must never reach a .deb.
const ignore = (entry) =>
  entry !== '' &&
  !KEEP_FILES.has(entry) &&
  !KEEP_DIRS.some((dir) => entry === dir || entry.startsWith(`${dir}/`));

// electron-packager copies file modes verbatim and the deb installs as root, so
// anything without o+r becomes unreadable to the user running the app. Electron
// then fails to read package.json and exits 1 without printing anything.
const grantWorldRead = (dir) => {
  fs.chmodSync(dir, fs.statSync(dir).mode | 0o055);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) grantWorldRead(target);
    else fs.chmodSync(target, fs.statSync(target).mode | 0o044);
  }
};

module.exports = {
  packagerConfig: {
    ignore,
    afterCopy: [
      (buildPath, _electronVersion, _platform, _arch, callback) => {
        grantWorldRead(buildPath);
        callback();
      },
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32', 'linux'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
};
