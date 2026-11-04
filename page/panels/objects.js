// The objects panel: browse the types, open a whole document, follow its relations.
// Workspace text is untrusted, so everything goes in through text nodes.
const TYPES = [
  ['model', 'Models', 'Model'],
  ['iteration', 'Iterations', 'Iteration'],
  ['tool', 'Tools', 'Tool'],
  ['data', 'Data', 'Data'],
  ['result', 'Results', 'Result'],
  ['memory', 'Memory', 'Memory'],
];
const SINGULAR = Object.fromEntries(TYPES.map(([kind, , one]) => [kind, one]));
const labelOf = (kind) => TYPES.find(([type]) => type === kind)?.[1];
const PAGE = 100;
const RELATION_PAGE = 50;
const REFRESH = '.accrete/bin/accrete index refresh';

function h(tag, props, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

function when(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const time = date.toLocaleTimeString([], { hour12: false });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString('en-CA')} ${time.slice(0, 5)}`;
}

const shortRevision = (revision) => (revision.length > 12 ? revision.slice(0, 8) : revision);

async function fetchData(rest) {
  const response = await fetch(`/data/objects/${rest}`);
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

export function mount(el, events) {
  const types = h('div', { className: 'types' });
  const notice = h('div', { className: 'notice' });
  const body = h('div', { className: 'body' });
  el.replaceChildren(h('div', { className: 'head' }, types, notice), body);

  let state = null;
  let view = null; // { type: 'list', kind, items, total } or { type: 'object', id, data }
  let back = []; // Views to return to, each with its scroll position.
  let token = 0; // Only the latest request may draw.

  function renderTypes() {
    types.replaceChildren(
      ...TYPES.map(([kind, label]) =>
        h(
          'button',
          {
            className: view?.kind === kind && view.type === 'list' ? 'type current' : 'type',
            onclick: () => {
              back = [];
              showList(kind);
            },
          },
          label,
          ' ',
          h('span', { className: 'count', textContent: state?.counts[kind] ?? 0 }),
        ),
      ),
    );
  }

  function samples(group, label) {
    if (!group.count) return [];
    const more = group.count > group.sample.length ? ` and ${group.count - group.sample.length} more` : '';
    return [h('div', { className: 'sample', textContent: `${label}: ${group.sample.join(', ')}${more}` })];
  }

  function renderNotice() {
    const parts = [];
    if (state.install) {
      parts.push(
        h('div', {}, 'No Kernel on this host. Documents list and open. Run ', h('code', { textContent: state.install }), ' in the terminal.'),
        state.kernel_error ? h('div', { className: 'sample', textContent: state.kernel_error }) : null,
      );
    }
    const index = state.index;
    if (index.error) {
      parts.push(h('div', {}, 'Could not read the index: ', index.error));
    } else if (!index.present) {
      if (!state.install) {
        parts.push(h('div', {}, 'No index on this host. Documents list and open. Relations appear after ', h('code', { textContent: REFRESH }), ' in the terminal.'));
      }
    } else {
      const behind = index.changed.count + index.missing.count + index.gone.count;
      if (behind) {
        const counts = [
          index.changed.count && `${index.changed.count} changed since`,
          index.missing.count && `${index.missing.count} not in it`,
          index.gone.count && `${index.gone.count} in it but gone from disk`,
        ].filter(Boolean);
        parts.push(
          h(
            'div',
            { className: 'behind' },
            h('div', {}, `The index is behind the documents: ${counts.join(', ')}. Relations may be out of date. Run `, h('code', { textContent: REFRESH }), ' in the terminal.'),
            ...samples(index.changed, 'Changed'),
            ...samples(index.missing, 'Not in the index'),
            ...samples(index.gone, 'Gone from disk'),
          ),
        );
      }
      parts.push(h('div', { className: 'refreshed', textContent: `Index refreshed ${when(index.refreshed_at)}, ${index.object_count} objects` }));
    }
    notice.replaceChildren(...parts);
  }

  function row(item) {
    return h(
      'button',
      { className: 'row', onclick: () => openObject(item.id) },
      h('span', { className: 'primary', textContent: item.name ?? item.id }),
      item.name && item.name !== item.id ? h('span', { className: 'id', textContent: item.id }) : null,
      item.problem ? h('span', { className: 'tag', textContent: item.problem }) : null,
      item.status ? h('span', { className: 'status', textContent: item.status }) : null,
      item.time ? h('span', { className: 'time', textContent: when(item.time) }) : null,
    );
  }

  function renderList() {
    const nodes = view.items.length
      ? [h('div', { className: 'rows' }, ...view.items.map(row))]
      : [h('div', { className: 'empty', textContent: `No ${labelOf(view.kind)} in this Workspace.` })];
    const left = view.total - view.items.length;
    if (left > 0) nodes.push(h('button', { className: 'more', textContent: `${left} more`, onclick: loadMore }));
    body.replaceChildren(...nodes);
  }

  async function loadMore() {
    const mine = ++token;
    const page = await fetchData(`list/${view.kind}/${view.items.length}/${PAGE}`);
    if (mine !== token) return;
    view.items.push(...page.items);
    view.total = page.total;
    renderList();
  }

  async function showList(kind) {
    view = { type: 'list', kind, items: [], total: 0 };
    renderTypes();
    await refresh();
    el.scrollTop = 0;
  }

  function relationRow(relation) {
    const facts = [
      relation.direction,
      relation.role,
      relation.commit ? `commit ${shortRevision(relation.commit)}` : null,
      relation.revision ? `${relation.kind === 'tool' || relation.section === 'Results' ? 'revision' : 'starts at'} ${shortRevision(relation.revision)}` : null,
    ].filter(Boolean);
    const notes = [];
    if (relation.id === null) notes.push(h('span', { className: 'detail', textContent: relation.detail ?? '' }));
    if (!relation.present && relation.id !== null) notes.push(h('span', { className: 'tag', textContent: 'not present here' }));
    if (relation.commit_available === false) notes.push(h('span', { className: 'tag', textContent: 'commit not present here' }));
    if (relation.commit_available === null) notes.push(h('span', { className: 'tag', textContent: 'no checkout here' }));
    const title = [relation.commit, relation.revision].filter(Boolean).join(' ');
    const content = [
      h('span', { className: 'primary', textContent: relation.name ?? relation.id ?? '(no id)' }),
      relation.name && relation.name !== relation.id ? h('span', { className: 'id', textContent: relation.id }) : null,
      facts.length ? h('span', { className: 'facts', textContent: facts.join(' · '), title }) : null,
      ...notes,
    ];
    if (relation.id === null) return h('div', { className: 'row plain' }, ...content);
    return h('button', { className: relation.present ? 'row' : 'row absent', onclick: () => openObject(relation.id) }, ...content);
  }

  function relationSections(relations) {
    const sections = new Map();
    for (const relation of relations) {
      if (!sections.has(relation.section)) sections.set(relation.section, []);
      sections.get(relation.section).push(relation);
    }
    return [...sections].map(([section, rows]) => {
      const list = h('div', { className: 'rows' });
      const node = h('div', { className: 'relation' }, h('h3', { textContent: section }), list);
      let shown = 0;
      const more = h('button', { className: 'more' });
      const showMore = () => {
        const next = rows.slice(shown, shown + RELATION_PAGE);
        list.append(...next.map(relationRow));
        shown += next.length;
        more.textContent = `${rows.length - shown} more`;
        if (shown >= rows.length) more.remove();
      };
      more.onclick = showMore;
      node.append(more);
      showMore();
      return node;
    });
  }

  function renderRelations(data) {
    if (data.relations_error) return [h('div', { className: 'empty', textContent: `Could not read relations from the index: ${data.relations_error}` })];
    if (!data.relations) return [h('div', { className: 'empty', textContent: 'Relations come from the index, which is not on this host.' })];
    if (!data.relations.length) return [h('div', { className: 'empty', textContent: 'No relations in the index.' })];
    return relationSections(data.relations);
  }

  function renderObject() {
    const { data, id } = view;
    const previous = back.at(-1);
    const backTo = previous?.type === 'object' ? previous.data?.name ?? previous.id : labelOf(previous?.kind ?? data.kind) ?? 'Objects';
    const backButton = h('button', { className: 'back', textContent: `← ${backTo}`, onclick: goBack });
    if (!data.present) {
      body.replaceChildren(
        backButton,
        h('h2', { textContent: id }),
        h('div', { className: 'meta', textContent: 'Not present on this host. Other objects name it, and it may exist elsewhere.' }),
        ...renderRelations(data),
      );
      return;
    }
    const times = [
      data.created_at && `created ${when(data.created_at)}`,
      data.updated_at && `updated ${when(data.updated_at)}`,
      data.authored_at && `authored ${when(data.authored_at)}`,
    ].filter(Boolean);
    const meta = [
      h('div', { className: 'meta', textContent: [data.id, data.status].filter(Boolean).join(' · ') }),
      h('div', { className: 'meta', textContent: data.rel }),
      h('div', { className: 'meta', title: data.revision, textContent: [`revision ${shortRevision(data.revision)}`, ...times].join(' · ') }),
    ];
    for (const [key, value] of Object.entries(data.binding ?? {})) {
      meta.push(h('div', { className: 'meta', textContent: `${key} on this host: ${typeof value === 'string' ? value : JSON.stringify(value)}` }));
    }
    if (data.kind === 'model' && !data.binding) meta.push(h('div', { className: 'meta', textContent: 'No checkout bound on this host.' }));
    if (data.problem) meta.push(h('div', { className: 'behind', textContent: `This document: ${data.problem}.` }));
    if (data.in_index === false) {
      meta.push(h('div', { className: 'behind', textContent: 'This document is not in the index.' }));
    } else if (data.in_index && data.index_revision !== data.revision) {
      meta.push(h('div', { className: 'behind', textContent: `The index has revision ${shortRevision(data.index_revision)} of this document.` }));
    }
    body.replaceChildren(
      backButton,
      h('h2', {}, h('span', { className: 'kind', textContent: SINGULAR[data.kind] }), ' ', data.name ?? data.id),
      ...meta,
      ...renderRelations(data),
      h('div', { className: 'relation' }, h('h3', { textContent: 'Document' }), h('pre', { className: 'document', textContent: data.text })),
    );
  }

  function remember() {
    if (view) back.push({ ...view, scroll: el.scrollTop });
  }

  async function openObject(id) {
    remember();
    view = { type: 'object', id, data: null };
    renderTypes();
    await refresh();
    el.scrollTop = 0;
  }

  async function goBack() {
    const previous = back.pop();
    if (!previous) return showList(view.data?.kind ?? 'model');
    view = previous;
    renderTypes();
    if (view.type === 'list') renderList();
    else renderObject();
    el.scrollTop = previous.scroll;
    await refresh();
  }

  // Refetch what is on screen, and redraw only if it changed, so scrolling and any
  // text selection survive a change elsewhere in the Workspace.
  async function refresh() {
    const mine = ++token;
    const current = view;
    try {
      if (current.type === 'list') {
        const page = await fetchData(`list/${current.kind}/0/${Math.max(current.items.length, PAGE)}`);
        if (mine !== token) return;
        const same = current.drawn && JSON.stringify(page.items) === JSON.stringify(current.items) && page.total === current.total;
        Object.assign(current, { items: page.items, total: page.total, drawn: true });
        if (!same) renderList();
      } else {
        const data = await fetchData(`object/${encodeURIComponent(current.id)}`);
        if (mine !== token) return;
        const same = current.data && JSON.stringify(data) === JSON.stringify(current.data);
        current.data = data;
        if (!same) renderObject();
      }
    } catch (err) {
      if (mine === token) body.replaceChildren(h('div', { className: 'empty', textContent: `Could not read this from the server: ${err.message}` }));
    }
  }

  events.addEventListener('objects', (event) => {
    state = JSON.parse(event.data);
    if (!view) view = { type: 'list', kind: TYPES.find(([kind]) => state.counts[kind])?.[0] ?? 'model', items: [], total: 0 };
    renderTypes();
    renderNotice();
    refresh();
  });

  // Activity asks for an object here, since the panels are separate modules.
  document.addEventListener('accrete:open-object', (event) => {
    document.querySelector('#tabs [data-panel="objects"]')?.click();
    openObject(event.detail.id);
  });
}
