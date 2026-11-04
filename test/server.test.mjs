import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const bin = fileURLToPath(new URL('../bin/accrete-ui.mjs', import.meta.url));
const tmuxSocket = `accrete-test-${process.pid}`;
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const tempDirs = [];

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'accrete-ui-test-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, '.accrete'));
  writeFileSync(join(dir, '.accrete/project.toml'), 'name = "test"\n');
  return dir;
}

const workspace = makeWorkspace();
const servers = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const value = await check();
    if (value) return value;
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function startServer(args = [], env = {}) {
  const child = spawn(process.execPath, [bin, '--project', workspace, '--no-open', ...args], {
    env: { ...process.env, ACCRETE_UI_TMUX_SOCKET: tmuxSocket, ...env },
  });
  servers.push(child);
  let errors = '';
  child.stderr.on('data', (chunk) => (errors += chunk));
  let out = '';
  for await (const chunk of child.stdout) {
    out += chunk;
    if (out.includes('\n')) break;
  }
  const url = new URL(out.trim());
  return { port: url.port, token: url.hash.slice('#token='.length), stderr: () => errors };
}

// node:http rather than fetch, because fetch will not let us set Host.
function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      res.setEncoding('utf8');
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function login(server) {
  const res = await request(server.port, {
    method: 'POST',
    path: '/auth',
    headers: { Origin: `http://127.0.0.1:${server.port}` },
    body: server.token,
  });
  assert.equal(res.status, 204);
  return res.headers['set-cookie'][0];
}

const attachCommand = (srv) => until(() => srv.stderr().match(/tmux -L (\S+) attach -t (\S+)/), 'the attach command');

// A terminal connection for tests that drive tmux or the PTY directly.
async function openTerminal(srv) {
  const pair = (await login(srv)).split(';')[0];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/terminal`, {
      headers: { Origin: `http://127.0.0.1:${srv.port}`, Cookie: pair },
    });
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify({ cols: 80, rows: 24 }));
      resolve(ws);
    });
  });
}

const type = (ws, text) => ws.send(Buffer.from(text), { binary: true });

// Resolves with the status of a refused upgrade, or 101 when it is accepted.
function tryUpgrade(port, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal`, { headers });
    ws.on('open', () => {
      ws.terminate();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      resolve(res.statusCode);
    });
    ws.on('error', () => resolve('error'));
  });
}

function terminalRoundTrip(server, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/terminal`, {
      headers: { Origin: `http://127.0.0.1:${server.port}`, Cookie: cookie },
    });
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`no echo in terminal output: ${JSON.stringify(seen.slice(-400))}`)), 20000);
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify({ cols: 80, rows: 24 }));
      // The sum only exists if a real shell ran it; the typed text alone cannot match.
      setTimeout(() => ws.send(Buffer.from('echo round-$((40+2))\r'), { binary: true }), 1000);
    });
    ws.on('message', (data, isBinary) => {
      assert.ok(isBinary);
      seen += data.toString();
      if (seen.includes('round-42')) {
        clearTimeout(timer);
        ws.terminate();
        resolve();
      }
    });
  });
}

let server;
let cookie;

before(async () => {
  server = await startServer(['--no-tmux']);
  cookie = await login(server);
});

after(() => {
  for (const child of servers) child.kill('SIGKILL');
  spawnSync('tmux', ['-L', tmuxSocket, 'kill-server']);
  rmSync(join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid()}`, tmuxSocket), { force: true });
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test('exits with a clear message outside a Workspace', () => {
  const outside = mkdtempSync(join(tmpdir(), 'accrete-ui-none-'));
  const res = spawnSync(process.execPath, [bin, '--no-open'], { cwd: outside, encoding: 'utf8' });
  rmSync(outside, { recursive: true });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no ACCRETE Workspace/);
});

test('without the cookie every route is refused', async () => {
  for (const path of ['/', '/app.js', '/terminal.js', '/events', '/vendor/xterm.mjs', '/panels/objects.js']) {
    assert.equal((await request(server.port, { path })).status, 401, path);
  }
  assert.equal(await tryUpgrade(server.port, { Origin: `http://127.0.0.1:${server.port}` }), 403);
});

test('the refusal at / carries no secret', async () => {
  const res = await request(server.port);
  assert.equal(res.status, 401);
  assert.ok(!res.text.includes(server.token));
});

