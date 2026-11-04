// The PTY behind the page's terminal. Under tmux, each WebSocket gets its own
// tmux client and the session outlives it. Without tmux, one shell lives as long
// as the server and a reconnecting page gets its recent output replayed.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { depsDir, loadDep } from './deps.mjs';

const pty = loadDep('node-pty');

// npm ships spawn-helper as 0644; node-pty fails with posix_spawnp until it is executable.
const helper = join(depsDir, 'node-pty/prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
if (!(statSync(helper).mode & 0o100)) chmodSync(helper, 0o755); // a read-only install already has the bit

function spawn(file, args, { root, cols, rows }) {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  // These describe the terminal the server was launched from, not this one.
  for (const key of ['TMUX', 'TMUX_PANE', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'CLAUDECODE']) delete env[key];
  return pty.spawn(file, args, { name: 'xterm-256color', cwd: root, cols, rows, env, encoding: null });
}

// Everything is set on this command line; no tmux.conf is involved. The tmux server
// is our own, so its global settings touch nothing else. A pane's history limit is
// fixed when the pane is created, so that option comes first.
function tmuxArgs({ session, root, socket }) {
  const mouseHandled = '#{||:#{pane_in_mode},#{mouse_any_flag}}';
  return [
    '-L', socket,
    '-u',
    '-T', 'sync', // tmux's own repaints arrive as one frame
    'set', '-g', 'history-limit', '50000', ';',
    // A program on the alternate screen that ignores the mouse, such as less, gets arrow keys.
    'bind', '-n', 'WheelUpPane', 'if', '-F', mouseHandled, 'send -M', 'if -F "#{alternate_on}" "send -N 3 Up" "copy-mode -e"', ';',
    'bind', '-n', 'WheelDownPane', 'if', '-F', mouseHandled, 'send -M', 'if -F "#{alternate_on}" "send -N 3 Down"', ';',
    'new-session', '-A', '-s', session, '-c', root, ';',
    'set', '-t', session, 'mouse', 'on', ';', // otherwise the browser turns the wheel into arrow keys
    'set', '-t', session, 'status', 'off',
  ];
}

// The hash keeps two Workspaces with the same name in separate sessions.
function sessionName(name, root) {
  const hash = createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 6);
  return `accrete-${name.replace(/[^A-Za-z0-9_-]/g, '-')}-${hash}`;
}

// Sends PTY output to the page, counting bytes until the page says xterm has parsed
// them. That count covers the socket and the browser too. While it is high the PTY
// pauses, so the program writing blocks instead of this process filling up.
const HIGH_BYTES = 256 * 1024;
const LOW_BYTES = 64 * 1024;

function flowTo(ws, term) {
  let behind = 0;
  return {
    send(data) {
      ws.send(data);
      behind += data.length;
      if (behind > HIGH_BYTES) term.pause();
    },
    ack(bytes) {
      behind -= bytes;
      if (behind < LOW_BYTES) term.resume();
    },
  };
}

const REPLAY_BYTES = 256 * 1024;

export function createTerminal({ root, name, tmux, tmuxSocket }) {
  const useTmux = tmux && spawnSync('tmux', ['-V']).status === 0;
  const socket = tmuxSocket || 'accrete';
  const session = sessionName(name, root);
  if (useTmux) console.error(`accrete-ui: to attach from another terminal: tmux -L ${socket} attach -t ${session}`);
  let shell = null; // the plain shell, when not under tmux

  function attachTmux(ws, size) {
    const client = spawn('tmux', tmuxArgs({ session, root, socket }), { root, ...size });
    const output = flowTo(ws, client);
    client.onData(output.send);
    client.onExit(() => ws.close());
    ws.on('close', () => client.kill());
    return { term: client, ack: output.ack };
  }

  function openShell(size) {
    const opened = { pty: spawn(process.env.SHELL || '/bin/zsh', ['-l'], { root, ...size }), replay: Buffer.alloc(0), ws: null, output: null };
    opened.pty.onData((data) => {
      opened.replay = Buffer.concat([opened.replay, data]).subarray(-REPLAY_BYTES);
      opened.output?.send(data);
    });
    opened.pty.onExit(() => {
      opened.ws?.close();
      shell = null;
    });
    return opened;
  }

  function attachShell(ws, size) {
    shell ??= openShell(size);
    const current = shell;
    current.ws?.close();
    current.ws = ws;
    current.output = flowTo(ws, current.pty);
    current.pty.resume(); // the previous page may have left it paused
    if (current.replay.length) ws.send(current.replay.toString()); // a text frame marks it as replay
    current.pty.resize(size.cols, size.rows);
    ws.on('close', () => {
      if (current.ws !== ws) return;
      current.ws = null;
      current.output = null;
      current.pty.resume(); // with no page, output only goes to the bounded replay
    });
    return { term: current.pty, ack: current.output.ack };
  }

  // Binary frames are terminal bytes. A text frame is a resize or an ack; the first resize opens the PTY.
  function connect(ws) {
    let attached = null;
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        attached?.term.write(data);
        return;
      }
      const message = JSON.parse(data);
      if (message.ack) attached?.ack(message.ack);
      else if (attached) attached.term.resize(message.cols, message.rows);
      else attached = useTmux ? attachTmux(ws, message) : attachShell(ws, message);
    });
  }

  return { connect, session };
}
