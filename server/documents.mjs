// One scan of a Workspace's managed documents and one set of watchers, shared by
// the objects and activity readers. Nothing here writes.
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative } from 'node:path';
import { resolveWorkspace } from './workspace.mjs';

export const KINDS = ['model', 'iteration', 'tool', 'data', 'result', 'memory'];

const SETTLE_MS = 150; // Quiet time after the last event before rescanning.
const MAX_WAIT_MS = 1000; // A steady stream of events still gets a rescan this often.
const ROOT_CHECK_MS = 2000; // Stores appear on first use, and a checkout can replace them.

export const revisionOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

function scalar(text) {
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  return text;
}

// The Kernel's test for managed Memory: a frontmatter whose kind is memory. Only the
// top-level scalars are read here; links come from the index.
export function memoryFrontmatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return /^kind: memory$/m.test(text) ? { kind: 'memory', problem: 'frontmatter is not closed' } : null;
  const frontmatter = text.slice(4, end);
  if (frontmatter.trimStart().startsWith('{')) {
    try {
      const meta = JSON.parse(frontmatter);
      return meta?.kind === 'memory' ? meta : null;
    } catch {
      return /"kind"\s*:\s*"memory"/.test(frontmatter) ? { kind: 'memory', problem: 'frontmatter is not valid JSON' } : null;
    }
  }
  const meta = {};
  for (const line of frontmatter.split('\n')) {
    const match = line.match(/^([A-Za-z_]+):[ \t]+(.+?)[ \t]*$/);
    if (match) meta[match[1]] = scalar(match[2]);
  }
  return meta.kind === 'memory' ? meta : null;
}

function jsonSummary(kind, bytes) {
  let doc;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { problem: 'not valid JSON' };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { problem: 'not a JSON object' };
  if (doc.kind !== kind) return { ...doc, problem: `kind is ${JSON.stringify(doc.kind ?? null)}, expected ${kind}` };
  return doc;
}

const text = (value) => (typeof value === 'string' && value ? value : undefined);

function summarize(kind, path, rel, bytes) {
  const meta = kind === 'memory' ? memoryFrontmatter(bytes.toString('utf8')) : jsonSummary(kind, bytes);
  if (!meta) return null; // Ordinary Markdown under memory/.
  return {
    kind,
    id: text(meta.id) ?? rel, // A document with no ID can still be listed and opened.
    name: text(meta.name) ?? text(meta.title) ?? text(meta.activity),
    aliases: Array.isArray(meta.aliases) ? meta.aliases.filter(text) : [],
    status: text(meta.status),
    path,
    rel,
    revision: revisionOf(bytes),
    created_at: text(meta.created_at),
    updated_at: text(meta.updated_at),
    authored_at: text(meta.authored_at),
    problem: meta.problem ?? (text(meta.id) ? undefined : 'no id'),
  };
}

// A temporary sibling (.tmpXXXXXX) has no extension, so it never counts. Symlinks
// don't count either, as for the Kernel.
async function listFiles(dir, extension, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // Absent on a fresh Workspace, or gone mid-scan.
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(path, extension, out);
    else if (entry.isFile() && extname(entry.name) === extension) out.push(path);
  }
  return out;
}

const stampOf = (info) => (info ? `${info.ino}:${info.size}:${info.mtimeMs}` : null);

const stores = new Map();

export function openStore(root) {
  if (!stores.has(root)) stores.set(root, createStore(root));
  return stores.get(root);
}