test('a wrong token gets no cookie', async () => {
  const res = await request(server.port, {
    method: 'POST',
    path: '/auth',
    headers: { Origin: `http://127.0.0.1:${server.port}` },
    body: 'f'.repeat(64),
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('the cookie is HttpOnly and SameSite=Strict, and it opens the page', async () => {
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const pair = cookie.split(';')[0];
  assert.equal((await request(server.port, { headers: { Cookie: pair } })).status, 200);
  assert.equal((await request(server.port, { path: '/vendor/xterm.mjs', headers: { Cookie: pair } })).status, 200);
});

test('localhost works as well as 127.0.0.1', async () => {
  const host = `localhost:${server.port}`;
  const pair = cookie.split(';')[0];
  assert.equal((await request(server.port, { headers: { Host: host, Cookie: pair } })).status, 200);
  const res = await request(server.port, {
    method: 'POST',
    path: '/auth',
    headers: { Host: host, Origin: `http://${host}` },
    body: server.token,
  });
  assert.equal(res.status, 204);
});

test('a wrong Host is refused even with the cookie', async () => {
  const headers = { Cookie: cookie.split(';')[0] };
  for (const host of ['evil.example', `evil.example:${server.port}`, '127.0.0.1', `127.0.0.1:${Number(server.port) + 1}`]) {
    assert.equal((await request(server.port, { headers: { ...headers, Host: host } })).status, 403, host);
  }
  const socketStatus = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/terminal`, {
      headers: { ...headers, Host: 'evil.example', Origin: `http://127.0.0.1:${server.port}` },
    });
    ws.on('open', () => resolve(101));
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
  });
  assert.equal(socketStatus, 403);
});

test('a wrong or missing Origin is refused on the WebSocket and on /auth', async () => {
  const pair = cookie.split(';')[0];
  assert.equal(await tryUpgrade(server.port, { Cookie: pair, Origin: 'http://evil.example' }), 403);
  assert.equal(await tryUpgrade(server.port, { Cookie: pair, Origin: `http://127.0.0.1:${Number(server.port) + 1}` }), 403);
  assert.equal(await tryUpgrade(server.port, { Cookie: pair }), 403);
  for (const headers of [{ Origin: 'http://evil.example' }, {}]) {
    const res = await request(server.port, { method: 'POST', path: '/auth', headers, body: server.token });
    assert.equal(res.status, 403);
  }
});

test('the event stream delivers each reader\'s named event to a page that connects later', async () => {
  const pair = cookie.split(';')[0];
  const text = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, path: '/events', headers: { Host: `127.0.0.1:${server.port}`, Cookie: pair } }, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream');
      let seen = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        seen += chunk;
        if (['objects', 'activity', 'agents', 'running'].every((name) => seen.includes(`event: ${name}\n`))) {
          req.destroy();
          resolve(seen);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
  assert.match(text, /event: workspace\n/);
});

test('terminal round trip, plain shell', async () => {
  await terminalRoundTrip(server, cookie.split(';')[0]);
});

test('terminal round trip, with no tmux on the PATH', async () => {
  const noTmux = await startServer(['--project', makeWorkspace()], { PATH: '/usr/bin:/bin' });
  await terminalRoundTrip(noTmux, (await login(noTmux)).split(';')[0]);
  assert.doesNotMatch(noTmux.stderr(), /attach/);
});

test('terminal round trip, tmux on a private socket, started from inside another tmux', { skip: !hasTmux }, async () => {
  const withTmux = await startServer([], { TMUX: '/tmp/not-a-socket,1,0' });
  await terminalRoundTrip(withTmux, (await login(withTmux)).split(';')[0]);
  const [, socket, session] = await attachCommand(withTmux);
  assert.equal(socket, tmuxSocket);
  assert.equal(spawnSync('tmux', ['-L', socket, 'has-session', '-t', `=${session}`]).status, 0);
});

test('tmux defaults to a server of its own, and the attach command says so', { skip: !hasTmux }, async () => {
  // A short path, because the socket lives under it. This keeps the test off the real accrete server.
  const dir = mkdtempSync('/tmp/accrete-ui-');
  tempDirs.push(dir);
  const env = { ...process.env, TMUX_TMPDIR: dir };
  try {
    const srv = await startServer([], { ACCRETE_UI_TMUX_SOCKET: undefined, TMUX_TMPDIR: dir });
    const [, socket, session] = await attachCommand(srv);
    assert.equal(socket, 'accrete');
    const ws = await openTerminal(srv);
    await until(() => spawnSync('tmux', ['-L', 'accrete', 'has-session', '-t', `=${session}`], { env }).status === 0, 'the session');
    ws.terminate();
  } finally {
    spawnSync('tmux', ['-L', 'accrete', 'kill-server'], { env });
  }
});

