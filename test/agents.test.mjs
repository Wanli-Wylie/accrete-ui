import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, truncateSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createSessionIndex, parseClaudeTail, parseCodexMeta, parseCodexTail, parseCodexTitle } from '../server/agent-sessions.mjs';
import { agentOf } from '../server/processes.mjs';

const base = mkdtempSync(join(tmpdir(), 'accrete-ui-agents-'));
after(() => rmSync(base, { recursive: true, force: true }));

function home() {
  const dir = mkdtempSync(join(base, 'home-'));
  const claudeDir = join(dir, 'claude');
  const codexDir = join(dir, 'codex');
  mkdirSync(join(claudeDir, 'projects'), { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'), { recursive: true });
  mkdirSync(join(codexDir, 'sessions/2026/11/03'), { recursive: true });
  return { claudeDir, codexDir };
}

const jsonl = (...lines) => `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`;
const slug = (path) => path.replace(/[^A-Za-z0-9]/g, '-');

function claudeTranscript({ claudeDir }, cwd, id, lines) {
  const dir = join(claudeDir, 'projects', slug(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, jsonl(...lines));
  return path;
}

const userLine = (cwd, text) => ({ type: 'user', cwd, timestamp: '2026-11-03T10:00:00.000Z', message: { role: 'user', content: text } });
const toolLine = (cwd, id, name, input) => ({
  type: 'assistant',
  cwd,
  timestamp: '2026-11-03T10:00:05.000Z',
  message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] },
});
const resultLine = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

function rollout({ codexDir }, name, meta, lines = []) {
  const path = join(codexDir, 'sessions/2026/11/03', name);
  writeFileSync(path, jsonl({ type: 'session_meta', payload: meta }, ...lines));
  return path;
}

const ROOT = '/work/here';
const ps = (pid, command, startedAt = Date.now() - 1000) => ({ uid: 501, pid, ppid: 1, cpu: 0, rss: 0, state: 'S', tty: '??', startedAt, command });

async function update(dirs, options = {}) {
  const index = createSessionIndex(dirs);
  const run = (more = {}) => index.update({ scope: [ROOT], table: [], ...options, ...more });
  await run();
  await index.codexScanDone();
  return { index, run, result: await run() };
}

test('a Claude session: title, cwd, last tool and whether it has its result', async () => {
  const dirs = home();
  claudeTranscript(dirs, ROOT, 'aaa', [
    { type: 'mode', mode: 'normal', sessionId: 'aaa' },
    userLine(ROOT, 'Please run the suite\nand report'),
    toolLine(ROOT, 't1', 'Read', { file_path: '/work/here/a.txt' }),
    resultLine('t1'),
    toolLine(`${ROOT}/sub`, 't2', 'Bash', { command: 'npm test\necho done', description: 'run' }),
  ]);
  const { result } = await update(dirs);
  assert.equal(result.sessions.length, 1);
  const [session] = result.sessions;
  assert.equal(session.agent, 'claude');
  assert.equal(session.title, 'Please run the suite');
  assert.equal(session.cwd, `${ROOT}/sub`);
  assert.deepEqual(session.tool, { name: 'Bash', summary: 'npm test', at: '2026-11-03T10:00:05.000Z', pending: true });
  assert.equal(session.process, null);
});

test('an ai-title wins over first words, a finished tool is not pending, and an end_turn is seen', () => {
  const tail = parseClaudeTail([
    { type: 'ai-title', aiTitle: 'Short title' },
    toolLine(ROOT, 't1', 'Grep', { pattern: 'foo' }),
    resultLine('t1'),
    { type: 'assistant', timestamp: '2026-11-03T10:01:00.000Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
  ]);
  assert.equal(tail.title, 'Short title');
  assert.equal(tail.tool.name, 'Grep');
  assert.equal(tail.tool.summary, 'foo');
  assert.equal(tail.tool.pending, false);
  assert.equal(tail.turnEndedAt, '2026-11-03T10:01:00.000Z');
});

test('Claude subagents and workflow agents are listed, journals are not', async () => {
  const dirs = home();
  const transcript = claudeTranscript(dirs, ROOT, 'bbb', [userLine(ROOT, 'go')]);
  const subagents = `${transcript.slice(0, -'.jsonl'.length)}/subagents`;
  mkdirSync(join(subagents, 'workflows/wf_1'), { recursive: true });
  writeFileSync(join(subagents, 'agent-s1.jsonl'), jsonl(toolLine(ROOT, 'x', 'Edit', { file_path: '/work/here/b' })));
  writeFileSync(join(subagents, 'agent-s1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Do the thing' }));
  writeFileSync(join(subagents, 'workflows/wf_1/agent-w1.jsonl'), jsonl(userLine(ROOT, 'step')));
  writeFileSync(join(subagents, 'workflows/wf_1/journal.jsonl'), jsonl({ type: 'x' }));
  const { result } = await update(dirs);
  const { total, shown } = result.sessions[0].subagents;
  assert.equal(total, 2);
  const named = shown.find((child) => child.id === 's1');
  assert.equal(named.kind, 'general-purpose');
  assert.equal(named.title, 'Do the thing');
  assert.equal(named.tool.summary, '/work/here/b');
  assert.ok(shown.some((child) => child.id === 'w1'));
});

test('liveness comes from the session file and the process table', async () => {
  const dirs = home();
  claudeTranscript(dirs, ROOT, 'live', [userLine(ROOT, 'one')]);
  claudeTranscript(dirs, ROOT, 'dead', [userLine(ROOT, 'two')]);
  claudeTranscript(dirs, ROOT, 'reused', [userLine(ROOT, 'three')]);
  const now = Date.now();
  const file = (pid, sessionId, startedAt, status) =>
    writeFileSync(join(dirs.claudeDir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: ROOT, startedAt, status, statusUpdatedAt: now }));
  file(100, 'live', now - 5000, 'busy');
  file(200, 'dead', now - 5000, 'idle');
  file(300, 'reused', now - 3600000, 'idle'); // this pid now belongs to a younger process
  writeFileSync(join(dirs.claudeDir, 'sessions', '999.key'), 'never read');
  const table = [ps(100, 'claude', now - 6000), ps(300, 'some-other-program', now - 1000)];
  const { result } = await update(dirs, { table });
  const by = Object.fromEntries(result.sessions.map((session) => [session.id, session]));
  assert.deepEqual(by.live.process, { pid: 100, command: 'claude', via: 'session file' });
  assert.equal(by.live.sessionFile.status, 'busy');
  assert.equal(by.dead.process, null);
  assert.equal(by.dead.sessionFile.present, false);
  assert.equal(by.reused.process, null);
  assert.equal(result.sessions[0].id, 'live', 'sessions with a process come first');
});

