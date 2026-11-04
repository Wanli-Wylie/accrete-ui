// What is running under this Workspace, from ps and lsof, and the files it is writing.
// Only what the process table and the files show; no opinion on whether it is healthy.
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { listProcesses, openFiles, workingDirectories } from '../processes.mjs';
import { inScope, readScope } from '../scope.mjs';

const POLL_MS = 4000;
const SCOPE_MS = 30000;
const CWD_REFRESH_MS = 30000; // a shell can cd; a new pid is looked up as soon as it appears
const TAIL_BYTES = 16 * 1024;
const TAIL_LINES = 5;
const LINE_CHARS = 400;
const MAX_FILES_PER_PROCESS = 8;
const GROWTH_WINDOW_MS = 60000;
const NOT_WORK = /^(?:\/System\/|\/usr\/libexec\/|\/usr\/sbin\/)/;
const SHELL = /^-?(?:\S*\/)?(?:zsh|bash|sh|dash|fish|ksh|tcsh|csh)$/;
const TMUX = /^(?:\S*\/)?tmux(?::|\s|$)/;
const UI_SERVER = /\bbin\/accrete-ui\.mjs(?:\s|$)/;
const BINARY_EXTENSIONS = new Set(['.nc', '.nc4', '.h5', '.hdf5', '.npy', '.npz', '.grib', '.grb', '.zarr', '.parquet', '.bin', '.dat', '.pkl', '.pt', '.ckpt', '.sqlite', '.db', '.png', '.jpg', '.pdf', '.gz', '.zip', '.tar', '.zst']);

function isShell(command) {
  return SHELL.test(command.split(/\s+/, 1)[0]);
}

// A shell sitting at its prompt: no script and no -c, just options.
function isLoginShellForm(command) {
  const [program, ...args] = command.split(/\s+/);
  return SHELL.test(program) && args.every((arg) => arg.startsWith('-') && !/^-[a-z]*c[a-z]*$/.test(arg));
}

// The tree of processes to show, from ps rows and pid -> cwd. A process's parent in
// the tree is its nearest ancestor that is itself shown.
export function selectProcesses(rows, cwds, scope, selfPid = process.pid) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const servers = new Set(rows.filter((row) => row.pid === selfPid || UI_SERVER.test(row.command)).map((row) => row.pid));
  const isOurs = (row) =>
    servers.has(row.pid) || TMUX.test(row.command) || (servers.has(row.ppid) && !isShell(row.command)); // ps, lsof and the Kernel, run by a reader

  const nodes = new Map();
  for (const row of rows) {
    if (inScope(scope, cwds.get(row.pid)) && !isOurs(row)) nodes.set(row.pid, { ...row, cwd: cwds.get(row.pid), children: [] });
  }

  const roots = [];
  for (const node of nodes.values()) {
    let up = byPid.get(node.ppid);
    while (up && !nodes.has(up.pid)) up = byPid.get(up.ppid);
    (up ? nodes.get(up.pid).children : roots).push(node);
  }

  const keep = (node) => {
    node.children = node.children.filter(keep).sort((a, b) => a.startedAt - b.startedAt);
    return node.children.length > 0 || !isLoginShellForm(node.command) || node.cpu >= 1;
  };
  return roots.filter(keep).sort((a, b) => a.startedAt - b.startedAt);
}

export function writtenFiles(files, home = homedir()) {
  const agentState = [join(home, '.claude/'), join(home, '.codex/')];
  return files.filter(
    (file) =>
      /^\d+$/.test(file.fd) &&
      (file.access === 'w' || file.access === 'u') &&
      file.type === 'REG' &&
      file.name?.startsWith('/') &&
      !agentState.some((dir) => file.name.startsWith(dir)),
  );
}

// Terminal control sequences go, and a line rewritten with \r shows its last state.
function cleanLine(line) {
  const text = line
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .split('\r')
    .filter(Boolean)
    .pop() ?? '';
  const plain = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  return plain.length > LINE_CHARS ? `${plain.slice(0, LINE_CHARS)}...` : plain;
}

// The last lines of a file if its end looks like text, or { binary: true }.
export async function readLogTail(path, size) {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) return { binary: true };
  const length = Math.min(size, TAIL_BYTES);
  const file = await open(path, 'r');
  let buffer;
  try {
    buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, size - length);
    buffer = buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
  if (buffer.includes(0)) return { binary: true };
  const text = buffer.toString('utf8');
  const odd = text.match(/[�\x01-\x08\x0e-\x1a\x1c-\x1f]/g)?.length ?? 0;
  if (odd > Math.max(4, text.length / 100)) return { binary: true };
  const lines = text.split('\n');
  if (size > length) lines.shift(); // cut at the start
  while (lines.length > 0 && !lines.at(-1).trim()) lines.pop();
  return { lines: lines.slice(-TAIL_LINES).map(cleanLine) };
}

const quiet = (node) => node.cpu < 1 && node.writes.length === 0 && node.children.every(quiet);

