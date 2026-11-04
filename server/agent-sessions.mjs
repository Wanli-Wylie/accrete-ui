// Everything that knows the private file formats of Claude Code and Codex. They
// change without notice, so anything not understood comes back as null, which the
// page shows as "unknown", and nothing here throws because of what a file contains.
// Reads only: bounded heads and tails, never a whole transcript, and never Codex's
// SQLite files, since even a read-only connection to a WAL database touches its -shm.
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentOf } from './processes.mjs';
import { inScope } from './scope.mjs';

const CLAUDE_HEAD = 64 * 1024;
const CODEX_META_HEAD = 4 * 1024; // session_meta's first fields; the whole line is over 20 KB
const CODEX_TITLE_HEAD = 256 * 1024; // the first message can sit past 150 KB of instructions
const TAIL_STEPS = [64 * 1024, 256 * 1024, 1024 * 1024]; // widen only while no tool call has been found
const MAX_SESSIONS = 40;
const MAX_SUBAGENTS = 8;
const COLD_AFTER_MS = 60 * 60 * 1000;
const COLD_STAT_MS = 60 * 1000;
const ACTIVE_MS = 10 * 60 * 1000;
const SUMMARY_CHARS = 200;

// Bounded reads

async function readRange(path, start, length, counters) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    if (counters) counters.bytesRead += bytesRead;
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await file.close();
  }
}

// Whole JSON objects only: a cut first or last line, or any other junk, is skipped.
function jsonLines(text, dropFirst = false) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  const objects = [];
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      objects.push(JSON.parse(line));
    } catch {
      // not a whole line, or not JSON
    }
  }
  return objects;
}

// A top-level string field out of JSON that may be cut off before it closes.
function fieldOf(text, name) {
  const m = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
}

function asString(value) {
  return typeof value === 'string' ? value : null;
}

function oneLine(text) {
  if (typeof text !== 'string') return null;
  const line = text.split('\n').find((l) => l.trim());
  if (!line) return null;
  const trimmed = line.trim();
  return trimmed.length > SUMMARY_CHARS ? `${trimmed.slice(0, SUMMARY_CHARS)}...` : trimmed;
}

// Summaries of tool input

const INPUT_KEYS = ['command', 'cmd', 'file_path', 'notebook_path', 'path', 'pattern', 'query', 'url', 'description', 'task_name', 'skill', 'prompt', 'target', 'to', 'message'];

function summarizeInput(input) {
  if (typeof input === 'string') return oneLine(input);
  if (Array.isArray(input)) return oneLine(input.filter((part) => typeof part === 'string').join(' '));
  if (input === null || typeof input !== 'object') return null;
  for (const key of INPUT_KEYS) {
    const summary = typeof input[key] === 'string' || Array.isArray(input[key]) ? summarizeInput(input[key]) : null;
    if (summary) return summary;
  }
  const first = Object.values(input).find((value) => typeof value === 'string');
  return first ? oneLine(first) : null;
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const block = content.find((b) => typeof b?.text === 'string');
  return block ? block.text : null;
}

// Claude Code: one transcript

export function parseClaudeHead(text) {
  const head = { cwd: fieldOf(text, 'cwd'), firstWords: null };
  for (const line of jsonLines(text)) {
    if (line.type !== 'user' || line.isMeta) continue;
    const words = textOfContent(line.message?.content)?.trim();
    if (words && !words.startsWith('<')) {
      head.firstWords = oneLine(words);
      break;
    }
  }
  return head;
}