async function createStore(root) {
  const workspace = await resolveWorkspace(root);
  const { metadata, results, memory } = workspace.paths;
  const stateDir = workspace.local_state?.directory;
  const indexPath = workspace.local_state?.index;
  const base = workspace.project_root ?? root;
  const roots = {
    model: join(metadata, 'models'),
    iteration: join(metadata, 'iterations'),
    tool: join(metadata, 'tools'),
    data: join(metadata, 'data'),
    result: results,
    memory,
  };

  const relToBase = (path) => {
    const rel = relative(base, path);
    return rel.startsWith('..') || isAbsolute(rel) ? path : rel;
  };

  const store = {
    root,
    workspace,
    docs: new Map(), // path -> summary
    byId: new Map(),
    byName: new Map(), // `${kind}:${name or alias}` -> summary, or null when ambiguous
    receipts: [],
    relToBase,
    subscribe: (listener) => listeners.add(listener),
    close,
  };
  const listeners = new Set();
  const cache = new Map(); // path -> { stamp, doc }, so a rescan only reads what changed
  let indexStamp = null;

  async function scanDocuments() {
    const docs = new Map();
    const seen = new Set();
    for (const kind of KINDS) {
      for (const path of await listFiles(roots[kind], kind === 'memory' ? '.md' : '.json')) {
        const stamp = stampOf(await stat(path).catch(() => null));
        if (!stamp) continue;
        let entry = cache.get(path);
        if (entry?.stamp !== stamp) {
          const bytes = await readFile(path).catch(() => null);
          if (!bytes) continue;
          entry = { stamp, doc: summarize(kind, path, relToBase(path), bytes) };
          cache.set(path, entry);
        }
        seen.add(path);
        if (entry.doc) docs.set(path, entry.doc);
      }
    }
    for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
    return docs;
  }

  // Short-lived markers of a Kernel operation: publication receipts, and the Data and
  // worktree operations that `accrete recover` also reads.
  async function scanReceipts() {
    if (!stateDir) return [];
    const files = [];
    for (const dir of ['receipts', 'operations']) await listFiles(join(stateDir, dir), '.json', files);
    return files.map((path) => relative(stateDir, path)).sort();
  }

  function setDocs(docs) {
    store.docs = docs;
    store.byId = new Map();
    store.byName = new Map();
    for (const doc of docs.values()) {
      store.byId.set(doc.id, doc);
      for (const name of [doc.name, ...doc.aliases]) {
        if (!name) continue;
        const key = `${doc.kind}:${name}`;
        store.byName.set(key, store.byName.has(key) ? null : doc);
      }
    }
  }

  async function rescan() {
    const docs = await scanDocuments();
    const receipts = await scanReceipts();
    const stamp = indexPath ? stampOf(await stat(indexPath).catch(() => null)) : null;

    const change = { added: [], changed: [], removed: [] };
    for (const [path, doc] of docs) {
      const before = store.docs.get(path);
      if (!before) change.added.push(doc);
      else if (before.revision !== doc.revision) change.changed.push({ before, after: doc });
    }
    for (const [path, doc] of store.docs) if (!docs.has(path)) change.removed.push(doc);
    change.receiptsAdded = receipts.filter((name) => !store.receipts.includes(name));
    change.receiptsRemoved = store.receipts.filter((name) => !receipts.includes(name));
    change.indexChanged = stamp !== indexStamp;

    setDocs(docs);
    store.receipts = receipts;
    indexStamp = stamp;

    const documentsMoved = change.added.length || change.changed.length || change.removed.length;
    const receiptsMoved = change.receiptsAdded.length || change.receiptsRemoved.length;
    if (!documentsMoved && !receiptsMoved && !change.indexChanged) return;
    await Promise.all([...listeners].map((listener) => listener(change)));
  }

  // Rescans never overlap: a change seen during one runs another straight after.
  let timer = null;
  let deadline = 0;
  let running = false;
  let again = false;

  function schedule() {
    const now = Date.now();
    if (!timer) deadline = now + MAX_WAIT_MS;
    clearTimeout(timer);
    timer = setTimeout(run, Math.max(0, Math.min(SETTLE_MS, deadline - now)));
    timer.unref();
  }

  async function run() {
    timer = null;
    if (running) {
      again = true;
      return;
    }
    running = true;
    do {
      again = false;
      await rescan().catch((err) => console.error(`accrete-ui: document scan failed: ${err.message}`));
    } while (again);
    running = false;
  }

  // Watch whichever roots exist now, and re-attach when one appears or is replaced.
  // Watching the whole local state directory takes in receipts/, operations/ and the index.
  const watchers = new Map(); // dir -> { ino, watcher }
  const watched = [metadata, results, memory, stateDir].filter(Boolean);

  async function syncWatchers() {
    for (const dir of watched) {
      const info = await stat(dir).catch(() => null);
      const current = watchers.get(dir);
      if (current && current.ino === info?.ino) continue;
      current?.watcher.close();
      watchers.delete(dir);
      if (current) schedule();
      if (!info) continue;
      const watcher = watch(dir, { recursive: true, persistent: false }, schedule);
      watcher.on('error', () => {
        watcher.close();
        if (watchers.get(dir)?.watcher === watcher) watchers.delete(dir);
      });
      watchers.set(dir, { ino: info.ino, watcher });
      schedule();
    }
  }

  const rootCheck = setInterval(syncWatchers, ROOT_CHECK_MS);
  rootCheck.unref();

  function close() {
    clearInterval(rootCheck);
    clearTimeout(timer);
    timer = null;
    for (const { watcher } of watchers.values()) watcher.close();
    watchers.clear();
    listeners.clear();
    stores.delete(root);
  }

  await rescan();
  await syncWatchers();
  return store;
}
