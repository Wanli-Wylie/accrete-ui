#!/usr/bin/env node
// Assemble the self-contained bundle accrete-kit ships: dist/accrete-ui-<version>/, its
// archive, and SHA256SUMS. vendor/ holds only what runs; server/deps.mjs finds it there.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = `accrete-ui-${pkg.version}`;
const dist = path.join(root, 'dist');
const top = path.join(dist, name);
const modules = path.join(root, 'node_modules');
const fail = message => {
  throw new Error(message);
};

// What each runtime dependency keeps, by path inside the package. The page loads xterm's
// .mjs builds through vendorFiles in server/server.mjs; the server requires the other two.
const xterm = file => /^lib\/[^/]+\.mjs$/.test(file) || /^css\/[^/]+\.css$/.test(file);
const ws = file => file === 'package.json' || file === 'index.js' || /^lib\/[^/]+\.js$/.test(file);
const nodePty = file => file === 'package.json'
  || /^prebuilds\/darwin-[^/]+\/[^/]+$/.test(file)
  || (/^lib\/[^/]+\.js$/.test(file) && !/\.test\.js$/.test(file) && !/^lib\/(?:windows|conpty)/.test(file));
const keeps = { ws, 'node-pty': nodePty };

/** Files under a directory, as forward-slash paths relative to it. */
function walk(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = `${prefix}${entry.name}`;
    if (entry.name === '.DS_Store') return [];
    if (entry.isDirectory()) return walk(path.join(directory, entry.name), `${relative}/`);
    if (entry.isFile()) return [relative];
    return fail(`not a file or directory: ${path.join(directory, entry.name)}`);
  });
}

function copy(source, destination, keep = () => true) {
  for (const file of walk(source).filter(keep)) {
    fs.mkdirSync(path.dirname(path.join(destination, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join(destination, file));
  }
}

function licenseText(dep) {
  const file = ['LICENSE', 'LICENSE.md'].map(candidate => path.join(modules, dep, candidate)).find(fs.existsSync);
  return file ? fs.readFileSync(file, 'utf8').trim() : fail(`${dep} has no license file`);
}

function notice(dep, note = '') {
  const { version, license } = JSON.parse(fs.readFileSync(path.join(modules, dep, 'package.json'), 'utf8'));
  return `${'='.repeat(72)}\n${dep} ${version} (${license})${note}\n${'='.repeat(72)}\n\n${licenseText(dep)}\n`;
}

if (!fs.existsSync(modules)) fail('no node_modules; run npm ci first');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(top, { recursive: true });

for (const part of ['bin', 'server', 'page']) copy(path.join(root, part), path.join(top, part));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(top, 'LICENSE'));

const notices = [];
for (const dep of Object.keys(pkg.dependencies)) {
  const keep = dep.startsWith('@xterm/') ? xterm : keeps[dep];
  if (!keep) fail(`scripts/build.mjs does not say what to keep of ${dep}`);
  copy(path.join(modules, dep), path.join(top, 'vendor', dep), keep);
  notices.push(notice(dep));
}
// Not vendored, but its headers are compiled into node-pty's pty.node.
notices.push(notice('node-addon-api', ', compiled into node-pty'));
fs.writeFileSync(path.join(top, 'THIRD-PARTY-NOTICES'), `accrete-ui ${pkg.version} bundles the following under vendor/.\n\n${notices.join('\n')}`);

// npm ships spawn-helper as 0644; node-pty fails with posix_spawnp unless it is executable.
const prebuilds = path.join(top, 'vendor/node-pty/prebuilds');
for (const platform of fs.readdirSync(prebuilds)) fs.chmodSync(path.join(prebuilds, platform, 'spawn-helper'), 0o755);

// No AppleDouble files or extended attributes: the archive is unpacked on Linux too.
const archive = `${name}.tar.gz`;
const tar = spawnSync('tar', ['--no-xattrs', '-czf', path.join(dist, archive), '-C', dist, name], {
  encoding: 'utf8',
  env: { ...process.env, COPYFILE_DISABLE: '1' }
});
if (tar.status !== 0) fail(`cannot create ${archive}: ${tar.stderr ?? tar.error?.message}`);
const digest = createHash('sha256').update(fs.readFileSync(path.join(dist, archive))).digest('hex');
fs.writeFileSync(path.join(dist, 'SHA256SUMS'), `${digest}  ${archive}\n`);
console.log(`dist/${archive} ${fs.statSync(path.join(dist, archive)).size} bytes, ${walk(top).length} files`);
