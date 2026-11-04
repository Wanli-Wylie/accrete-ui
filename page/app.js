import { startTerminal } from '/terminal.js';

const PANELS = ['objects', 'activity', 'agents', 'running'];

if (location.hash) history.replaceState(null, '', '/');

startTerminal(document.getElementById('terminal'));

const tabs = document.getElementById('tabs');
const panels = document.getElementById('panels');

function select(name) {
  for (const button of tabs.children) button.setAttribute('aria-selected', button.dataset.panel === name);
  for (const section of panels.children) section.hidden = section.id !== `panel-${name}`;
}

const sections = PANELS.map((name) => {
  const button = document.createElement('button');
  button.role = 'tab';
  button.dataset.panel = name;
  button.textContent = name[0].toUpperCase() + name.slice(1);
  button.onclick = () => select(name);
  tabs.append(button);

  const section = document.createElement('section');
  section.id = `panel-${name}`;
  panels.append(section);

  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = `/panels/${name}.css`;
  document.head.append(style);
  return section;
});
select(PANELS[0]);

// Imported one by one so a broken panel leaves the others and the terminal running.
const modules = await Promise.allSettled(PANELS.map((name) => import(`/panels/${name}.js`)));

// Open the stream only now and mount in the same tick, so no panel misses the
// latest values the server replays on connect.
const events = new EventSource('/events');
events.addEventListener('workspace', (event) => {
  document.title = `${JSON.parse(event.data).name} - accrete-ui`;
});
modules.forEach((result, i) => {
  if (result.status === 'fulfilled') result.value.mount(sections[i], events);
  else console.error(`panel ${PANELS[i]} failed to load`, result.reason);
});
