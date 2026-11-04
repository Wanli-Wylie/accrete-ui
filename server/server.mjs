import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.mjs';
import { depsDir, loadDep } from './deps.mjs';
import { emit, serveEvents } from './events.mjs';
import { createTerminal } from './terminal.mjs';
import * as objects from './readers/objects.mjs';
import * as activity from './readers/activity.mjs';
import * as agents from './readers/agents.mjs';
import * as running from './readers/running.mjs';

const { WebSocketServer } = loadDep('ws');

const readers = { objects, activity, agents, running };
const pageDir = fileURLToPath(new URL('../page/', import.meta.url));

// Served as /vendor/<key> so the page never needs to know where packages live.
const vendorFiles = {
  'xterm.mjs': '@xterm/xterm/lib/xterm.mjs',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.mjs': '@xterm/addon-fit/lib/addon-fit.mjs',
  'addon-webgl.mjs': '@xterm/addon-webgl/lib/addon-webgl.mjs',
  'addon-unicode11.mjs': '@xterm/addon-unicode11/lib/addon-unicode11.mjs',
};

const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };

const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

// What a browser gets without the cookie: a refusal that can also trade the
// token in the URL fragment for the cookie. It carries no secret and loads nothing.
const loginPage = `<!doctype html><meta charset="utf-8"><title>accrete-ui</title><body style="font:14px system-ui;padding:2em"><script>
const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);
fetch('/auth', { method: 'POST', body: token ?? '' }).then((r) => {
  if (r.ok) location.replace('/');
  else document.body.textContent = 'Open the URL that accrete-ui printed when it started.';
});
</script>`;

function workspaceName(root) {
  const toml = readFileSync(join(root, '.accrete/project.toml'), 'utf8');
  return toml.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? basename(root);
}

function refuse(res, status) {
  res.writeHead(status, { ...headers, 'Content-Type': 'text/plain' });
  res.end(`${status}\n`);
}

async function serveFile(res, file) {
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...headers, 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    refuse(res, 404);
  }
}

// /data/<panel>/<rest> asks that panel's reader for something too large to broadcast.
async function serveData(res, panel, rest) {
  try {
    const value = await (Object.hasOwn(readers, panel) ? readers[panel].read?.(rest) : undefined);
    if (value === undefined) return refuse(res, 404);
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  } catch (err) {
    console.error(`accrete-ui: ${panel} read failed: ${err.message}`);
    refuse(res, 500);
  }
}

async function exchangeToken(req, res, auth) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 256) break;
  }
  if (!auth.isToken(body)) return refuse(res, 401);
  res.writeHead(204, { ...headers, 'Set-Cookie': auth.setCookie });
  res.end();
}

export async function startServer({ root, port, tmux, tmuxSocket }) {
  const name = workspaceName(root);
  const server = createServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const actualPort = server.address().port;
  const auth = createAuth(actualPort);

  server.on('request', (req, res) => {
    if (!auth.hostOk(req)) return refuse(res, 403);

    const path = new URL(req.url, 'http://local').pathname;
    if (path === '/auth' && req.method === 'POST') {
      if (!auth.originOk(req)) return refuse(res, 403);
      return exchangeToken(req, res, auth);
    }
    if (!auth.hasCookie(req)) {
      if (path !== '/') return refuse(res, 401);
      res.writeHead(401, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Content-Security-Policy': "frame-ancestors 'none'" });
      return res.end(loginPage);
    }
    if (req.method !== 'GET') return refuse(res, 405);

    if (path === '/events') return serveEvents(req, res);
    if (path.startsWith('/data/')) {
      const [panel, ...rest] = path.slice('/data/'.length).split('/');
      let decoded;
      try {
        decoded = rest.map(decodeURIComponent).join('/');
      } catch {
        return refuse(res, 400);
      }
      return serveData(res, panel, decoded);
    }
    if (path === '/') return serveFile(res, join(pageDir, 'index.html'));
    if (path.startsWith('/vendor/')) {
      const file = vendorFiles[path.slice('/vendor/'.length)];
      return file ? serveFile(res, join(depsDir, file)) : refuse(res, 404);
    }
    return serveFile(res, join(pageDir, path)); // URL parsing has already removed any ..
  });

  const { connect, session } = createTerminal({ root, name, tmux, tmuxSocket });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url, 'http://local').pathname;
    if (path !== '/terminal' || !auth.hostOk(req) || !auth.originOk(req) || !auth.hasCookie(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, connect);
  });

  emit('workspace', { name, root });
  for (const [panel, reader] of Object.entries(readers)) {
    Promise.resolve()
      .then(() => reader.start({ root, emit }))
      .catch((err) => console.error(`accrete-ui: ${panel} reader failed: ${err.message}`));
  }

  return { url: `http://127.0.0.1:${actualPort}/#token=${auth.token}`, session };
}
