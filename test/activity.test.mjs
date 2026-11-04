import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { revisionOf } from '../server/documents.mjs';
import { start } from '../server/readers/activity.mjs';

const temp = mkdtempSync(join(tmpdir(), 'accrete-ui-activity-'));
after(() => rmSync(temp, { recursive: true, force: true }));

// A stand-in Kernel: this panel only needs config resolve to name the paths.
function workspace(name) {
  const root = join(temp, name);
  const state = join(temp, `${name}-state`);
  mkdirSync(join(root, '.accrete/bin'), { recursive: true });
  writeFileSync(join(root, '.accrete/project.toml'), `name = "${name}"\n`);
  const resolved = {
    project_root: root,
    local_state: { directory: state, index: join(state, 'index.sqlite'), view_key: 'v' },
    paths: { memory: join(root, 'memory'), metadata: join(root, '.accrete/objects'), results: join(root, 'results'), scratch: join(root, 'scratch'), tool_sources: join(root, 'tools') },
  };
  writeFileSync(join(root, '.accrete/bin/accrete'), `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(resolved)}\nEOF\n`);
  chmodSync(join(root, '.accrete/bin/accrete'), 0o755);
  return { root, state };
}

async function open(root) {
  let latest = null;
  const waiters = [];
  await start({
    root,
    emit: (name, data) => {
      assert.equal(name, 'activity');
      latest = data;
      for (const waiter of [...waiters]) if (waiter.until(data)) waiter.done(data);
    },
  });
  return {
    latest: () => latest,
    until: (predicate, timeout = 10000) => {
      if (predicate(latest)) return Promise.resolve(latest);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; latest ${JSON.stringify({ ...latest, feed: latest.feed.slice(0, 5) })}`)), timeout);
        waiters.push({ until: predicate, done: (data) => (clearTimeout(timer), resolve(data)) });
      });
    },
  };
}

const short = (text) => revisionOf(Buffer.from(text)).slice(0, 8);
const texts = (state) => state.feed.map((item) => item.text);
const has = (state, text) => texts(state).includes(text);

test('backfills from timestamps and Git, in time order', async () => {
  const { root } = workspace('backfill');
  mkdirSync(join(root, '.accrete/objects/models'), { recursive: true });
  writeFileSync(join(root, '.accrete/objects/models/m1.json'), '{"format":1,"kind":"model","id":"m1","project_id":"p","name":"M","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-03T00:00:00Z"}');
  mkdirSync(join(root, 'memory/2026/01/02'), { recursive: true });
  writeFileSync(join(root, 'memory/2026/01/02/001.md'), '---\nauthored_at: 2026-01-02T00:00:00Z\nformat: 1\nid: note\nkind: memory\nproject_id: p\n---\nBody\n');
  writeFileSync(join(root, 'memory/2026/01/02/002.md'), '# Not Memory\n');
  const git = (env, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Someone', '-c', 'user.email=s@x', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  git({}, 'init', '-q', '-b', 'main');
  git({}, 'add', '-A');
  git({ GIT_COMMITTER_DATE: '2026-01-04T00:00:00Z', GIT_AUTHOR_DATE: '2026-01-04T00:00:00Z' }, 'commit', '-qm', 'first commit');

  const state = (await open(root)).latest();
  const sha = git({}, 'rev-parse', '--short', 'HEAD').trim();
  assert.deepEqual(texts(state), [
    `commit ${sha} first commit`,
    '.accrete/objects/models/m1.json updated (updated_at)',
    'memory/2026/01/02/001.md authored (authored_at)',
    '.accrete/objects/models/m1.json created (created_at)',
  ]);
  assert.equal(state.feed[1].open, 'm1');
  assert.equal(state.feed[0].open, undefined);
  assert.equal(state.git.branch, 'main');
  assert.equal(state.git.dirty, 0);
  assert.equal(state.git.upstream, null);
  assert.equal(state.git.worktrees.length, 1);
});

test('reports what it sees live, and says only that', async () => {
  const { root, state: stateDir } = workspace('live');
  const panel = await open(root);
  assert.equal(panel.latest().git.repo, false);

  // A store that did not exist at the start, published as the Kernel does.
  const first = '{"format":1,"kind":"result","id":"run-17","project_id":"p","name":"Run"}\n';
  mkdirSync(join(root, 'results'));
  const path = join(root, 'results/run-17.json');
  writeFileSync(join(root, 'results/.tmpXyZ'), first);
  renameSync(join(root, 'results/.tmpXyZ'), path);
  let state = await panel.until((s) => s.feed.length > 0);
  assert.deepEqual(texts(state), [`results/run-17.json added, revision ${short(first)}`]);
  assert.equal(state.feed[0].open, 'run-17');
  assert.equal(state.feed[0].live, true);

  const second = '{"format":1,"kind":"result","id":"run-17","project_id":"p","name":"Run","status":"done"}\n';
  writeFileSync(path, second);
  state = await panel.until((s) => has(s, `results/run-17.json changed, revision ${short(first)} to ${short(second)}`));

  // Rewriting the same bytes is no change, and a temporary file alone is nothing.
  writeFileSync(path, second);
  writeFileSync(join(root, 'results/.tmpLeft'), 'partial');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(panel.latest().feed.length, 2);
  unlinkSync(join(root, 'results/.tmpLeft'));

  unlinkSync(path);
  state = await panel.until((s) => has(s, `results/run-17.json removed, was revision ${short(second)}`));
  assert.equal(state.feed[0].text, `results/run-17.json removed, was revision ${short(second)}`);

  // Local state that appears later is picked up too.
  mkdirSync(join(stateDir, 'receipts'), { recursive: true });
  writeFileSync(join(stateDir, 'receipts/publication-run-17.json'), '{}');
  state = await panel.until((s) => has(s, 'receipts/publication-run-17.json appeared in local state'));
  assert.deepEqual(state.receipts, ['receipts/publication-run-17.json']);
  unlinkSync(join(stateDir, 'receipts/publication-run-17.json'));
  state = await panel.until((s) => has(s, 'receipts/publication-run-17.json gone from local state'));
  assert.deepEqual(state.receipts, []);

  for (const text of texts(state)) assert.doesNotMatch(text, /kernel|accrete/i);
});

test('polls Git for commits, branch, dirty count and worktrees without taking its lock', async () => {
  const { root } = workspace('git');
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Someone', '-c', 'user.email=s@x', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), '.accrete/\n');
  git('add', '-A');
  git('commit', '-qm', 'one');
  const panel = await open(root);
  assert.equal(panel.latest().feed.length, 1);
  assert.equal(panel.latest().feed[0].live, false);
  assert.equal(panel.latest().feed[0].detail, 'Someone');

  writeFileSync(join(root, 'dirty.txt'), 'x');
  await panel.until((s) => s.git.dirty === 1);

  git('add', '-A');
  git('commit', '-qm', 'two');
  const sha = git('rev-parse', '--short', 'HEAD');
  const state = await panel.until((s) => has(s, `commit ${sha} two`) && s.git.dirty === 0);
  assert.equal(state.feed[0].live, true);

  git('worktree', 'add', '-q', '-b', 'side', join(temp, 'git-side'));
  git('checkout', '-q', '-b', 'topic');
  const moved = await panel.until((s) => s.git.branch === 'topic' && s.git.worktrees.length === 2);
  assert.deepEqual(moved.git.worktrees.map((worktree) => worktree.branch).sort(), ['side', 'topic']);

  execFileSync('git', ['-C', join(temp, 'git-side'), '-c', 'user.name=Someone', '-c', 'user.email=s@x', 'commit', '-q', '--allow-empty', '-m', 'in the side worktree']);
  await panel.until((s) => texts(s).some((text) => text.endsWith('in the side worktree')));
});

test('the feed is capped, newest kept', async () => {
  const { root } = workspace('cap');
  mkdirSync(join(root, 'results'));
  for (let i = 0; i < 520; i += 1) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    writeFileSync(join(root, `results/r${i}.json`), JSON.stringify({ format: 1, kind: 'result', id: `r${i}`, project_id: 'p', created_at: at }));
  }
  const { feed } = (await open(root)).latest();
  assert.equal(feed.length, 500);
  assert.equal(feed[0].text, 'results/r519.json created (created_at)');
  assert.equal(feed.at(-1).text, 'results/r20.json created (created_at)');
});