test('a session file with no transcript yet still shows, and a stray agent process is reported as such', async () => {
  const dirs = home();
  const now = Date.now();
  writeFileSync(join(dirs.claudeDir, 'sessions', '100.json'), JSON.stringify({ pid: 100, sessionId: 'fresh', cwd: ROOT, startedAt: now, status: 'idle' }));
  const table = [ps(100, 'claude', now - 1000), ps(200, '/opt/bin/codex', now - 1000), ps(300, 'codex', now - 1000)];
  const cwds = new Map([[100, ROOT], [200, `${ROOT}/deep`], [300, '/elsewhere']]);
  const { result } = await update(dirs, { table, cwds });
  assert.equal(result.sessions[0].id, 'fresh');
  assert.equal(result.sessions[0].mtimeMs, null);
  assert.equal(result.sessions[0].process.pid, 100);
  assert.deepEqual(result.unattached.map((proc) => proc.pid), [200]);
});

test('scope is by path, not by name', async () => {
  const dirs = home();
  claudeTranscript(dirs, ROOT, 'in', [userLine(ROOT, 'in')]);
  claudeTranscript(dirs, `${ROOT}/below`, 'below', [userLine(`${ROOT}/below`, 'below')]);
  claudeTranscript(dirs, `${ROOT}-lookalike`, 'out', [userLine(`${ROOT}-lookalike`, 'out')]);
  // /work/here/x and /work/here-x share a slug; the cwd in the transcript decides.
  claudeTranscript(dirs, `${ROOT}/x`, 'x1', [userLine(`${ROOT}/x`, 'x')]);
  rollout(dirs, 'rollout-a.jsonl', { id: 'c-in', cwd: `${ROOT}/below` });
  rollout(dirs, 'rollout-b.jsonl', { id: 'c-out', cwd: `${ROOT}-lookalike` });
  const { result } = await update(dirs);
  const ids = result.sessions.map((session) => session.id).sort();
  assert.deepEqual(ids, ['below', 'c-in', 'in', 'x1']);
});

