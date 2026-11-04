// Reads the Workspace for the objects panel. Documents are primary and always list
// and open. Relation rows come from the index, because it normalizes their shapes.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KINDS, openStore, revisionOf } from '../documents.mjs';
import { resolveWorkspace } from '../workspace.mjs';

const MAX_PAGE = 1000;
const SAMPLES = 5;

let store = null;
let indexRevisions = new Map(); // path -> revision, as of the last read of the index
let indexPresent = false;

function query(index, sql, attempt = 0) {
  return new Promise((resolve, reject) => {
    const args = ['-batch', '-init', '/dev/null', '-readonly', '-json', index, sql];
    execFile('sqlite3', args, { maxBuffer: 2 ** 28, timeout: 20000 }, (err, stdout, stderr) => {
      if (err) {
        const message = stderr.trim() || err.message;
        if (attempt < 10 && /locked|busy/i.test(message)) {
          return setTimeout(() => query(index, sql, attempt + 1).then(resolve, reject), 100);
        }
        return reject(new Error(message));
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : []);
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

const DOCUMENT_ROWS = ['models', 'iterations', 'tools', 'data_objects', 'results', 'memory_entries']
  .map((table) => `SELECT path, revision FROM ${table}`)
  .join(' UNION ALL ');

// What the index holds against what the documents hold, in plain counts and names.
async function readIndex() {
  const index = store.workspace.local_state?.index;
  let state;
  let rows = [];
  let failure;
  if (index && existsSync(index)) {
    try {
      [state] = await query(index, 'SELECT refreshed_at, object_count FROM index_state');
      rows = await query(index, DOCUMENT_ROWS);
    } catch (err) {
      // A refresh creates the file a moment before its tables.
      if (!/no such table/.test(err.message)) failure = err.message;
    }
  }
  indexPresent = Boolean(state) && !failure;
  indexRevisions = new Map(rows.map((row) => [row.path, row.revision]));
  if (failure) return { present: true, error: failure };
  if (!state) return { present: false };

  const changed = [];
  const missing = [];
  for (const doc of store.docs.values()) {
    const revision = indexRevisions.get(doc.path);
    if (revision === undefined) missing.push(doc.rel);
    else if (revision !== doc.revision) changed.push(doc.rel);
  }
  const gone = rows.filter((row) => !store.docs.has(row.path)).map((row) => store.relToBase(row.path));
  return {
    present: true,
    refreshed_at: state.refreshed_at,
    object_count: state.object_count,
    changed: { count: changed.length, sample: changed.slice(0, SAMPLES) },
    missing: { count: missing.length, sample: missing.slice(0, SAMPLES) },
    gone: { count: gone.length, sample: gone.slice(0, SAMPLES) },
  };
}

function templateVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, '.accrete/release.json'), 'utf8')).template_version ?? 'latest';
  } catch {
    return 'latest';
  }
}

export async function start({ root, emit }) {
  store = await openStore(root);
  const install = store.workspace.kernel ? null : `npx accrete-kit@${templateVersion(root)} install`;
  // A Kernel that is there but failed is worth naming; one that isn't there is the normal case.
  const kernelError = install && !/ENOENT/.test(store.workspace.error ?? '') ? store.workspace.error : undefined;
  let seq = 0;

  async function publish() {
    const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
    for (const doc of store.docs.values()) counts[doc.kind] += 1;
    const index = await readIndex();
    emit('objects', { seq: ++seq, counts, index, install, kernel_error: kernelError });
  }

  store.subscribe(publish);
  await publish();
}

const timeOf = (doc) => doc.authored_at ?? doc.updated_at ?? doc.created_at ?? '';

function list(kind, offset, limit) {
  const docs = [...store.docs.values()].filter((doc) => doc.kind === kind);
  docs.sort((a, b) => timeOf(b).localeCompare(timeOf(a)) || a.rel.localeCompare(b.rel));
  return {
    kind,
    total: docs.length,
    offset,
    items: docs.slice(offset, offset + limit).map((doc) => ({
      id: doc.id,
      name: doc.name,
      status: doc.status,
      rel: doc.rel,
      time: timeOf(doc) || undefined,
      problem: doc.problem,
    })),
  };
}

const quote = (value) => `'${value.replaceAll("'", "''")}'`;

