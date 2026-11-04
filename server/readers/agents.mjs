// Agent sessions for this Workspace, from transcripts, session files and the process table.
import { homedir } from 'node:os';
import { createSessionIndex } from '../agent-sessions.mjs';
import { agentOf, listProcesses, openFiles, workingDirectories } from '../processes.mjs';
import { readScope } from '../scope.mjs';

const POLL_MS = 5000;
const SCOPE_MS = 30000;
const PS_SHARE_MS = 4500; // the running panel reads the same table every 4 s

export async function snapshot(index, scope) {
  const table = await listProcesses({ maxAgeMs: PS_SHARE_MS });
  const agents = table.filter((row) => agentOf(row.command));
  const [cwds, open] = await Promise.all([
    workingDirectories(agents.map((row) => row.pid)),
    openFiles(agents.filter((row) => agentOf(row.command) === 'codex').map((row) => row.pid)),
  ]);
  return { ...(await index.update({ scope, table, cwds, open })), home: homedir() };
}

export function start({ root, emit }) {
  emit('agents', { root, scope: [root], sessions: [], unattached: [], loading: true, home: homedir() });
  const index = createSessionIndex();
  let scope = [root];
  let scopeAt = 0;
  let last = null;

  async function poll() {
    try {
      if (Date.now() - scopeAt > SCOPE_MS) {
        scope = await readScope(root);
        scopeAt = Date.now();
      }
      const state = JSON.stringify(await snapshot(index, scope));
      if (state !== last) {
        last = state;
        emit('agents', JSON.parse(state));
      }
    } catch (err) {
      console.error(`accrete-ui: agents poll failed: ${err.message}`);
    }
    setTimeout(poll, POLL_MS).unref();
  }
  poll();
}