test('a Codex thread: meta, tool, turn end, subagents under their top thread, and open-rollout evidence', async () => {
  const dirs = home();
  const top = rollout(dirs, 'rollout-2026-11-03T10-00-00-aaaaaaaa-0000-7000-8000-000000000001.jsonl', { id: 'top', cwd: ROOT, source: 'cli' }, [
    { timestamp: 't0', type: 'event_msg', payload: { type: 'user_message', message: 'Tidy the report' } },
    { timestamp: 't1', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: 't2', type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls -la'] }) } },
    { timestamp: 't3', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } },
    { timestamp: 't4', type: 'event_msg', payload: { type: 'task_complete' } },
  ]);
  const child = rollout(dirs, 'rollout-b.jsonl', { id: 'kid', parent_thread_id: 'top', cwd: '/other/place', agent_nickname: 'Noether', agent_role: 'reader' }, [
    { timestamp: 't5', type: 'response_item', payload: { type: 'agent_message', content: [{ text: 'Message Type: NEW_TASK\nTask name: /root/x\nPayload:\n\nRead the paper' }] } },
    { timestamp: 't6', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'const r = await tools.exec_command({cmd:"rg -n foo\\nmore",max_output_tokens:100}); text(r.output);' } },
  ]);
  rollout(dirs, 'rollout-c.jsonl', { id: 'grandkid', parent_thread_id: 'kid', cwd: ROOT });
  const table = [ps(50, '/x/bin/codex app-server --listen unix://')];
  const open = new Map([[50, [{ name: top }, { name: child }, { name: '/x/state.sqlite' }]]]);
  const { result } = await update(dirs, { table, open });
  assert.equal(result.sessions.length, 1);
  const [session] = result.sessions;
  assert.equal(session.id, 'top');
  assert.equal(session.title, 'Tidy the report');
  assert.deepEqual(session.process, { pid: 50, command: '/x/bin/codex app-server --listen unix://', via: 'open rollout' });
  assert.equal(session.tool.summary, 'bash -lc ls -la');
  assert.equal(session.tool.pending, false);
  assert.equal(session.turnEndedAt, 't4');
  assert.equal(session.subagents.total, 2);
  const kid = session.subagents.shown.find((item) => item.id === 'kid');
  assert.equal(kid.nickname, 'Noether');
  assert.equal(kid.kind, 'reader');
  assert.equal(kid.title, 'Read the paper');
  assert.equal(kid.tool.name, 'exec_command');
  assert.equal(kid.tool.summary, 'rg -n foo');
  assert.equal(kid.tool.pending, true);
  assert.equal(kid.process.pid, 50);
});

test('a subagent in scope brings its top thread, even one with no rollout left', async () => {
  const dirs = home();
  rollout(dirs, 'rollout-a.jsonl', { id: 'kid', parent_thread_id: 'vanished', cwd: ROOT });
  const { result } = await update(dirs);
  assert.equal(result.sessions[0].id, 'vanished');
  assert.equal(result.sessions[0].missingParent, true);
  assert.equal(result.sessions[0].subagents.total, 1);
});

test('session_meta fields come out of a line cut off before it closes', () => {
  const meta = parseCodexMeta('{"type":"session_meta","payload":{"creator_user_id":"u","session_id":"s","id":"the-id","parent_thread_id":"p","cwd":"/a \\"b\\"","base_instructions":{"text":"lots', 'f.jsonl');
  assert.equal(meta.understood, true);
  assert.equal(meta.id, 'the-id');
  assert.equal(meta.parent, 'p');
  assert.equal(meta.cwd, '/a "b"');
  const named = parseCodexMeta('{"type":"session_meta","payload":{"id":"i","agent_path":"/root/read_x","base', 'f.jsonl');
  assert.equal(named.task, 'read_x');
});