// A reference holds whatever its author wrote, and the Kernel accepts a name or alias
// where an ID goes: `memory append --model NAME` stores NAME. So reverse lookups match
// those too, and a forward lookup falls back to them.
function relationSql(id, doc) {
  const me = quote(id);
  const us = `(${[id, doc?.name, ...(doc?.aliases ?? [])].filter(Boolean).map(quote).join(',')})`;
  const dataDoc = '(SELECT document FROM results r WHERE r.id = d.result_id)';
  const origin = "json_extract(document, '$.origin.result_id')";
  return [
    `SELECT 'Models used' section, 'model' kind, model_id target, role, commit_id, NULL revision, document link, NULL result_doc FROM result_models WHERE result_id = ${me}`,
    `SELECT 'Tools used', 'tool', tool_id, NULL, NULL, revision_used, document, NULL FROM result_tools WHERE result_id = ${me}`,
    `SELECT 'Data', 'data', data_id, role, NULL, NULL, document, ${dataDoc} FROM result_data d WHERE result_id = ${me}`,
    `SELECT 'Data from this Result', 'data', id, NULL, NULL, NULL, NULL, NULL FROM data_objects WHERE ${origin} = ${me}`,
    `SELECT 'Model', 'model', model_id, NULL, NULL, starting_revision, NULL, NULL FROM iterations WHERE id = ${me}`,
    `SELECT 'Iterations', 'iteration', id, NULL, NULL, starting_revision, NULL, NULL FROM iterations WHERE model_id IN ${us}`,
    `SELECT 'Results', 'result', result_id, role, commit_id, NULL, document, NULL FROM result_models WHERE model_id IN ${us}`,
    `SELECT 'Results', 'result', result_id, NULL, NULL, revision_used, document, NULL FROM result_tools WHERE tool_id IN ${us}`,
    `SELECT 'Results', 'result', result_id, role, NULL, NULL, document, ${dataDoc} FROM result_data d WHERE data_id IN ${us}`,
    `SELECT 'Origin', 'result', ${origin}, NULL, NULL, NULL, NULL, NULL FROM data_objects WHERE id = ${me} AND ${origin} IS NOT NULL`,
    `SELECT 'Links', kind, target_id, relation, NULL, NULL, document, NULL FROM memory_links WHERE memory_id = ${me}`,
    `SELECT 'Linked from Memory', 'memory', memory_id, relation, NULL, NULL, NULL, NULL FROM memory_links WHERE target_id = ${me} OR (target_id IN ${us} AND kind = ${quote(doc?.kind ?? '')})`,
  ].join(' UNION ALL ');
}

// The IDs a reference or a list of references names, in any shape the Kernel accepts.
function referencedIds(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(referencedIds);
  if (value === null || typeof value !== 'object') return [];
  const own = value.data_id ?? value.id ?? value.data;
  return typeof own === 'string' ? [own] : Object.values(value).flatMap(referencedIds);
}

// result_data.role is the author's role, so "forcing" hides whether it was an input.
// The Result's own document still says.
function direction(row) {
  if (!row.result_doc) return undefined;
  const link = JSON.parse(row.link);
  if (link.direction) return link.direction;
  const result = JSON.parse(row.result_doc);
  const [named] = referencedIds(link);
  if (referencedIds(result.inputs).includes(named)) return 'input';
  if (referencedIds(result.outputs).includes(named)) return 'output';
  return undefined;
}

function commitAvailable(checkout, commit) {
  if (!checkout) return null; // Nothing on this host to look in.
  if (!/^[0-9a-f]{4,64}$/i.test(commit)) return false;
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', '-C', checkout, 'cat-file', '-e', `${commit}^{commit}`], { timeout: 5000 }, (err) => resolve(!err));
  });
}

async function relations(id, doc, configuration) {
  if (!indexPresent) return null;
  const models = configuration?.models ?? {};
  const rows = await query(store.workspace.local_state.index, relationSql(id, doc));
  return Promise.all(
    rows.map(async (row) => {
      const target = row.target === null ? null : store.byId.get(row.target) ?? store.byName.get(`${row.kind}:${row.target}`);
      const flow = direction(row);
      const relation = {
        section: row.section === 'Data' && flow ? `${flow[0].toUpperCase()}${flow.slice(1)} Data` : row.section,
        kind: target?.kind ?? row.kind,
        id: target?.id ?? row.target,
        name: target?.name,
        present: Boolean(target),
        direction: row.section === 'Results' ? flow : undefined,
        role: row.role ?? undefined,
        commit: row.commit_id ?? undefined,
        revision: row.revision ?? undefined,
      };
      if (row.target === null) relation.detail = row.link; // A reference with no ID, such as a bare path.
      if (row.section === 'Models used' && row.commit_id) {
        relation.commit_available = await commitAvailable(models[target?.id ?? row.target]?.checkout, row.commit_id);
      }
      return relation;
    }),
  );
}

// The local paths this host binds to an object, if any.
function hostBinding(doc, configuration) {
  const section = { model: 'models', iteration: 'iterations', tool: 'tools' }[doc?.kind];
  return section ? configuration?.[section]?.[doc.id] : undefined;
}

async function object(id) {
  if (!id || id.length > 1024 || id.includes('\0')) return undefined;
  const doc = store.byId.get(id);
  const bytes = doc ? await readFile(doc.path).catch(() => null) : null;
  // Asked each time, because registering or binding a Model changes the host's bindings.
  const { configuration } = await resolveWorkspace(store.root);
  let rows = null;
  let relationsError;
  try {
    rows = await relations(id, doc, configuration);
  } catch (err) {
    relationsError = err.message;
  }
  const base = { id, relations: rows, relations_error: relationsError };
  if (!bytes) return { ...base, present: false };
  const indexRevision = indexRevisions.get(doc.path);
  return {
    ...base,
    present: true,
    kind: doc.kind,
    name: doc.name,
    status: doc.status,
    rel: doc.rel,
    problem: doc.problem,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    authored_at: doc.authored_at,
    revision: revisionOf(bytes),
    index_revision: indexRevision,
    in_index: indexPresent ? indexRevision !== undefined : undefined,
    binding: hostBinding(doc, configuration),
    text: bytes.toString('utf8'),
  };
}

// rest is untrusted: it selects among scanned documents, and is never used as a path.
export async function read(rest) {
  if (!store) return undefined;
  const [verb, ...tail] = rest.split('/');
  if (verb === 'object') return object(tail.join('/'));
  if (verb === 'list' && KINDS.includes(tail[0])) {
    const offset = Math.max(0, Number.parseInt(tail[1], 10) || 0);
    const limit = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(tail[2], 10) || 100));
    return list(tail[0], offset, limit);
  }
  return undefined;
}
