// Reads the Workspace for the activity panel: a time-ordered feed of what was seen in
// documents, local state and Git. It says what changed, never who changed it. The feed
// lives only in this process.
import { execFile } from 'node:child_process';
import { openStore } from '../documents.mjs';

const CAP = 500;
const GIT_POLL_MS = 3000;
const COMMITS = 50;

const short = (revision) => revision.slice(0, 8);

function git(root, args) {
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', '-C', root, ...args], { timeout: 10000, maxBuffer: 2 ** 26 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function parseStatus(text) {
  const state = { repo: true, branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0 };
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (!line.startsWith('# ')) state.dirty += 1;
    else if (line.startsWith('# branch.head ')) state.branch = line.slice('# branch.head '.length);
    else if (line.startsWith('# branch.upstream ')) state.upstream = line.slice('# branch.upstream '.length);
    else if (line.startsWith('# branch.ab ')) {
      const [, ahead, behind] = line.match(/\+(\d+) -(\d+)/) ?? [];
      state.ahead = Number(ahead);
      state.behind = Number(behind);
    }
  }
  return state;
}

function parseWorktrees(text) {
  const worktrees = [];
  for (const line of (text ?? '').split('\n')) {
    if (line.startsWith('worktree ')) worktrees.push({ path: line.slice('worktree '.length), branch: null });
    else if (line.startsWith('branch ')) worktrees.at(-1).branch = line.slice('branch '.length).replace('refs/heads/', '');
  }
  return worktrees;
}

// All local branches, so a commit made in an iteration's worktree shows too.
async function readCommits(root) {
  const out = await git(root, ['log', `-n${COMMITS}`, '--branches', 'HEAD', '--format=%H%x00%h%x00%cI%x00%an%x00%s']);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, abbreviated, committed_at, author, subject] = line.split('\0');
      return { sha, abbreviated, committed_at, author, subject };
    });
}

function backfill(doc) {
  const items = [];
  const add = (field, verb) => {
    const at = Date.parse(doc[field]);
    if (!Number.isNaN(at)) items.push({ at, source: 'document', text: `${doc.rel} ${verb} (${field})`, detail: doc.name, open: doc.id });
  };
  add('created_at', 'created');
  add('updated_at', 'updated');
  add('authored_at', 'authored');
  return items;
}

const commitItem = (commit, at, live) => ({
  at,
  live,
  source: 'git',
  text: `commit ${commit.abbreviated} ${commit.subject}`,
  detail: commit.author,
  committed_at: commit.committed_at,
});

function documentItems(change, at) {
  const item = (doc, text) => ({ at, live: true, source: 'document', text, detail: doc.name, open: doc.id });
  return [
    ...change.added.map((doc) => item(doc, `${doc.rel} added, revision ${short(doc.revision)}`)),
    ...change.changed.map(({ before, after }) => item(after, `${after.rel} changed, revision ${short(before.revision)} to ${short(after.revision)}`)),
    ...change.removed.map((doc) => item(doc, `${doc.rel} removed, was revision ${short(doc.revision)}`)),
    ...change.receiptsAdded.map((name) => ({ at, live: true, source: 'receipt', text: `${name} appeared in local state` })),
    ...change.receiptsRemoved.map((name) => ({ at, live: true, source: 'receipt', text: `${name} gone from local state` })),
  ];
}

export async function start({ root, emit }) {
  const store = await openStore(root);
  let feed = [];
  let gitState = null;
  const seenCommits = new Set();

  const add = (items) => {
    feed = [...feed, ...items].sort((a, b) => b.at - a.at).slice(0, CAP);
  };
  const publish = () => emit('activity', { feed, git: gitState, receipts: store.receipts });

  add([...store.docs.values()].flatMap(backfill));
  store.subscribe((change) => {
    const items = documentItems(change, Date.now());
    if (!items.length) return;
    add(items);
    publish();
  });

  // A commit from the first look is history, dated by Git. A later one is placed when
  // it was seen, since a merge or pull can bring in old dates.
  async function poll(first) {
    const status = await git(root, ['status', '--porcelain=v2', '--branch']);
    const next = status === null ? { repo: false } : parseStatus(status);
    if (next.repo) next.worktrees = parseWorktrees(await git(root, ['worktree', 'list', '--porcelain']));

    const fresh = (next.repo ? await readCommits(root) : []).filter((commit) => !seenCommits.has(commit.sha));
    for (const commit of fresh) seenCommits.add(commit.sha);
    const items = fresh.map((commit) => (first ? commitItem(commit, Date.parse(commit.committed_at), false) : commitItem(commit, Date.now(), true)));
    if (items.length) add(items);

    const gitChanged = JSON.stringify(next) !== JSON.stringify(gitState);
    gitState = next;
    if (first || items.length || gitChanged) publish();
  }

  function loop() {
    setTimeout(async () => {
      await poll(false).catch((err) => console.error(`accrete-ui: git poll failed: ${err.message}`));
      loop();
    }, GIT_POLL_MS).unref();
  }

  await poll(true);
  loop();
}
