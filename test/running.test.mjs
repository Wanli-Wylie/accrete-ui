import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseLsof, parsePs } from '../server/processes.mjs';
import { inScope } from '../server/scope.mjs';
import { createRunning, foldIdentical, readLogTail, selectProcesses, writtenFiles } from '../server/readers/running.mjs';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'accrete-ui-running-')));
const children = [];
after(() => {
  for (const child of children) child.kill('SIGKILL');
  rmSync(base, { recursive: true, force: true });
});

const row = (pid, ppid, command, cpu = 0) => ({ uid: 501, pid, ppid, cpu, rss: 1048576, state: 'S', tty: '??', startedAt: pid, command });
const ROOT = '/work/here';

function pick(rows, cwd, selfPid = 1) {
  const cwds = new Map(rows.map((one) => [one.pid, typeof cwd === 'function' ? cwd(one) : cwd]));
  return selectProcesses(rows, cwds, [ROOT], selfPid);
}

const pids = (nodes) => nodes.map((node) => node.pid);

test('ps lines parse, with spaces in the command', () => {
  const [first, second] = parsePs(
    '  501 68146 35077   8.4 473712 S+   ttys001  Tue Nov  3 22:03:57 2026     claude\n' +
      '    0     1     0   0.0  12288 Ss   ??       Mon Oct 13 01:02:03 2026     /sbin/launchd -x "a b"\n' +
      'garbage line\n',
  );
  assert.equal(first.pid, 68146);
  assert.equal(first.ppid, 35077);
  assert.equal(first.uid, 501);
  assert.equal(first.cpu, 8.4);
  assert.equal(first.rss, 473712 * 1024);
  assert.equal(first.command, 'claude');
  assert.equal(new Date(first.startedAt).getFullYear(), 2026);
  assert.equal(second.command, '/sbin/launchd -x "a b"');
});

test('lsof fields parse, and only regular files open for writing count', () => {
  const text = [
    'p10',
    'fcwd', 'a ', 'tDIR', 's96', 'n/work/here',
    'ftxt', 'a ', 'tREG', 's100', 'n/usr/bin/python3',
    'f0', 'ar', 'tCHR', 'n/dev/null',
    'f1', 'aw', 'tREG', 's211', 'n/work/here/run.log',
    'f2', 'au', 'tREG', 's211', 'n/work/here/\\xe6\\x97\\xa5 x.log',
    'f3', 'ar', 'tREG', 's5', 'n/work/here/input.txt',
    'f4', 'aw', 'tPIPE', 'n->0x1',
    'f5', 'aw', 'tREG', 's5', 'n/home/me/.codex/logs.sqlite',
    'p11',
    'fcwd', 'a ', 'tDIR', 'n/elsewhere',
    '',
  ].join('\n');
  const parsed = parseLsof(text);
  assert.equal(parsed.get(10)[0].name, '/work/here');
  assert.equal(parsed.get(11)[0].name, '/elsewhere');
  const names = writtenFiles(parsed.get(10), '/home/me').map((file) => file.name);
  assert.deepEqual(names, ['/work/here/run.log', '/work/here/日 x.log']);
});

test('only what is inside the scope counts, by whole path components', () => {
  const scope = ['/work/here'];
  assert.ok(inScope(scope, '/work/here'));
  assert.ok(inScope(scope, '/work/here/deep/down'));
  assert.ok(!inScope(scope, '/work/here-lookalike'));
  assert.ok(!inScope(scope, '/work'));
  assert.ok(!inScope(scope, undefined));
});

test('the server, tmux, what the readers run and idle shells are left out', () => {
  const rows = [
    row(1, 0, 'node /x/bin/accrete-ui.mjs --project /work/here'),
    row(2, 1, 'ps -axww -o uid='),
    row(3, 1, 'lsof -nP -p 1'),
    row(4, 1, '/opt/homebrew/bin/tmux new -A -s accrete-x'),
    row(5, 900, 'tmux: server'),
    row(6, 5, '-zsh'),
    row(7, 5, '/bin/zsh -l'),
    row(8, 5, '/bin/bash --noprofile --norc'),
    row(9, 5, '/bin/zsh -l', 50), // not idle, whatever its form
    row(10, 5, 'python run.py', 99),
  ];
  assert.deepEqual(pids(pick(rows, ROOT)), [9, 10]);
});

test('a plain shell the server started is still treated as a shell', () => {
  const rows = [row(1, 0, 'node server'), row(2, 1, '/bin/zsh'), row(3, 1, '/bin/zsh'), row(4, 3, 'make -j8')];
  const tree = pick(rows, ROOT);
  assert.deepEqual(pids(tree), [3]);
  assert.deepEqual(pids(tree[0].children), [4]);
});