export function parseClaudeTail(lines) {
  const out = { title: null, lastPrompt: null, cwd: null, tool: null, turnEndedAt: null };
  for (const line of lines) {
    if (typeof line.cwd === 'string') out.cwd = line.cwd;
    if (line.type === 'ai-title') out.title = asString(line.aiTitle) ?? out.title;
    else if (line.type === 'custom-title') out.title = asString(line.customTitle) ?? out.title;
    else if (line.type === 'last-prompt') out.lastPrompt = oneLine(line.lastPrompt) ?? out.lastPrompt;
    else if (line.type === 'assistant') {
      const stop = line.message?.stop_reason;
      out.turnEndedAt = stop === 'end_turn' || stop === 'stop_sequence' ? asString(line.timestamp) : null;
      const blocks = line.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block?.type !== 'tool_use') continue;
        out.tool = { id: block.id, name: asString(block.name), summary: summarizeInput(block.input), at: asString(line.timestamp), pending: true };
      }
    } else if (line.type === 'user') {
      out.turnEndedAt = null;
      const blocks = line.message?.content;
      if (!Array.isArray(blocks) || !out.tool) continue;
      if (blocks.some((block) => block?.type === 'tool_result' && block.tool_use_id === out.tool.id)) out.tool.pending = false;
    }
  }
  return out;
}

// Codex: one rollout

export function parseCodexMeta(text, file) {
  const firstLine = text.split('\n', 1)[0];
  const understood = firstLine.includes('"session_meta"');
  return {
    understood,
    id: (understood && fieldOf(firstLine, 'id')) || (/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/.exec(file)?.[1] ?? file),
    parent: understood ? fieldOf(firstLine, 'parent_thread_id') : null,
    cwd: understood ? fieldOf(firstLine, 'cwd') : null,
    nickname: understood ? fieldOf(firstLine, 'agent_nickname') : null,
    role: understood ? fieldOf(firstLine, 'agent_role') : null,
    task: understood ? (fieldOf(firstLine, 'agent_path')?.split('/').pop() ?? null) : null,
  };
}