// An agent can keep dozens of the same idle helper here, one set per thread. Three or
// more identical quiet siblings read as one line, so a lone stuck program never folds.
export function foldIdentical(nodes) {
  const same = new Map();
  for (const node of nodes) {
    if (!quiet(node)) continue;
    if (!same.has(node.command)) same.set(node.command, []);
    same.get(node.command).push(node);
  }
  const folded = [];
  for (const node of nodes) {
    const peers = same.get(node.command);
    if (!quiet(node) || !peers || peers.length < 3) folded.push({ ...node, children: foldIdentical(node.children) });
    else if (peers[0] === node) folded.push({ ...node, children: [], pids: peers.map((peer) => peer.pid), rss: peers.reduce((sum, peer) => sum + peer.rss, 0) });
  }
  return folded;
}

function present(node) {
  return {
    pid: node.pid,
    pids: node.pids,
    startedAt: node.startedAt,
    cpu: Math.round(node.cpu),
    rssMb: Math.round(node.rss / 1048576),
    cwd: node.cwd,
    command: node.command,
    writes: node.writes,
    children: node.children.map(present),
  };
}

export function createRunning({ selfPid = process.pid, uid = process.getuid(), home = homedir() } = {}) {
  const cwdCache = new Map(); // pid -> { startedAt, cwd }
  const fileCache = new Map(); // path -> { size, mtimeMs, samples, tail }
  let cwdsAt = 0;

  async function refreshCwds(rows, now) {
    const candidates = rows.filter((row) => row.uid === uid && !NOT_WORK.test(row.command));
    const stale = now - cwdsAt >= CWD_REFRESH_MS;
    const lookup = stale ? candidates : candidates.filter((row) => cwdCache.get(row.pid)?.startedAt !== row.startedAt);
    if (stale) cwdsAt = now;
    const found = await workingDirectories(lookup.map((row) => row.pid));
    for (const row of lookup) cwdCache.set(row.pid, { startedAt: row.startedAt, cwd: found.get(row.pid) ?? null });
    const alive = new Set(rows.map((row) => row.pid));
    for (const pid of cwdCache.keys()) if (!alive.has(pid)) cwdCache.delete(pid);
    return new Map(candidates.map((row) => [row.pid, cwdCache.get(row.pid)?.cwd]));
  }

  async function describeFile(path, now) {
    let info;
    try {
      info = await stat(path);
    } catch {
      return null; // deleted while still open, or out of reach
    }
    if (!info.isFile()) return null;
    let known = fileCache.get(path);
    if (!known) fileCache.set(path, (known = { samples: [], tail: null }));
    if (known.size !== info.size || known.mtimeMs !== info.mtimeMs || !known.tail) {
      known.size = info.size;
      known.mtimeMs = info.mtimeMs;
      known.tail = await readLogTail(path, info.size).catch(() => ({ unknown: true }));
    }
    known.seen = now;
    known.samples.push({ at: now, size: info.size });
    while (known.samples.length > 2 && now - known.samples[1].at >= GROWTH_WINDOW_MS) known.samples.shift();
    const first = known.samples[0];
    return {
      path,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ...known.tail,
      grew: info.size - first.size,
      overSeconds: Math.round((now - first.at) / 5000) * 5,
    };
  }

  async function poll(scope) {
    const now = Date.now();
    const rows = await listProcesses();
    const cwds = await refreshCwds(rows, now);
    const roots = selectProcesses(rows, cwds, scope, selfPid);

    const shown = [];
    const walk = (node) => {
      shown.push(node);
      node.children.forEach(walk);
    };
    roots.forEach(walk);

    const opened = await openFiles(shown.map((node) => node.pid));
    const files = {};
    for (const node of shown) {
      const written = writtenFiles(opened.get(node.pid) ?? [], home);
      const paths = [...new Set(written.map((file) => file.name))];
      for (const path of paths) {
        if (!(path in files)) files[path] = await describeFile(path, now);
      }
      node.writes = paths
        .filter((path) => files[path])
        .sort((a, b) => files[b].mtimeMs - files[a].mtimeMs)
        .slice(0, MAX_FILES_PER_PROCESS);
    }
    for (const [path, known] of fileCache) if (known.seen !== now) fileCache.delete(path);
    for (const path of Object.keys(files)) if (!files[path]) delete files[path];

    return { scope, home, roots: foldIdentical(roots).map(present), files };
  }

  return { poll };
}

export function start({ root, emit }) {
  emit('running', { scope: [root], home: homedir(), roots: [], files: {}, loading: true });
  const running = createRunning();
  let scope = [root];
  let scopeAt = 0;
  let last = null;

  async function poll() {
    try {
      if (Date.now() - scopeAt > SCOPE_MS) {
        scope = await readScope(root);
        scopeAt = Date.now();
      }
      const state = JSON.stringify(await running.poll(scope));
      if (state !== last) {
        last = state;
        emit('running', JSON.parse(state));
      }
    } catch (err) {
      console.error(`accrete-ui: running poll failed: ${err.message}`);
    }
    setTimeout(poll, POLL_MS).unref();
  }
  poll();
}
