#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startServer } from '../server/server.mjs';

function fail(message) {
  console.error(`accrete-ui: ${message}`);
  process.exit(1);
}

let opts;
try {
  ({ values: opts } = parseArgs({
    options: {
      project: { type: 'string' },
      'no-open': { type: 'boolean' },
      'no-tmux': { type: 'boolean' },
      port: { type: 'string' },
    },
  }));
} catch (err) {
  fail(`${err.message}\nusage: accrete-ui [--project PATH] [--no-open] [--no-tmux] [--port N]`);
}

function findWorkspace(from) {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.accrete/project.toml'))) return dir;
    if (dir === dirname(dir)) return null;
  }
}

const start = opts.project ?? process.cwd();
const root = findWorkspace(start);
if (!root) fail(`no ACCRETE Workspace at or above ${resolve(start)} (no .accrete/project.toml found)`);

const { url } = await startServer({
  root,
  port: Number(opts.port ?? 0),
  tmux: !opts['no-tmux'],
  tmuxSocket: process.env.ACCRETE_UI_TMUX_SOCKET,
}).catch((err) => fail(err.message));

console.log(url);
if (!opts['no-open']) execFile('open', [url]);