test('files in a format nobody knows give unknowns and never throw', async () => {
  const dirs = home();
  const garbage = [
    'not json at all',
    '{"type":"assistant","message":null}',
    '{"type":"assistant","message":{"content":"text not blocks"}}',
    '{"type":"assistant","message":{"content":[null,7,{"type":"tool_use"}]}}',
    '{"type":"user","message":{"content":[null]}}',
    '{"type":"user","message":{"content":42},"cwd":17}',
    '{"type":"ai-title","aiTitle":[1,2]}',
    '{"payload":null,"type":"response_item"}',
    '{"payload":{"type":7},"type":"response_item"}',
    '{"payload":{"type":"function_call","arguments":"{broken"},"type":"response_item"}',
    '{"unterminated":',
    '[1,2,3]',
    '\u0000\u0001\u0002 binary',
  ];
  const dir = join(dirs.claudeDir, 'projects', slug(ROOT));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'garbage.jsonl'), garbage.join('\n'));
  writeFileSync(join(dir, 'empty.jsonl'), '');
  writeFileSync(join(dirs.claudeDir, 'sessions', '1.json'), '{not json');
  writeFileSync(join(dirs.claudeDir, 'sessions', '2.json'), JSON.stringify({ pid: 'nope' }));
  writeFileSync(join(dirs.codexDir, 'sessions/2026/11/03/rollout-g.jsonl'), garbage.join('\n'));
  writeFileSync(join(dirs.codexDir, 'sessions/2026/11/03/rollout-e.jsonl'), '');

  const { result } = await update(dirs);
  assert.equal(result.sources.codex.notUnderstood, 2);
  // No working directory could be read, so the directory name places them.
  const session = result.sessions.find((item) => item.id === 'garbage');
  assert.equal(session.title, null);
  assert.equal(session.subagents.total, 0);

  assert.doesNotThrow(() => parseCodexTail(garbage.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })));
  assert.doesNotThrow(() => parseCodexTitle([{ payload: { type: 'agent_message', content: 'oops' }, type: 'response_item' }]));
  assert.doesNotThrow(() => parseClaudeTail([{ type: 'assistant', message: { content: [{ type: 'tool_use', input: 7 }] } }]));
});

test('reads are bounded on a huge file, and only changed files are read again', async () => {
  const dirs = home();
  const path = claudeTranscript(dirs, ROOT, 'huge', [userLine(ROOT, 'start')]);
  const twoGigabytes = 2 * 1024 ** 3;
  truncateSync(path, twoGigabytes);
  const fd = openSync(path, 'r+');
  writeSync(fd, `\n${JSON.stringify(toolLine(ROOT, 'end', 'Bash', { command: 'tail me' }))}\n`, twoGigabytes);
  closeSync(fd);

  const { index, run, result } = await update(dirs);
  assert.equal(result.sessions[0].tool.summary, 'tail me');
  const afterFirst = { ...index.counters };
  assert.ok(afterFirst.bytesRead < 8 * 1024 * 1024, `read ${afterFirst.bytesRead} bytes`);

  await run();
  assert.equal(index.counters.tailReads, afterFirst.tailReads, 'an unchanged file is not read again');

  const later = new Date(Date.now() + 5000);
  utimesSync(path, later, later);
  await run();
  assert.ok(index.counters.tailReads > afterFirst.tailReads, 'a changed file is');
});

test('no agent directories at all is an empty answer', async () => {
  const missing = join(base, 'nowhere');
  const { result } = await update({ claudeDir: missing, codexDir: missing });
  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.unattached, []);
});

test('only agent executables count as agents', () => {
  assert.equal(agentOf('claude'), 'claude');
  assert.equal(agentOf('/opt/homebrew/bin/claude --resume x'), 'claude');
  assert.equal(agentOf('node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'), 'claude');
  assert.equal(agentOf('/opt/homebrew/Caskroom/codex/0.166.0/bin/codex'), 'codex');
  assert.equal(agentOf('/x/bin/codex app-server --listen unix://'), 'codex');
  assert.equal(agentOf('/x/bin/codex-code-mode-host'), null);
  assert.equal(agentOf('node /Users/me/.claude/hooks/log.js'), null);
  assert.equal(agentOf('/Applications/Claude.app/Contents/MacOS/Claude'), null);
  assert.equal(agentOf('vim claude'), null);
});
