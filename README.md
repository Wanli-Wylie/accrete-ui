# accrete-ui

A local web page for watching an ACCRETE Workspace, with a real terminal on the left and read-only panels on the right. The only way anything gets written is by someone typing in that terminal.

## Run it

```
npm install
node bin/accrete-ui.mjs [--project PATH] [--no-open] [--no-tmux] [--port N]
```

Without `--project` it uses the nearest ancestor holding `.accrete/project.toml`. It prints a URL and opens it. Treat the URL like a password: this server is a shell.

## Terminal

The terminal runs `tmux -L accrete new -A -s accrete-<name>-<hash>` at the Workspace root, so the session survives a reload or a server restart. `-L accrete` is a tmux server of its own, so your own tmux sessions and settings are left alone. The hash comes from the Workspace's path, which keeps two Workspaces with the same name apart. At startup the server prints the exact command for attaching from any other terminal: `tmux -L accrete attach -t accrete-<name>-<hash>`. Without tmux, or with `--no-tmux`, it is a plain shell that lives as long as the server. Type `claude` or `codex` yourself.

- Shift+Enter is a newline in both agents. Enter still submits.
- Scroll with the wheel. In a shell under tmux that enters tmux's copy mode; scroll back down or press `q` to leave it. Programs with their own full screen, such as `less`, scroll themselves.
- Drag to copy under tmux; the text goes to your clipboard when you let go. Option+drag selects in the browser instead, then Cmd+C.
- When a second tmux client is attached, the window takes the size of whichever client was used last. The other sees it clipped or dotted until you type there again.

Output pauses while the page is behind, so a program that floods the terminal waits for the page instead of filling the server's memory.

The tmux options are all on the server's command line (`server/terminal.mjs`). No `tmux.conf` is needed. Set `ACCRETE_UI_TMUX_SOCKET=name` to use a different tmux server, as the tests do.

## How a panel gets its data

Each of the four panels is two files, and both are already registered, so a panel can be built without touching anything shared.

`server/readers/<panel>.mjs` runs once when the server starts:

```js
export function start({ root, emit }) {
  // root is the Workspace path. Read files, run the Kernel, watch for changes.
  emit('objects', { items: [] });
}
```

`emit(event, data)` sends a named event to every open page. The last value of each event name is replayed to a page that connects later, so emit whole state, not deltas. Name events `<panel>` or `<panel>.<thing>`.

For something too large to broadcast, such as one whole document, a reader can also export `read(rest)`. A page then fetches `/data/<panel>/<rest>` and gets back whatever `read` returns as JSON, or a 404 for `undefined`. `read` only reads, and it treats `rest` as untrusted.

`server/workspace.mjs` exports `resolveWorkspace(root)`, which gives a Workspace's paths and local state from its own Kernel.

`page/panels/<panel>.js` runs once when the page loads:

```js
export function mount(el, events) {
  events.addEventListener('objects', (event) => {
    render(el, JSON.parse(event.data));
  });
}
```

`el` is the panel's own `<section>` and `events` is the page's one `EventSource`. Add listeners inside `mount`, not later, or the replay will be missed. Panel styles go in `page/panels/<panel>.css`, scoped under `#panel-<panel>`; `page/style.css` defines colour variables to use. Put tests in `test/<panel>.test.mjs`.

## Security

From the first request: a random 256-bit token in the URL fragment, traded for an HttpOnly SameSite=Strict cookie; every route and the WebSocket need the cookie; a Host allowlist; an Origin check on the WebSocket and on the token exchange; bound to 127.0.0.1 only. A browser with no cookie gets a 401 whose body is the small script that makes the exchange. The token is printed once and never logged again.

## Bundling

This repository ships inside the npm package `accrete-kit`, as `npx accrete-kit@latest ui`; there is no separate npm package.

Runtime dependencies are reached only through `server/deps.mjs`. `npm run build` copies what runs into `vendor/`, in the same shape as `node_modules/`, so the server needs no `node_modules` at all. It writes `dist/accrete-ui-<version>/` with `bin/`, `server/`, `page/`, `vendor/`, `LICENSE` and `THIRD-PARTY-NOTICES`, then `dist/accrete-ui-<version>.tar.gz` and `dist/SHA256SUMS`. A new runtime dependency needs a line in `scripts/build.mjs` saying what to keep of it.

A version tag runs `.github/workflows/release.yml`, which publishes those two files as a GitHub Release. `accrete.ui` in `accrete-kit`'s `package.json` names the release it embeds, so this release comes first.

## Test

`npm test` needs no browser. It uses a private tmux socket and never touches your own tmux server.
