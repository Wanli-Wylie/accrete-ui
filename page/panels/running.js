// The running panel: what the process table and open files show, nothing more.
// Log text is untrusted, so everything goes in through textContent.

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function memory(mb) {
  return mb < 1024 ? `${mb} MB` : `${(mb / 1024).toFixed(1)} GB`;
}

// A span that keeps its age current; see the ticker in mount.
function since(at) {
  const span = document.createElement('span');
  span.dataset.since = at;
  span.textContent = duration(Date.now() - at);
  return span;
}

function node(tag, className, ...parts) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.append(...parts.filter((part) => part !== null && part !== undefined));
  return element;
}

function displayPath(path, state) {
  const base = state.scope.find((dir) => path.startsWith(`${dir}/`));
  if (base) return path.slice(base.length + 1);
  return path.startsWith(`${state.home}/`) ? `~${path.slice(state.home.length)}` : path;
}

function baseName(path) {
  return path.split('/').pop();
}

function processEvidence(proc, state) {
  const parts = [];
  if (proc.pids) {
    const listed = proc.pids.slice(0, 4).join(', ');
    parts.push(`${proc.pids.length} alike, pids ${listed}${proc.pids.length > 4 ? ', ...' : ''}, oldest running `, since(proc.startedAt), `, ${memory(proc.rssMb)} together`);
    return parts;
  }
  parts.push(`pid ${proc.pid}, running `, since(proc.startedAt), `, ${proc.cpu}% CPU, ${memory(proc.rssMb)}`);
  const newest = state.files[proc.writes[0]];
  if (newest) {
    const others = proc.writes.length > 1 ? ` and ${proc.writes.length - 1} more` : '';
    parts.push(`, writing ${baseName(newest.path)}${others}, last write `, since(newest.mtimeMs), ' ago');
  }
  return parts;
}

// The program's name is what reads; the whole path is on hover.
function shortCommand(command) {
  const [program, ...args] = command.split(' ');
  const name = program.split('/').pop().replace(/^-/, '');
  return [program.startsWith('-') ? `-${name}` : name, ...args].join(' ');
}

function processRow(proc, state) {
  const command = node('div', 'command', shortCommand(proc.command));
  command.title = proc.command;
  return node(
    'div',
    'process',
    command,
    node('div', 'evidence', ...processEvidence(proc, state)),
    ...proc.children.map((child) => processRow(child, state)),
  );
}

function growth(file) {
  if (file.overSeconds < 5) return null;
  if (file.grew === 0) return `, no growth in ${file.overSeconds}s`;
  return `, ${file.grew > 0 ? '+' : '-'}${bytes(Math.abs(file.grew))} in ${file.overSeconds}s`;
}

function fileBlock(file, state) {
  const facts = [`${bytes(file.size)}`];
  if (file.binary) facts.push(', binary');
  if (file.unknown) facts.push(', could not read');
  const heading = node(
    'div',
    'evidence',
    node('span', 'path', displayPath(file.path, state)),
    ` ${facts.join('')}${growth(file) ?? ''}, last write `,
    since(file.mtimeMs),
    ' ago',
  );
  const block = node('div', 'file', heading);
  if (file.lines?.length) block.append(node('pre', null, file.lines.join('\n')));
  return block;
}

function filesOf(proc, seen, out = []) {
  for (const path of proc.writes) {
    if (!seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  for (const child of proc.children) filesOf(child, seen, out);
  return out;
}

function render(el, state) {
  if (state.loading) {
    el.replaceChildren(node('div', 'quiet head', 'Reading the process table.'));
    return;
  }
  const scope = state.scope.map((path) => (path.startsWith(`${state.home}/`) ? `~${path.slice(state.home.length)}` : path)).join(', ');
  const parts = [node('div', 'quiet head', `${state.roots.length ? '' : 'Nothing running. '}Scope: ${scope}`)];
  const seen = new Set();
  for (const root of state.roots) {
    const paths = filesOf(root, seen);
    parts.push(node('section', 'tree', processRow(root, state), ...paths.map((path) => fileBlock(state.files[path], state))));
  }
  el.replaceChildren(...parts);
}

export function mount(el, events) {
  let waiting = null;

  // Do not pull text out from under someone selecting it.
  const selecting = () => {
    const selection = getSelection();
    return selection && !selection.isCollapsed && el.contains(selection.anchorNode);
  };

  events.addEventListener('running', (event) => {
    waiting = JSON.parse(event.data);
    if (selecting()) return;
    render(el, waiting);
    waiting = null;
  });

  setInterval(() => {
    if (waiting && !selecting()) {
      render(el, waiting);
      waiting = null;
    }
    for (const span of el.querySelectorAll('[data-since]')) {
      span.textContent = duration(Date.now() - Number(span.dataset.since));
    }
  }, 5000);
}
