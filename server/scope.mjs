// Which directories count as "this Workspace": its root, bound Model checkouts,
// and Iteration worktrees. The Kernel keeps worktree bindings in local configuration,
// so `config resolve` reports them; an Iteration document may also name one.
import { readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveWorkspace } from './workspace.mjs';

export async function readScope(root) {
  const workspace = await resolveWorkspace(root);
  const { configuration: config, paths } = workspace;
  const found = [workspace.project_root ?? root];
  for (const model of Object.values(config?.models ?? {})) found.push(model?.checkout);
  for (const iteration of Object.values(config?.iterations ?? {})) found.push(iteration?.worktree);

  const iterations = join(paths?.metadata ?? join(root, '.accrete/objects'), 'iterations');
  const names = await readdir(iterations).catch(() => []);
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      found.push(JSON.parse(await readFile(join(iterations, name), 'utf8')).worktree);
    } catch {
      // A document being replaced or not valid JSON names no worktree for now.
    }
  }

  const scope = new Set();
  for (const path of found) {
    if (typeof path !== 'string' || !path.startsWith('/')) continue;
    scope.add(path.replace(/\/+$/, ''));
    scope.add(await realpath(path).catch(() => path));
  }
  return [...scope];
}

export function inScope(scope, path) {
  return typeof path === 'string' && scope.some((dir) => path === dir || path.startsWith(`${dir}/`));
}
