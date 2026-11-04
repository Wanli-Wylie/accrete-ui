// The activity panel: what was seen in documents, local state and Git, newest first.
// Workspace text is untrusted, so everything goes in through text nodes.
const PAGE = 100;

function h(tag, props, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

function when(ms) {
  const date = new Date(ms);
  const time = date.toLocaleTimeString([], { hour12: false });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString('en-CA')} ${time.slice(0, 5)}`;
}

function gitLine(git) {
  if (!git) return 'Reading Git.';
  if (!git.repo) return 'This Workspace is not in a Git repository.';
  const tracking = git.upstream ? `${git.ahead} ahead, ${git.behind} behind ${git.upstream}` : 'no upstream';
  const names = git.worktrees.map((worktree) => worktree.branch ?? 'detached').join(', ');
  const worktrees = `${git.worktrees.length} worktree${git.worktrees.length === 1 ? '' : 's'}: ${names}`;
  return [git.branch, tracking, `${git.dirty} changed or untracked`, worktrees].join(' · ');
}

function itemRow(item) {
  const committed = item.committed_at && item.live && Math.abs(Date.parse(item.committed_at) - item.at) > 60000 ? `committed ${when(Date.parse(item.committed_at))}` : null;
  const detail = [item.detail, committed].filter(Boolean).join(' · ');
  const content = [
    h('span', { className: 'when', textContent: when(item.at) }),
    h('span', { className: 'what' }, item.text, detail ? h('span', { className: 'detail', textContent: ` · ${detail}` }) : null),
  ];
  const className = item.live ? 'item live' : 'item';
  if (!item.open) return h('div', { className }, ...content);
  return h(
    'button',
    {
      className,
      onclick: () => document.dispatchEvent(new CustomEvent('accrete:open-object', { detail: { id: item.open } })),
    },
    ...content,
  );
}

export function mount(el, events) {
  const git = h('div', { className: 'git' });
  const receipts = h('div', { className: 'receipts' });
  const note = h('div', {
    className: 'note',
    textContent: 'What was seen in documents, local state and Git, not who did it. A refused Kernel call leaves no trace, so it does not appear.',
  });
  const feed = h('div', { className: 'feed' });
  const more = h('button', { className: 'more' });
  el.replaceChildren(h('div', { className: 'head' }, git, receipts, note), feed, more);

  let state = null;
  let shown = PAGE;

  function renderFeed() {
    const before = feed.offsetHeight;
    feed.replaceChildren(...state.feed.slice(0, shown).map(itemRow));
    if (!state.feed.length) feed.append(h('div', { className: 'empty', textContent: 'Nothing yet.' }));
    // Someone reading further down keeps their place as new items arrive above.
    if (el.scrollTop > 0) el.scrollTop += feed.offsetHeight - before;
    const left = state.feed.length - shown;
    more.hidden = left <= 0;
    more.textContent = `${left} more`;
  }

  more.onclick = () => {
    shown += PAGE;
    renderFeed();
  };

  events.addEventListener('activity', (event) => {
    state = JSON.parse(event.data);
    git.textContent = gitLine(state.git);
    git.title = (state.git?.worktrees ?? []).map((worktree) => worktree.path).join('\n');
    const count = state.receipts.length;
    receipts.textContent = count
      ? `${count} receipt${count === 1 ? '' : 's'} in local state, so an operation is running or was interrupted: ${state.receipts.join(', ')}. .accrete/bin/accrete recover finishes an interrupted one.`
      : '';
    renderFeed();
  });
}