// The code-mode `exec` tool takes a script; what it calls is the useful part.
function codexTool(payload, at) {
  let name = asString(payload.name) ?? asString(payload.type);
  let summary = null;
  const raw = payload.input ?? payload.arguments ?? payload.action;
  if (typeof raw === 'string') {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // free text, such as the script of `exec` or a patch
    }
    if (parsed !== null && typeof parsed === 'object') summary = summarizeInput(parsed);
    else {
      const call = /tools\.(\w+)\(\{?\s*(?:cmd:\s*)?(.*)/s.exec(raw);
      if (call) name = call[1];
      // Inside the script, the argument is itself a quoted string with \n in it.
      const quoted = call && /^(["'`])((?:[^\\]|\\.)*?)\1/s.exec(call[2]);
      const patched = /\*\*\* (?:Update|Add|Delete) File: ([^\\\n]+)/.exec(raw);
      summary = oneLine(patched ? patched[1] : quoted ? quoted[2].replaceAll('\\n', '\n') : call ? call[2] : raw);
    }
  } else summary = summarizeInput(raw);
  return { id: asString(payload.call_id), name, summary, at, pending: true };
}

export function parseCodexTail(lines) {
  const out = { title: null, cwd: null, tool: null, turnEndedAt: null };
  for (const line of lines) {
    const payload = line.payload;
    if (payload === null || typeof payload !== 'object') continue;
    const at = asString(line.timestamp);
    if (line.type === 'turn_context') out.cwd = asString(payload.cwd) ?? out.cwd;
    else if (line.type === 'event_msg') {
      if (payload.type === 'task_complete' || payload.type === 'turn_aborted') out.turnEndedAt = at;
      else if (payload.type === 'task_started') out.turnEndedAt = null;
      else if (payload.type === 'thread_name_updated') out.title = asString(payload.thread_name) ?? out.title;
    } else if (line.type === 'response_item' && typeof payload.type === 'string') {
      if (payload.type.endsWith('_call')) out.tool = codexTool(payload, at);
      else if (payload.type.endsWith('_call_output') && out.tool && payload.call_id === out.tool.id) out.tool.pending = false;
    }
  }
  return out;
}

// The first thing the thread was asked, past the instructions injected ahead of it.
export function parseCodexTitle(lines) {
  for (const line of lines) {
    const payload = line.payload;
    if (payload === null || typeof payload !== 'object') continue;
    let text = null;
    if (line.type === 'event_msg' && payload.type === 'user_message') text = asString(payload.message);
    else if (line.type === 'response_item' && payload.type === 'agent_message') text = textOfContent(payload.content);
    else if (line.type === 'response_item' && payload.type === 'message' && payload.role === 'user') text = textOfContent(payload.content);
    if (!text || /^\s*(# AGENTS\.md|<environment_context|<permissions|<user_instructions)/.test(text)) continue;
    const task = /^Message Type:[^]*?\nPayload:\n/.exec(text); // what a parent sends a subagent
    const words = oneLine((task ? text.slice(task[0].length) : text).replace(/^\s*<[^>\n]*>\s*/, ''));
    if (words) return words;
  }
  return null;
}

// The index

const slugOf = (path) => path.replace(/[^A-Za-z0-9]/g, '-');

async function eachLimit(items, limit, work) {
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

async function listDir(path, options) {
  return readdir(path, options).catch(() => []);
}

export function createSessionIndex({ claudeDir = join(homedir(), '.claude'), codexDir = join(homedir(), '.codex') } = {}) {
  const claude = new Map(); // transcript path -> entry
  const codex = new Map(); // rollout path -> entry
  const codexById = new Map();
  const counters = { bytesRead: 0, tailReads: 0 };
  let codexScan = null;
  let codexScanned = false;

  // Refresh size and mtime. A file quiet for an hour is looked at once a minute.
  async function refresh(entry, now) {
    if (entry.statAt && entry.mtimeMs && now - entry.mtimeMs > COLD_AFTER_MS && now - entry.statAt < COLD_STAT_MS) return;
    entry.statAt = now;
    try {
      const info = await stat(entry.path);
      entry.mtimeMs = info.mtimeMs;
      entry.size = info.size;
    } catch {
      entry.gone = true;
    }
  }

  // Re-read the tail only when the file has changed since the last read.
  async function readTail(entry, parse) {
    if (!entry.path || entry.gone || (entry.tailMtime === entry.mtimeMs && entry.tailSize === entry.size)) return;
    entry.tailMtime = entry.mtimeMs;
    entry.tailSize = entry.size;
    try {
      let parsed = null;
      for (const step of TAIL_STEPS) {
        const start = Math.max(0, entry.size - step);
        counters.tailReads++;
        const text = await readRange(entry.path, start, entry.size - start, counters);
        parsed = parse(jsonLines(text, start > 0));
        if (parsed.tool || start === 0) break;
      }
      // What a narrower tail no longer holds is still the last thing seen.
      entry.tool = parsed.tool ?? entry.tool ?? null;
      entry.title = parsed.title ?? entry.title ?? null;
      entry.lastPrompt = parsed.lastPrompt ?? entry.lastPrompt ?? null;
      entry.cwdNow = parsed.cwd ?? entry.cwdNow ?? null;
      entry.turnEndedAt = parsed.turnEndedAt;
    } catch {
      // unreadable right now; what was known stands
    }
  }

  // Claude Code

  async function indexClaude(now) {
    const root = join(claudeDir, 'projects');
    for (const dir of await listDir(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const name of await listDir(join(root, dir.name))) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(root, dir.name, name);
        if (!claude.has(path)) claude.set(path, { agent: 'claude', id: name.slice(0, -6), path, dir: dir.name, children: new Map() });
      }
    }
    await eachLimit([...claude.values()], 16, async (entry) => {
      await refresh(entry, now);
      if (entry.gone) return void claude.delete(entry.path);
      if (entry.headDone || entry.headMtime === entry.mtimeMs) return;
      entry.headMtime = entry.mtimeMs;
      try {
        const head = parseClaudeHead(await readRange(entry.path, 0, Math.min(entry.size, CLAUDE_HEAD), counters));
        entry.cwd = head.cwd;
        entry.firstWords = head.firstWords;
        entry.headDone = Boolean(head.cwd && head.firstWords) || entry.size >= CLAUDE_HEAD;
      } catch {
        // gone or unreadable; looked at again when it changes
      }
    });
  }

  async function readClaudeSessionFiles() {
    const files = new Map(); // session id -> what the file says
    const dir = join(claudeDir, 'sessions');
    for (const name of await listDir(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const file = JSON.parse(await readFile(join(dir, name), 'utf8'));
        if (typeof file.sessionId !== 'string' || !Number.isInteger(file.pid)) continue;
        files.set(file.sessionId, {
          pid: file.pid,
          sessionId: file.sessionId,
          cwd: asString(file.cwd),
          status: asString(file.status),
          startedAt: typeof file.startedAt === 'number' ? file.startedAt : null,
        });
      } catch {
        // being rewritten, or a format we do not know
      }
    }
    return files;
  }

  // Subagents sit in <session>/subagents, and workflow agents one or two levels below.
  async function indexClaudeSubagents(session, now, relist) {
    if (relist) {
      const walk = async (dir, depth) => {
        for (const item of await listDir(dir, { withFileTypes: true })) {
          const path = join(dir, item.name);
          if (item.isDirectory() && depth < 2) await walk(path, depth + 1);
          else if (item.isFile() && /^agent-.*\.jsonl$/.test(item.name) && !session.children.has(path)) {
            session.children.set(path, { agent: 'claude', id: item.name.replace(/^agent-|\.jsonl$/g, ''), path });
          }
        }
      };
      await walk(`${session.path.slice(0, -'.jsonl'.length)}/subagents`, 0);
    }
    await eachLimit([...session.children.values()], 16, async (child) => {
      await refresh(child, now);
      if (child.gone) session.children.delete(child.path);
    });
  }

  async function describeClaudeSubagent(child) {
    if (!child.metaRead) {
      child.metaRead = true;
      try {
        const meta = JSON.parse(await readFile(child.path.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
        child.kind = asString(meta.agentType);
        child.title = asString(meta.description);
      } catch {
        // no meta file, or a format we do not know
      }
    }
    const metaTitle = child.title;
    await readTail(child, parseClaudeTail);
    child.title = metaTitle ?? child.title;
  }

  // Codex: heads never change, so each rollout's first 4 KB is read once.

  async function addRollout(path, name) {
    try {
      const meta = parseCodexMeta(await readRange(path, 0, CODEX_META_HEAD, counters), name);
      const entry = { agent: 'codex', path, ...meta, kind: meta.role };
      codex.set(path, entry);
      codexById.set(meta.id, entry);
    } catch {
      // gone already
    }
  }

  async function scanCodex(newestOnly) {
    const root = join(codexDir, 'sessions');
    const dayDirs = [];
    for (const year of (await listDir(root)).sort().reverse()) {
      for (const month of (await listDir(join(root, year))).sort().reverse()) {
        for (const day of (await listDir(join(root, year, month))).sort().reverse()) dayDirs.push(join(root, year, month, day));
        if (newestOnly && dayDirs.length >= 2) break;
      }
      if (newestOnly && dayDirs.length >= 2) break;
    }
    for (const dir of newestOnly ? dayDirs.slice(0, 2) : dayDirs) {
      const fresh = (await listDir(dir)).filter((name) => name.endsWith('.jsonl') && !codex.has(join(dir, name))).sort().reverse();
      await eachLimit(fresh, 16, (name) => addRollout(join(dir, name), name));
    }
  }

  // The first scan reads thousands of small heads, so it runs beside the polls,
  // newest first, and the list fills in from the top.
  function keepCodexIndexed() {
    if (!codexScan) {
      codexScan = scanCodex(false)
        .catch(() => {})
        .then(() => {
          codexScanned = true;
        });
    }
    return codexScanned ? scanCodex(true).catch(() => {}) : Promise.resolve();
  }

  function codexGroups(scope) {
    const groups = new Map();
    for (const entry of codex.values()) {
      let root = entry;
      let missing = null;
      for (let hops = 0; hops < 32 && root.parent; hops++) {
        const up = codexById.get(root.parent);
        if (!up) {
          missing = root.parent;
          break;
        }
        root = up;
      }
      const key = missing ?? root.id;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { root: missing ? { agent: 'codex', id: missing, path: null } : root, children: [], inScope: false }));
      if (entry !== group.root) group.children.push(entry);
      if (inScope(scope, entry.cwd)) group.inScope = true;
    }
    return [...groups.values()].filter((group) => group.inScope);
  }

  async function describeCodex(entry) {
    await readTail(entry, parseCodexTail);
    if (!entry.path || entry.gone || entry.titleDone || entry.titleSize === entry.size) return;
    entry.titleSize = entry.size;
    try {
      const head = await readRange(entry.path, 0, Math.min(entry.size, CODEX_TITLE_HEAD), counters);
      entry.firstWords = parseCodexTitle(jsonLines(head));
      entry.titleDone = Boolean(entry.firstWords) || entry.size >= CODEX_TITLE_HEAD;
    } catch {
      // gone or unreadable
    }
  }

  // The result

  function publicEntry(entry) {
    const { tool } = entry;
    return {
      agent: entry.agent,
      id: entry.id,
      kind: entry.kind ?? null,
      nickname: entry.nickname ?? null,
      title: entry.title ?? entry.firstWords ?? entry.task ?? entry.lastPrompt ?? null,
      cwd: entry.cwdNow ?? entry.cwd ?? null,
      mtimeMs: entry.mtimeMs ?? null,
      size: entry.size ?? null,
      tool: tool ? { name: tool.name, summary: tool.summary, at: tool.at, pending: tool.pending } : null,
      turnEndedAt: entry.turnEndedAt ?? null,
    };
  }

  // update() takes the process table and what lsof said, so that all of this can be
  // tried on fixtures. table: ps rows. cwds: pid -> cwd. open: pid -> open files.
  async function update({ scope, table, cwds = new Map(), open: openByPid = new Map() }) {
    const now = Date.now();
    const rows = new Map(table.map((row) => [row.pid, row]));

    await indexClaude(now);
    await keepCodexIndexed();
    const sessionFiles = await readClaudeSessionFiles();

    // Which codex process holds which rollout open
    const rolloutHolders = new Map();
    for (const [pid, files] of openByPid) {
      for (const file of files) {
        if (file.name && /\/rollout-[^/]*\.jsonl$/.test(file.name)) rolloutHolders.set(file.name, pid);
      }
    }
    const holder = (entry) => {
      const pid = rolloutHolders.get(entry.path);
      return pid === undefined ? null : { pid, command: rows.get(pid)?.command ?? null, via: 'open rollout' };
    };

    const sessions = [];
    const claimed = new Set();
    const scopeSlugs = new Set(scope.map(slugOf));

    // Claude Code sessions: a transcript started here, or a session file that says here
    const seen = new Set();
    for (const entry of claude.values()) {
      const file = sessionFiles.get(entry.id);
      // The directory name is ambiguous (/a/b-c and /a/b/c share one), so it only decides when no cwd could be read.
      if (!inScope(scope, entry.cwd) && !inScope(scope, file?.cwd) && (entry.cwd || !scopeSlugs.has(entry.dir))) continue;
      seen.add(entry.id);
      sessions.push({ entry, file });
    }
    for (const file of sessionFiles.values()) {
      if (seen.has(file.sessionId) || !inScope(scope, file.cwd)) continue;
      sessions.push({ entry: { agent: 'claude', id: file.sessionId, path: null, cwd: file.cwd, children: new Map() }, file });
    }

    const groups = [];
    for (const { entry, file } of sessions) {
      const row = file ? rows.get(file.pid) : null;
      // A pid can be reused; a process younger than the session file is not its process.
      const present = row && !(file.startedAt && row.startedAt > file.startedAt + 60000);
      const hot = present || !entry.mtimeMs || now - entry.mtimeMs < COLD_AFTER_MS;
      const relist = entry.path && (hot || !entry.listedAt || now - entry.listedAt > COLD_STAT_MS);
      if (relist) entry.listedAt = now;
      if (entry.path) await indexClaudeSubagents(entry, now, relist);
      if (present) claimed.add(file.pid);
      groups.push({
        entry,
        children: [...entry.children.values()],
        sessionFile: file ? { pid: file.pid, status: file.status, present: Boolean(present) } : null,
        process: present ? { pid: file.pid, command: row.command, via: 'session file' } : null,
        describe: (e) => (e === entry ? readTail(e, parseClaudeTail) : describeClaudeSubagent(e)),
      });
    }

    // Codex threads, grouped under their top thread
    const inScopeCodex = codexGroups(scope);
    await eachLimit(inScopeCodex.flatMap((group) => [group.root, ...group.children]).filter((e) => e.path), 16, async (entry) => {
      await refresh(entry, now);
      if (entry.gone) {
        codex.delete(entry.path);
        codexById.delete(entry.id);
      }
    });
    for (const group of inScopeCodex) {
      const held = holder(group.root);
      if (held) claimed.add(held.pid);
      for (const child of group.children) {
        const pid = rolloutHolders.get(child.path);
        if (pid !== undefined) claimed.add(pid);
      }
      groups.push({
        entry: group.root,
        children: group.children,
        sessionFile: null,
        process: held,
        missingParent: group.root.path === null,
        describe: describeCodex,
      });
    }

    for (const group of groups) {
      group.latest = group.children.reduce((most, child) => Math.max(most, child.mtimeMs ?? 0), group.entry.mtimeMs ?? 0);
    }
    groups.sort((a, b) => Number(Boolean(b.process)) - Number(Boolean(a.process)) || b.latest - a.latest);

    const shown = groups.slice(0, MAX_SESSIONS);
    const result = new Array(shown.length);
    await eachLimit([...shown.keys()], 4, async (i) => {
      const group = shown[i];
      await group.describe(group.entry);
      const children = group.children
        .slice()
        .sort((a, b) => Number(rolloutHolders.has(b.path)) - Number(rolloutHolders.has(a.path)) || (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
      const top = children.slice(0, MAX_SUBAGENTS);
      for (const child of top) await group.describe(child);
      result[i] = {
        ...publicEntry(group.entry),
        process: group.process,
        sessionFile: group.sessionFile,
        missingParent: group.missingParent ?? false,
        subagents: {
          total: children.length,
          active: children.filter((c) => c.mtimeMs && now - c.mtimeMs < ACTIVE_MS).length,
          shown: top.map((child) => ({ ...publicEntry(child), process: holder(child) })),
        },
      };
    });

    // Agent processes here that no session file or open rollout ties to a session
    const unattached = [];
    for (const row of table) {
      const agent = agentOf(row.command);
      if (agent && !claimed.has(row.pid) && inScope(scope, cwds.get(row.pid))) {
        unattached.push({ agent, pid: row.pid, command: row.command, cwd: cwds.get(row.pid), startedAt: row.startedAt });
      }
    }

    return {
      scope,
      sessions: result,
      hiddenSessions: groups.length - shown.length,
      unattached,
      sources: {
        claude: { transcripts: claude.size, noCwd: [...claude.values()].filter((e) => !e.cwd).length, sessionFiles: sessionFiles.size },
        codex: {
          rollouts: codex.size,
          notUnderstood: [...codex.values()].filter((e) => !e.understood).length,
          scanning: !codexScanned,
        },
      },
    };
  }

  return { update, counters, codexScanDone: () => codexScan };
}
