import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { memoryFrontmatter, openStore, revisionOf } from '../server/documents.mjs';
import { read, start } from '../server/readers/objects.mjs';

const KERNEL = fileURLToPath(new URL('../../accrete-cli/target/release/accrete', import.meta.url));
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'accrete-ui-objects-'))); // the Kernel reports canonical paths
after(() => rmSync(temp, { recursive: true, force: true }));

function workspace(name, { kernel = false } = {}) {
  const root = join(temp, name);
  mkdirSync(join(root, '.accrete/bin'), { recursive: true });
  writeFileSync(join(root, '.accrete/project.toml'), `format = 1\nproject_id = "p-${name}"\nname = "${name}"\ntimezone = "UTC"\n`);
  // Local state stays inside the temporary directory, not under the home directory.
  writeFileSync(join(root, '.accrete/local.toml'), `[local_state]\nbase = "${join(temp, `${name}-state`)}"\n`);
  if (kernel) copyFileSync(KERNEL, join(root, '.accrete/bin/accrete'));
  return root;
}

// Starts the reader and gives back the latest event, plus a way to wait on a later one.
async function open(root) {
  let latest = null;
  const waiters = [];
  await start({
    root,
    emit: (name, data) => {
      assert.equal(name, 'objects');
      latest = data;
      for (const waiter of [...waiters]) if (waiter.until(data)) waiter.done(data);
    },
  });
  return {
    latest: () => latest,
    until: (predicate, timeout = 8000) => {
      if (predicate(latest)) return Promise.resolve(latest);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; latest ${JSON.stringify(latest)}`)), timeout);
        waiters.push({ until: predicate, done: (data) => (clearTimeout(timer), resolve(data)) });
      });
    },
    close: async () => (await openStore(root)).close(),
  };
}

describe('without a Kernel', () => {
  test('documents list and open, and absent stores are empty', async () => {
    const root = workspace('bare');
    writeFileSync(join(root, '.accrete/release.json'), '{"template_version":"9.9.9"}');
    const panel = await open(root);
    const empty = panel.latest();
    assert.deepEqual(Object.values(empty.counts), [0, 0, 0, 0, 0, 0]);
    assert.equal(empty.install, 'npx accrete-kit@9.9.9 install');
    assert.equal(empty.index.present, false);

    mkdirSync(join(root, 'results'));
    const body = '{"format":1,"kind":"result","id":"r1","project_id":"p","name":"One","created_at":"2026-01-01T00:00:00Z"}\n';
    writeFileSync(join(root, 'results/r1.json'), body);
    writeFileSync(join(root, 'results/broken.json'), 'not json');
    mkdirSync(join(root, 'memory/2026/01/01'), { recursive: true });
    writeFileSync(join(root, 'memory/2026/01/01/001.md'), '---\nformat: 1\nid: m1\nkind: memory\nproject_id: p\ntitle: "A: quoted title"\n---\nBody\n');
    writeFileSync(join(root, 'memory/2026/01/01/002.md'), '# Ordinary notes\n');

    const seen = await panel.until((state) => state.counts.result === 2 && state.counts.memory === 1);
    assert.equal(seen.counts.model, 0);

    const list = await read('list/result/0/100');
    assert.equal(list.total, 2);
    assert.equal(list.items[0].id, 'r1');
    assert.equal(list.items.find((item) => item.rel === 'results/broken.json').problem, 'not valid JSON');

    const one = await read('object/r1');
    assert.equal(one.present, true);
    assert.equal(one.text, body);
    assert.equal(one.revision, revisionOf(Buffer.from(body)));
    assert.equal(one.relations, null);

    const memory = await read('object/m1');
    assert.equal(memory.name, 'A: quoted title');
    assert.equal(memory.kind, 'memory');

    await panel.close();
  });

  test('read treats its argument as an ID or a list, never a path', async () => {
    const root = workspace('hostile');
    writeFileSync(join(root, 'secret.json'), '{"secret":true}');
    const panel = await open(root);
    for (const rest of ['object/../secret.json', "object/' OR 1=1 --", `object/${join(root, 'secret.json')}`]) {
      const answer = await read(rest);
      assert.equal(answer.present, false, rest);
      assert.equal(answer.text, undefined, rest);
    }
    assert.equal(await read('object/'), undefined);
    assert.equal(await read('list/nonsense/0'), undefined);
    assert.equal(await read('../../etc/passwd'), undefined);
    await panel.close();
  });
});

test('Markdown is Memory only with a managed frontmatter', () => {
  assert.equal(memoryFrontmatter('# Heading\n'), null);
  assert.equal(memoryFrontmatter('---\ntitle: a blog post\n---\nBody\n'), null);
  assert.equal(memoryFrontmatter('---\nkind: memory\nid: x\n---\nBody\n').id, 'x');
  assert.equal(memoryFrontmatter('---\n{"kind":"memory","id":"y","n":1}\n---\nBody\n').id, 'y');
  assert.ok(memoryFrontmatter('---\nkind: memory\nid: x\n').problem);
});

describe('with a Kernel', { skip: existsSync(KERNEL) ? false : 'no accrete-cli release binary' }, () => {
  const root = workspace('full', { kernel: true });
  const repo = join(temp, 'model-repo');
  const kernel = (...args) => JSON.parse(execFileSync(join(root, '.accrete/bin/accrete'), ['--project', root, ...args, '--json'], { encoding: 'utf8' }));
  const scratch = (name, text) => {
    const path = join(temp, name);
    writeFileSync(path, text);
    return path;
  };
  let panel;
  let commit;
  let memoryId;

  test('relations follow in both directions, and absent targets are not errors', async () => {
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git('add', '-A');
    git('commit', '-qm', 'start');
    commit = git('rev-parse', 'HEAD');

    panel = await open(root);
    assert.equal(panel.latest().install, null);

    kernel('model', 'register', '--id', 'target', '--name', 'target-model', '--checkout', repo);
    kernel('model', 'iteration', 'open', 'target', '--id', 'iter-1', '--name', 'improve');
    mkdirSync(join(root, 'tools/t'), { recursive: true });
    kernel('tool', 'admit', '--id', 'tool-1', '--name', 'residual', '--source', 'tools/t');
    writeFileSync(join(root, 'output.dat'), 'x');
    kernel('data', 'register', '--id', 'output-1', '--name', 'year-one', '--path', 'output.dat', '--kind', 'file');
    kernel(
      'result',
      'record',
      '--from',
      scratch(
        'r.json',
        JSON.stringify({
          id: 'run-1',
          name: 'A run',
          models: [{ model_id: 'target', commit, role: 'target' }, { model_id: 'gone-model', commit: 'abc123', role: 'other' }],
          tools: [{ tool_id: 'tool-1', revision: 'rev-1' }],
          inputs: [{ data_id: 'absent-forcing', role: 'forcing' }],
          outputs: [{ data_id: 'output-1', role: 'year-one' }],
        }),
      ),
    );
    memoryId = kernel('memory', 'append', '--from', scratch('m.md', 'Understood.\n'), '--title', 'A note', '--result', 'run-1', '--model', 'target-model').object_id;

    const state = await panel.until((s) => s.counts.memory === 1 && s.index.present && s.index.missing.count === 0 && s.index.changed.count === 0);
    assert.ok(state.index.refreshed_at);
    assert.deepEqual(
      { ...state.counts },
      { model: 1, iteration: 1, tool: 1, data: 1, result: 1, memory: 1 },
    );

    const result = await read('object/run-1');
    const section = (object, name) => object.relations.filter((relation) => relation.section === name);

    const [model, absentModel] = section(result, 'Models used');
    assert.equal(model.id, 'target');
    assert.equal(model.name, 'target-model');
    assert.equal(model.commit, commit);
    assert.equal(model.commit_available, true);
    assert.equal(absentModel.present, false);
    assert.equal(absentModel.commit_available, null);

    const [tool] = section(result, 'Tools used');
    assert.equal(tool.revision, 'rev-1');
    assert.equal(tool.name, 'residual');

    // The index row says only "forcing"; the Result document says it was an input.
    const [input] = section(result, 'Input Data');
    assert.equal(input.id, 'absent-forcing');
    assert.equal(input.role, 'forcing');
    assert.equal(input.present, false);
    const [output] = section(result, 'Output Data');
    assert.equal(output.id, 'output-1');
    assert.equal(output.present, true);

    assert.equal(section(result, 'Linked from Memory')[0].id, memoryId);

    const modelDoc = await read('object/target');
    assert.equal(section(modelDoc, 'Iterations')[0].id, 'iter-1');
    assert.equal(section(modelDoc, 'Results')[0].id, 'run-1');
    assert.equal(modelDoc.binding.checkout, repo);
    // The Memory link holds the Model's name, as the Kernel stores what it was given.
    assert.equal(section(modelDoc, 'Linked from Memory')[0].id, memoryId);

    assert.equal(section(await read('object/iter-1'), 'Model')[0].id, 'target');
    assert.equal(section(await read('object/tool-1'), 'Results')[0].revision, 'rev-1');
    const outputDoc = await read('object/output-1');
    assert.equal(section(outputDoc, 'Results')[0].direction, 'output');

    const links = section(await read(`object/${memoryId}`), 'Links');
    assert.deepEqual(links.map((link) => link.id).sort(), ['run-1', 'target']);

    // A target that is not here still opens, and says who names it.
    const absent = await read('object/absent-forcing');
    assert.equal(absent.present, false);
    assert.equal(absent.relations[0].id, 'run-1');
    assert.equal(absent.relations[0].direction, 'input');
  });

  test('a temporary sibling is not a document', async () => {
    writeFileSync(join(root, 'results/.tmpAbC123'), '{"partial":');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await read('list/result/0/100')).total, 1);
    unlinkSync(join(root, 'results/.tmpAbC123'));
  });

  test('says when the index is behind, and when a refresh has caught up', async () => {
    const path = join(root, 'results/run-1.json');
    const original = readFileSync(path);
    writeFileSync(path, `${original}\n`);
    writeFileSync(join(root, 'results/by-hand.json'), '{"format":1,"kind":"result","id":"by-hand","project_id":"p-full"}\n');
    const behind = await panel.until((s) => s.index.changed.count === 1 && s.index.missing.count === 1);
    assert.deepEqual(behind.index.changed.sample, ['results/run-1.json']);
    assert.deepEqual(behind.index.missing.sample, ['results/by-hand.json']);
    const one = await read('object/run-1');
    assert.notEqual(one.index_revision, one.revision);
    assert.equal((await read('object/by-hand')).in_index, false);

    unlinkSync(join(root, 'results/by-hand.json'));
    const before = behind.index.refreshed_at;
    kernel('index', 'refresh');
    const caught = await panel.until((s) => s.index.refreshed_at !== before && s.index.changed.count === 0 && s.index.missing.count === 0);
    assert.equal(caught.index.gone.count, 0);
    unlinkSync(path);
    const removed = await panel.until((s) => s.index.gone.count === 1);
    assert.deepEqual(removed.index.gone.sample, ['results/run-1.json']);
    writeFileSync(path, original);
    await panel.until((s) => s.counts.result === 1);
    kernel('index', 'refresh');
    await panel.until((s) => s.index.changed.count === 0 && s.index.gone.count === 0);
  });

  test('a locked index is retried', async () => {
    const index = (await openStore(root)).workspace.local_state.index;
    const holder = spawn('sqlite3', [index], { stdio: ['pipe', 'ignore', 'ignore'] });
    holder.stdin.write('BEGIN EXCLUSIVE;\n');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const answer = read('object/run-1');
    setTimeout(() => holder.stdin.end('COMMIT;\n.quit\n'), 300);
    const object = await answer;
    assert.equal(object.relations_error, undefined);
    assert.ok(object.relations.length > 0);
  });

  test('without an index, documents still list and open', async () => {
    const store = await openStore(root);
    await panel.close();
    rmSync(store.workspace.local_state.index);
    panel = await open(root);
    const state = panel.latest();
    assert.equal(state.index.present, false);
    assert.equal(state.counts.result, 1);
    const one = await read('object/run-1');
    assert.equal(one.present, true);
    assert.equal(one.relations, null);
    await panel.close();
  });
});