test('a shell with a child doing work stays, and a shell running a script stays', () => {
  const rows = [
    row(10, 500, '-zsh'),
    row(11, 10, 'mpirun -n 4 ./model'),
    row(12, 11, './model', 98),
    row(20, 500, 'bash run.sh'),
    row(30, 500, '/bin/zsh -c make'),
    row(40, 500, '-zsh'),
    row(41, 40, '/bin/zsh -l'),
  ];
  const tree = pick(rows, ROOT);
  assert.deepEqual(pids(tree), [10, 20, 30]);
  assert.deepEqual(pids(tree[0].children), [11]);
  assert.deepEqual(pids(tree[0].children[0].children), [12]);
});

test('out of scope is out, and the tree closes over a process that is not shown', () => {
  const rows = [row(10, 500, 'python driver.py'), row(11, 10, 'helper'), row(12, 11, 'python worker.py'), row(50, 500, 'python other.py')];
  const tree = pick(rows, (one) => (one.pid === 11 ? '/elsewhere' : one.pid === 50 ? '/work/here-lookalike' : ROOT));
  assert.deepEqual(pids(tree), [10]);
  assert.deepEqual(pids(tree[0].children), [12]);
});

test('three or more identical quiet siblings fold; anything lone, busy or writing does not', () => {
  const node = (pid, command, extra = {}) => ({ pid, command, cpu: 0, rss: 1048576, writes: [], children: [], ...extra });
  const folded = foldIdentical([
    node(1, 'node_repl'),
    node(2, 'node_repl'),
    node(3, 'node_repl', { children: [node(30, 'child')] }),
    node(4, 'node_repl', { cpu: 50 }),
    node(5, 'node_repl', { writes: ['/x'] }),
    node(6, 'stuck-program'),
    node(7, 'twin'),
    node(8, 'twin'),
    node(9, 'parent', { children: [node(90, 'a'), node(91, 'a'), node(92, 'a')] }),
  ]);
  const one = folded.find((item) => item.pids);
  assert.deepEqual(one.pids, [1, 2, 3]);
  assert.equal(one.rss, 3 * 1048576);
  assert.deepEqual(pids(folded), [1, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(folded.at(-1).children[0].pids, [90, 91, 92]);
});

test('a text tail: last lines only, control sequences gone, progress bars at their last state', async () => {
  const path = join(base, 'run.log');
  const body = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  body.push('\x1b[32mgreen\x1b[0m', 'progress 10%\rprogress 90%\r', `${'x'.repeat(1000)}`);
  writeFileSync(path, `${body.join('\n')}\n`);
  const { lines } = await readLogTail(path, (await import('node:fs')).statSync(path).size);
  assert.equal(lines.length, 5);
  assert.deepEqual(lines.slice(0, 2), ['line 98', 'line 99']);
  assert.equal(lines[2], 'green');
  assert.equal(lines[3], 'progress 90%');
  assert.ok(lines[4].length < 500);
});

test('binary output is not shown, and huge files are read only at the end', async () => {
  const data = join(base, 'state.bin2');
  writeFileSync(data, Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)));
  assert.deepEqual(await readLogTail(data, 4096), { binary: true });
  const named = join(base, 'output.nc');
  writeFileSync(named, 'looks like text');
  assert.deepEqual(await readLogTail(named, 15), { binary: true });
  const huge = join(base, 'huge.log');
  writeFileSync(huge, `${'y'.repeat(1024 * 1024)}\nlast line\n`);
  const { lines } = await readLogTail(huge, 1024 * 1024 + 11);
  assert.deepEqual(lines, ['last line']);
});

test('a real program: seen with its log, then gone', { skip: process.platform !== 'darwin' }, async () => {
  const dir = realpathSync(mkdtempSync(join(base, 'ws-')));
  const child = spawn('/bin/sh', ['-c', 'echo first > run.log; echo second >> run.log; exec sleep 30 >> run.log 2>&1'], { cwd: dir, stdio: 'ignore' });
  children.push(child);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const running = createRunning({ selfPid: -1 });
  const state = await running.poll([dir]);
  const node = state.roots.find((item) => item.pid === child.pid);
  assert.ok(node, 'the child is in the tree');
  assert.equal(node.command, 'sleep 30');
  assert.equal(node.cwd, dir);
  const log = join(dir, 'run.log');
  assert.deepEqual(node.writes, [log]);
  assert.deepEqual(state.files[log].lines, ['first', 'second']);
  assert.equal(state.files[log].size, 13);
  assert.ok(state.files[log].mtimeMs > Date.now() - 60000);

  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  const gone = await running.poll([dir]);
  assert.ok(!gone.roots.some((item) => item.pid === child.pid));
});