test('two Workspaces with the same name get separate sessions, however the path is written', { skip: !hasTmux }, async () => {
  const session = async (...args) => (await attachCommand(await startServer(args)))[2];
  const first = await session();
  assert.match(first, /^accrete-test-[0-9a-f]{6}$/);
  assert.notEqual(await session('--project', makeWorkspace()), first);
  assert.notEqual(realpathSync(workspace), workspace, 'the temp directory should be behind a symlink here');
  assert.equal(await session('--project', realpathSync(workspace)), first);
});

test('output pauses while the page is behind and resumes when it catches up', async () => {
  const srv = await startServer(['--no-tmux', '--project', makeWorkspace()], { SHELL: '/bin/sh' });
  const ws = await openTerminal(srv);
  let received = 0;
  let tail = '';
  let acking = false;
  ws.on('message', (data) => {
    received += data.length;
    tail = (tail + data).slice(-4000); // room for whatever prompt this machine prints after it
    if (acking) ws.send(JSON.stringify({ ack: data.length }));
  });
  type(ws, 'yes flood | head -c 8000000; echo flood-$((40+2))\r');

  await until(() => received > 256 * 1024, 'the flood to start');
  await sleep(500);
  const paused = received;
  assert.ok(paused < 1024 * 1024, `${paused} bytes went out unacknowledged`);
  await sleep(300);
  assert.equal(received, paused);

  acking = true;
  ws.send(JSON.stringify({ ack: received }));
  await until(() => tail.includes('flood-42'), 'the flood to finish', 60000).catch((err) => {
    err.message += ` after ${received} bytes; output ended ${JSON.stringify(tail.slice(-300))}`;
    throw err;
  });
  ws.terminate();
});

test('under tmux the wheel reaches whatever is on the screen', { skip: !hasTmux }, async () => {
  const dir = makeWorkspace();
  const srv = await startServer(['--project', dir]);
  const [, socket, session] = await attachCommand(srv);
  const ws = await openTerminal(srv);
  const pane = (format) => spawnSync('tmux', ['-L', socket, 'display', '-p', '-t', `=${session}:`, format], { encoding: 'utf8' }).stdout.trim();
  const wheelUp = '\x1b[<64;10;10M';
  const wheelDown = '\x1b[<65;10;10M';

  // Writes what it receives to a file, on the alternate screen, optionally asking for the mouse.
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, `
    import { appendFileSync } from 'node:fs';
    const [log, mouse] = process.argv.slice(2);
    process.stdin.setRawMode(true);
    process.stdout.write('\\x1b[?1049h' + (mouse ? '\\x1b[?1000h\\x1b[?1006h' : ''));
    process.stdin.on('data', (data) => {
      if (String(data) === 'q') {
        process.stdout.write((mouse ? '\\x1b[?1000l\\x1b[?1006l' : '') + '\\x1b[?1049l');
        process.exit();
      }
      appendFileSync(log, data);
    });
  `);
  const received = (log, bytes) => existsSync(log) && readFileSync(log, 'latin1').includes(bytes);

  // A plain shell: the wheel enters copy mode. Sent again in case the first beats the mouse setting.
  await until(() => {
    type(ws, wheelUp);
    return pane('#{pane_in_mode}') === '1';
  }, 'copy mode');
  type(ws, 'q');
  await until(() => pane('#{pane_in_mode}') === '0', 'leaving copy mode');

  // The alternate screen with no mouse, like less: the wheel becomes arrow keys.
  const arrows = join(dir, 'arrows.log');
  type(ws, `node ${probe} ${arrows}\r`);
  await until(() => pane('#{alternate_on}') === '1', 'the alternate screen');
  type(ws, wheelDown);
  await until(() => received(arrows, '\x1b[B'.repeat(3)), 'arrow keys for wheel down');
  type(ws, wheelUp);
  await until(() => received(arrows, '\x1b[A'.repeat(3)), 'arrow keys for wheel up');
  type(ws, 'q');
  await until(() => pane('#{alternate_on}') === '0', 'the normal screen');

  // A program that asks for the mouse, as the agents do, still gets the wheel itself.
  const mouse = join(dir, 'mouse.log');
  type(ws, `node ${probe} ${mouse} mouse\r`);
  await until(() => pane('#{mouse_any_flag}') === '1', 'the program to ask for the mouse');
  type(ws, wheelUp);
  await until(() => received(mouse, '\x1b[<64;'), 'the wheel event');
  type(ws, 'q');
  ws.terminate();
});
