import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebglAddon } from '/vendor/addon-webgl.mjs';
import { Unicode11Addon } from '/vendor/addon-unicode11.mjs';

// OSC 52: programs and tmux set the clipboard this way. Writing only; never reads.
function writeClipboard(data) {
  const base64 = data.split(';')[1];
  if (base64 && base64 !== '?') {
    const text = new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    navigator.clipboard.writeText(text).catch(() => {});
  }
  return true;
}

export function startTerminal(el) {
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, monospace',
    fontSize: 13,
    scrollback: 10000,
    macOptionClickForcesSelection: true, // Option+drag selects in the browser even when a program holds the mouse
    allowProposedApi: true, // for unicode11
    theme: { background: '#101114' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11'; // the default table makes emoji one cell wide, which tmux and agents do not
  term.parser.registerOscHandler(52, writeClipboard);
  term.open(el);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // The DOM renderer takes over.
  }
  fit.fit();
  window.term = term; // a handle for the browser console

  const ws = new WebSocket(`ws://${location.host}/terminal`);
  ws.binaryType = 'arraybuffer';
  const send = (data) => ws.readyState === WebSocket.OPEN && ws.send(data);
  const sendSize = () => send(JSON.stringify({ cols: term.cols, rows: term.rows }));

  const encoder = new TextEncoder();
  term.onData((data) => send(encoder.encode(data)));
  term.onBinary((data) => send(Uint8Array.from(data, (c) => c.charCodeAt(0))));
  term.onResize(sendSize);

  // xterm sends a bare CR for Shift+Enter, the same as Enter, which submits in an
  // agent. ESC CR is what Claude Code and Codex both take as a newline, in or out of tmux.
  term.attachCustomKeyEventHandler((event) => {
    if (event.key !== 'Enter' || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return true;
    event.preventDefault();
    if (event.type === 'keydown') send(encoder.encode('\x1b\r'));
    return false;
  });

  // Tell the server what xterm has parsed, so it can pause the PTY while this page is behind.
  let parsed = 0;
  const writeOutput = (bytes) => {
    term.write(bytes, () => {
      parsed += bytes.length;
      if (parsed < 32 * 1024) return;
      send(JSON.stringify({ ack: parsed }));
      parsed = 0;
    });
  };

  ws.onopen = sendSize;
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      // Replayed output. Any terminal queries in it were answered the first time,
      // so xterm's automatic replies must not reach the shell again.
      term.options.disableStdin = true;
      term.write(event.data, () => {
        term.options.disableStdin = false;
      });
    } else {
      writeOutput(new Uint8Array(event.data));
    }
  };
  ws.onclose = () => term.write('\r\n\x1b[2m[disconnected; reload to reattach]\x1b[0m\r\n');

  new ResizeObserver(() => fit.fit()).observe(el);
  term.focus();
}
