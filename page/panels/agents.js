// The agents panel: which sessions exist for this Workspace and what each is doing.
// Liveness is worded as the evidence for it. Transcript text is untrusted, so
// everything goes in through textContent.

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

function time(value) {
  return typeof value === 'number' ? value : Date.parse(value);
}

// A span that keeps its age current; see the ticker in mount.
function ago(at) {
  const span = document.createElement('span');
  span.dataset.since = time(at);
  span.textContent = `${duration(Date.now() - time(at))} ago`;
  return span;
}

function node(tag, className, ...parts) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.append(...parts.filter((part) => part !== null && part !== undefined));
  return element;
}

function shortPath(path, state) {
  if (!path) return 'unknown';
  return path.startsWith(`${state.home}/`) ? `~${path.slice(state.home.length)}` : path;
}

function programOf(command) {
  if (!command) return null;
  const [program, ...rest] = command.split(/\s+/);
  const name = program.split('/').pop();
  return rest[0] && !rest[0].startsWith('-') ? `${name} ${rest[0]}` : name;
}

function evidence(session) {
  const parts = [];
  const { process: proc, sessionFile: file } = session;
  if (proc?.via === 'open rollout') {
    parts.push(`process ${proc.pid} (${programOf(proc.command) ?? 'unknown'}) has this rollout open, written `);
  } else if (proc) {
    const says = file?.status ? `, session file says ${file.status}` : '';
    parts.push(`process ${proc.pid} present${says}, `);
    parts.push(session.mtimeMs ? 'transcript written ' : 'no transcript yet');
  } else if (file) {
    parts.push(`session file names process ${file.pid}, which is not running, last written `);
  } else if (session.missingParent) {
    parts.push('no rollout found for this thread, only its subagents; ');
    parts.push('no process found');
  } else {
    parts.push('no process found, last written ');
  }
  if (session.mtimeMs) parts.push(ago(session.mtimeMs));
  if (session.turnEndedAt) parts.push(', turn ended ', ago(session.turnEndedAt));
  return parts;
}

function toolLine(tool) {
  if (!tool) return node('div', 'tool quiet', 'last tool unknown');
  const summary = node('code', null, tool.summary ?? 'unknown');
  summary.title = tool.summary ?? '';
  const when = node('span', 'quiet', tool.pending ? 'no result yet' : null);
  if (tool.at && Number.isFinite(Date.parse(tool.at))) when.append(tool.pending ? ', ' : '', ago(tool.at));
  return node('div', 'tool', node('span', 'tool-name', tool.name ?? 'unknown'), summary, when);
}

function subagentRow(child, parent, state) {
  const label = [child.kind, child.nickname].filter(Boolean).join(' ') || 'subagent';
  const facts = [];
  if (child.process) facts.push(`rollout open in process ${child.process.pid}, `);
  if (child.mtimeMs) facts.push('written ', ago(child.mtimeMs));
  if (child.turnEndedAt) facts.push(', turn ended ', ago(child.turnEndedAt));
  return node(
    'div',
    'subagent',
    node('div', 'row', node('span', 'kind', label), ' ', node('span', 'title', child.title ?? 'unknown')),
    child.cwd && child.cwd !== parent.cwd ? node('div', 'cwd', shortPath(child.cwd, state)) : null,
    node('div', 'evidence', ...facts),
    toolLine(child.tool),
  );
}

function subagentsBlock(session, state, opened) {
  const { total, active, shown } = session.subagents;
  if (total === 0) return null;
  const summary = `${total} subagent${total === 1 ? '' : 's'}, ${active} written in the last 10 min`;
  const details = node('details', 'subagents', node('summary', null, summary));
  details.open = opened.get(session.id) ?? active > 0;
  details.addEventListener('toggle', () => opened.set(session.id, details.open));
  for (const child of shown) details.append(subagentRow(child, session, state));
  if (total > shown.length) details.append(node('div', 'quiet', `and ${total - shown.length} older`));
  return details;
}

function sessionRow(session, state, opened) {
  const title = session.title ?? `unknown title, ${session.id.slice(0, 8)}`;
  return node(
    'article',
    session.process ? 'session has-process' : 'session',
    node('div', 'row', node('span', 'agent', session.agent), ' ', node('span', 'title', title)),
    node('div', 'cwd', shortPath(session.cwd, state)),
    node('div', 'evidence', ...evidence(session)),
    toolLine(session.tool),
    subagentsBlock(session, state, opened),
  );
}

function footer(state) {
  const { claude, codex } = state.sources;
  const lines = [`Read ${claude.transcripts} Claude transcripts, ${claude.sessionFiles} session files, ${codex.rollouts} Codex rollouts`];
  if (claude.noCwd) lines.push(`no working directory found in ${claude.noCwd} of the transcripts`);
  if (codex.notUnderstood) lines.push(`${codex.notUnderstood} of the rollouts not understood`);
  if (codex.scanning) lines.push('still indexing Codex rollouts');
  return node('div', 'quiet foot', lines.join('; '));
}

function render(el, state, opened) {
  const parts = [];
  if (!state.loading) {
    const withProcess = state.sessions.filter((session) => session.process).length;
    const count = state.sessions.length + (state.hiddenSessions ?? 0);
    parts.push(node('div', 'quiet head', `${count} session${count === 1 ? '' : 's'}, ${withProcess} with a process. Scope: ${state.scope.map((path) => shortPath(path, state)).join(', ')}`));
    for (const session of state.sessions) parts.push(sessionRow(session, state, opened));
    if (state.hiddenSessions) parts.push(node('div', 'quiet', `and ${state.hiddenSessions} older sessions`));
    for (const proc of state.unattached) {
      parts.push(
        node('div', 'unattached', `process ${proc.pid} (${programOf(proc.command)}) is in ${shortPath(proc.cwd, state)}; no session file or open rollout ties it to a session`),
      );
    }
    parts.push(footer(state));
  } else {
    parts.push(node('div', 'quiet head', 'Reading sessions.'));
  }
  el.replaceChildren(...parts);
}

export function mount(el, events) {
  const opened = new Map(); // session id -> whether its subagents are shown
  let waiting = null;

  // Do not pull text out from under someone selecting it.
  const selecting = () => {
    const selection = getSelection();
    return selection && !selection.isCollapsed && el.contains(selection.anchorNode);
  };

  events.addEventListener('agents', (event) => {
    waiting = JSON.parse(event.data);
    if (selecting()) return;
    render(el, waiting, opened);
    waiting = null;
  });

  setInterval(() => {
    if (waiting && !selecting()) {
      render(el, waiting, opened);
      waiting = null;
    }
    for (const span of el.querySelectorAll('[data-since]')) {
      span.textContent = `${duration(Date.now() - Number(span.dataset.since))} ago`;
    }
  }, 5000);
}
